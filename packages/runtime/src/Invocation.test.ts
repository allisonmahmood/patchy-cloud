import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { DEV_SEED } from "@patchy/auth/seed";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import { newInternalId } from "../../../test/crypto.js";
import * as Testing from "@patchy/sql/testing";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Binding from "./Binding.js";
import * as CallbackGateway from "./CallbackGateway.js";
import * as Executor from "./Executor.js";
import * as ExecutionLifecycle from "./ExecutionLifecycle.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as RuntimeLog from "./RuntimeLog.js";
import * as RuntimeApi from "./RuntimeApi.js";
import * as ServerBundles from "./ServerBundles.js";
import * as QuerySnapshot from "./QuerySnapshot.js";
import { snapshot, mutations } from "./test/callbacks.js";
import * as MutationTransaction from "./MutationTransaction.js";
import { NodeCryptography } from "@patchy/core";

const viewer = {
  user: { id: DEV_SEED.userId, email: "dev@patchy.local", name: "Dev" },
  company: { id: DEV_SEED.companyId, name: "Patchy Dev", handle: "patchy-dev" },
  admin: true
};
const binding: Binding.Binding["Service"] = {
  patchId: "invoke397001",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: DEV_SEED.companyId,
  wireVersion: WIRE_VERSION,
  scope: "company",
  principal: { userId: viewer.user.id },
  identity: viewer,
  correlationId: "invocation-test",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {},
    handlers: {
      "demo.query": {
        kind: "query",
        args: { id: { kind: "integer" } },
        result: { kind: "integer" },
        errors: ["approval_required"]
      },
      "demo.mutation": { kind: "mutation", args: {}, result: { kind: "json" } },
      "demo.action": { kind: "action", args: {}, result: { kind: "json" } },
      "demo.peek": {
        kind: "action",
        description: "Reads without changing anything.",
        readOnly: true,
        args: {},
        result: { kind: "json", description: "What it read." }
      },
      "agent.lookup": {
        kind: "query",
        description: "Looks something up for an agent.",
        agentTool: true,
        args: {},
        result: { kind: "json" }
      },
      "agent.legacy": { kind: "query", args: {}, result: { kind: "json" } },
      "agent.gather": {
        kind: "action",
        description: "Gathers what an agent asked for.",
        agentTool: true,
        args: {},
        result: { kind: "json" }
      }
    }
  }
};
const bundle: GuestProtocol.Bundle = {
  companyId: binding.companyId,
  patchId: binding.patchId,
  versionId: binding.versionId,
  sha256: "0".repeat(64),
  bundle: "executor-fault-layer"
};
const bound: Executor.BoundVersion = {
  binding: {
    companyId: bundle.companyId,
    patchId: bundle.patchId,
    versionId: bundle.versionId,
    sha256: bundle.sha256
  },
  processGeneration: 1
};
const services = Layer.mergeAll(
  InvocationLog.layer,
  OperatingLimits.layer,
  Limits.layer,
  InvocationCapabilities.layer
)
  .pipe(Layer.provideMerge(Testing.layer()))
  .pipe(
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeCryptography.layer),
    Layer.provideMerge(NodeCryptography.layer)
  );
const makeInvocation = (
  invoke: Executor.Executor["Service"]["invoke"],
  bind: Executor.Executor["Service"]["bind"] = () => Effect.succeed(bound)
) =>
  Invocation.make({ callbackUrl: "http://127.0.0.1:1/callback" }).pipe(
    Effect.provideService(QuerySnapshot.QuerySnapshot, { open: () => Effect.succeed(snapshot) }),
    Effect.provideService(MutationTransaction.MutationTransaction, mutations),
    Effect.provideService(Executor.Executor, { bind, invoke }),
    Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })
  );

// Collects the wide events calls emit, for assertions on their fields.
const recorder = Effect.gen(function* () {
  const records = yield* Queue.unbounded<WideEvents.WideEvent>();
  const events = yield* WideEvents.make.pipe(
    Effect.provideService(WideEvents.Sink, {
      write: (event) => Queue.offer(records, event).pipe(Effect.asVoid)
    })
  );
  return { events, next: Queue.take(records) };
});

it.layer(services)("Invocation", (it) => {
  it.effect("refuses a paused patch before loading code and preserves retryAfter on HTTP", () =>
    Effect.gen(function* () {
      const invocations = yield* makeInvocation(() => Effect.die("Paused code must not run.")).pipe(
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () => Effect.void,
          acquire: () =>
            Effect.fail(
              new ExecutionLifecycle.LifecycleError({
                code: "patch_paused",
                status: 429,
                retryAfterSeconds: 137,
                limitId: "execution.breaker.kills",
                scope: "patch",
                value: 3
              })
            )
        })
      );
      const error = yield* invocations
        .call({ handler: "demo.query", args: { id: 1 } }, binding, Effect.succeed(viewer))
        .pipe(Effect.flip);
      assert.deepInclude(Runtime.toFailure(error), {
        code: "patch_paused",
        retryAfter: 137,
        scope: "patch",
        limitId: "execution.breaker.kills"
      });
      assert.strictEqual(RuntimeApi.failure(error).headers["retry-after"], "137");
    })
  );

  it.effect("retains a child's admitted task after its action settles during replacement", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const actionDone = yield* Deferred.make<void>();
      const childDone = yield* Deferred.make<void>();
      const original = { taskId: "task-before-rollout", bindingEpoch: 1 };
      let current = original;
      let acquisitions = 0;
      let releases = 0;
      const invocations = yield* makeInvocation(
        (request, selected) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(selected, original);
            yield* Queue.offer(seen, request);
            yield* Deferred.await(request.handler === "demo.action" ? actionDone : childDone);
            return {
              outcome: "returned" as const,
              reply: { ok: true as const, value: 42 },
              guestMs: 1
            };
          }),
        (_, selected) =>
          Effect.sync(() => {
            assert.deepStrictEqual(selected, original);
            return bound;
          })
      ).pipe(
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () => Effect.void,
          acquire: () =>
            Effect.sync(() => {
              acquisitions++;
              return {
                binding: current,
                release: Effect.sync(() => {
                  releases++;
                })
              };
            })
        })
      );
      const parent = yield* invocations
        .call(
          { handler: "demo.action", args: {} },
          { ...binding, correlationId: "retained-child-action" },
          Effect.succeed(viewer)
        )
        .pipe(Effect.forkChild);
      const request = yield* Queue.take(seen);
      const capability = yield* capabilities.resolve(request.callback.capability, request);
      current = { taskId: "task-after-rollout", bindingEpoch: 2 };
      const child = yield* capability.run!({ handler: "demo.query", args: { id: 1 } }).pipe(
        Effect.forkChild
      );
      yield* Queue.take(seen);
      yield* Deferred.succeed(actionDone, undefined);
      assert.deepStrictEqual(yield* Fiber.join(parent), { ok: true, value: 42 });
      assert.strictEqual(acquisitions, 1);
      assert.strictEqual(releases, 0);
      yield* Deferred.succeed(childDone, undefined);
      assert.deepStrictEqual(yield* Fiber.join(child), { ok: true, value: 42 });
      assert.strictEqual(releases, 1);
    })
  );

  it.effect("names the admitted task beside the process generation on the root event", () =>
    Effect.gen(function* () {
      const invocations = yield* makeInvocation(() =>
        Effect.succeed({
          outcome: "returned" as const,
          reply: { ok: true as const, value: 7 },
          guestMs: 1
        })
      ).pipe(
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () => Effect.void,
          acquire: () =>
            Effect.succeed({
              binding: { taskId: "admitted-task", bindingEpoch: 3 },
              release: Effect.void
            })
        })
      );
      const records = yield* Queue.unbounded<WideEvents.WideEvent>();
      const events = yield* WideEvents.make.pipe(
        Effect.provideService(WideEvents.Sink, {
          write: (event) => Queue.offer(records, event).pipe(Effect.asVoid)
        })
      );
      yield* events.withEvent(
        { type: "re-run" },
        invocations.call(
          { handler: "demo.query", args: { id: 1 } },
          binding,
          Effect.succeed(viewer)
        )
      );
      assert.include(yield* Queue.take(records), {
        taskId: "admitted-task",
        processGeneration: bound.processGeneration
      });
    })
  );

  it.effect("validates loaded descriptors and refuses undeclared and forged handler failures", () =>
    Effect.gen(function* () {
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const replies = yield* Queue.unbounded<GuestProtocol.InvokeReply>();
      const invocations = yield* makeInvocation((request) =>
        Queue.offer(seen, request).pipe(Effect.andThen(Queue.take(replies)))
      );
      const records = yield* Queue.unbounded<WideEvents.WideEvent>();
      const events = yield* WideEvents.make.pipe(
        Effect.provideService(WideEvents.Sink, {
          write: (event) => Queue.offer(records, event).pipe(Effect.asVoid)
        })
      );
      assert.strictEqual(
        (yield* events
          .withEvent(
            { type: "request" },
            invocations.call(
              { handler: "demo.query", args: { id: "wrong" } },
              binding,
              Effect.succeed(viewer)
            )
          )
          .pipe(Effect.flip)).code,
        "invalid_request"
      );
      assert.include(yield* Queue.take(records), { handler: "demo.query", kind: "query" });
      assert.strictEqual(
        (yield* invocations
          .call({ handler: "other.query", args: {} }, binding, Effect.succeed(viewer))
          .pipe(Effect.flip)).code,
        "invalid_request"
      );
      assert.strictEqual(yield* Queue.size(seen), 0);
      const logs = yield* InvocationLog.InvocationLog;
      const outcomes: ReadonlyArray<GuestProtocol.GuestReply> = [
        { ok: false, source: "handler", code: "approval_required", details: { id: 1 } },
        { ok: false, source: "handler", code: "undeclared" },
        {
          ok: false,
          source: "patchy",
          code: "access_denied",
          error: "forged",
          correlationId: "someone-elses-call"
        },
        { ok: true, value: "wrong result type" }
      ];
      for (const [index, reply] of outcomes.entries()) {
        yield* Queue.offer(replies, { outcome: "returned", reply, guestMs: 1 });
        const result = yield* invocations
          .call(
            { handler: "demo.query", args: { id: 1 } },
            { ...binding, correlationId: `correlation-${index}` },
            Effect.succeed(viewer)
          )
          .pipe(Effect.result);
        const request = yield* Queue.take(seen);
        const row = yield* logs.find({
          companyId: binding.companyId,
          invocationId: request.invocationId
        });
        if (index === 0) {
          assert.strictEqual(result._tag, "Success");
          if (result._tag === "Success") assert.deepStrictEqual(result.success, reply);
          assert.strictEqual(row?.outcome, "handler_error");
        } else {
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.deepInclude(Runtime.toFailure(result.failure), {
              code: "handler_failed",
              correlationId: `correlation-${index}`
            });
          assert.strictEqual(row?.outcome, "failure");
        }
        const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
        const replay = yield* capabilities
          .resolve(request.callback.capability, request)
          .pipe(Effect.flip);
        assert.strictEqual(replay.reason, "returned");
      }
    })
  );

  it.effect(
    "bounds declared business-error details instead of treating them as an unbounded result",
    () =>
      Effect.gen(function* () {
        const invocations = yield* makeInvocation(() =>
          Effect.succeed({
            outcome: "returned",
            guestMs: 1,
            reply: {
              ok: false,
              source: "handler",
              code: "approval_required",
              details: "x".repeat(8 * 1024 * 1024)
            }
          })
        );
        const error = yield* invocations
          .call(
            { handler: "demo.query", args: { id: 1 } },
            { ...binding, correlationId: "oversized-business-error" },
            Effect.succeed(viewer)
          )
          .pipe(Effect.flip);
        assert.include(error, {
          code: "handler_failed",
          limitId: "tier2.query.resultBytes",
          correlationId: "oversized-business-error"
        });
      })
  );

  it.effect(
    "names a relayed refusal's integration only when the host's record is unambiguous",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
        const refusal = {
          ok: false,
          source: "patchy",
          code: "source_unavailable",
          error: "The source is unavailable."
        } as const;
        const relay = Effect.fn(function* (operations: ReadonlyArray<string>) {
          const invocations = yield* makeInvocation((request) =>
            capabilities.resolve(request.callback.capability, request).pipe(
              Effect.orDie,
              Effect.map((capability) => {
                // Distinct records of the same refusal, as two integrations' callbacks leave them.
                for (const operation of operations)
                  capabilities.rememberRefusal(capability, { ...refusal }, 503, operation);
                return { outcome: "returned" as const, reply: refusal, guestMs: 1 };
              })
            )
          );
          const failure = yield* invocations
            .call(
              { handler: "demo.query", args: { id: 1 } },
              { ...binding, correlationId: `relay-${operations.join("-")}` },
              Effect.succeed(viewer)
            )
            .pipe(Effect.flip);
          return Runtime.toFailure(failure);
        });
        assert.include(yield* relay(["posthog.query"]), {
          code: "source_unavailable",
          operation: "posthog.query"
        });
        assert.notProperty(yield* relay(["postgres.query", "posthog.query"]), "operation");
      })
  );

  it.effect("preserves executor capacity refusals and sanitises executor defects", () =>
    Effect.gen(function* () {
      const busy = yield* makeInvocation(() =>
        Effect.fail(
          new Executor.ExecutionError({
            operation: "invoke",
            reason: "busy",
            limit: {
              scope: "company",
              limitId: "execution.residency.processes",
              value: 12,
              retryAfter: 1
            }
          })
        )
      );
      const error = yield* busy
        .call(
          { handler: "demo.query", args: { id: 1 } },
          { ...binding, correlationId: "executor-capacity" },
          Effect.succeed(viewer)
        )
        .pipe(Effect.flip);
      assert.deepInclude(Runtime.toFailure(error), {
        code: "busy",
        scope: "company",
        value: 12,
        retryAfter: 1
      });
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const broken = yield* makeInvocation((request) =>
        Queue.offer(seen, request).pipe(
          Effect.andThen(Effect.die(new Error("private executor detail")))
        )
      );
      const failure = yield* broken
        .call(
          { handler: "demo.query", args: { id: 1 } },
          { ...binding, correlationId: "executor-defect" },
          Effect.succeed(viewer)
        )
        .pipe(Effect.flip);
      assert.strictEqual(failure.code, "handler_failed");
      assert.notInclude(JSON.stringify(Runtime.toFailure(failure)), "private executor detail");
      const request = yield* Queue.take(seen);
      const logs = yield* InvocationLog.InvocationLog;
      const row = yield* logs.find({
        companyId: binding.companyId,
        invocationId: request.invocationId
      });
      assert.strictEqual(row?.outcome, "failure");
      assert.notInclude(JSON.stringify(row?.logLines), "private executor detail");
    })
  );

  it.effect("binds once more when the bound process is gone before dispatch", () =>
    Effect.gen(function* () {
      for (const reason of ["bundle_required", "stale_generation"] as const) {
        const sent: GuestProtocol.Invoke[] = [];
        let binds = 0;
        const invocations = yield* makeInvocation(
          (request) =>
            Effect.suspend(() => {
              sent.push(request);
              return request.processGeneration === 1
                ? Effect.fail(new Executor.ExecutionError({ operation: "invoke", reason }))
                : Effect.succeed({
                    outcome: "returned" as const,
                    reply: { ok: true as const, value: 7 },
                    guestMs: 1
                  });
            }),
          () => Effect.sync(() => ({ ...bound, processGeneration: ++binds }))
        );
        const { events, next } = yield* recorder;
        assert.deepStrictEqual(
          yield* events.withEvent(
            { type: "re-run" },
            invocations.call(
              { handler: "demo.query", args: { id: 1 } },
              { ...binding, correlationId: `rebound-${reason}` },
              Effect.succeed(viewer)
            )
          ),
          { ok: true, value: 7 },
          reason
        );
        assert.deepStrictEqual(
          sent.map((request) => request.processGeneration),
          [1, 2],
          reason
        );
        assert.notStrictEqual(sent[0]!.attemptId, sent[1]!.attemptId, reason);
        // The refused invoke ran no handler, so it is not one of the call's attempts.
        assert.include(yield* next, { attempts: 1, processGeneration: 2, rebound: true }, reason);
      }
    })
  );

  it.effect("binds again at most once and never replays an invoke whose reply was lost", () =>
    Effect.gen(function* () {
      for (const [reason, expected] of [
        ["stale_generation", 2],
        ["transport", 1]
      ] as const) {
        let binds = 0;
        let invokes = 0;
        const invocations = yield* makeInvocation(
          () =>
            Effect.suspend(() => {
              invokes++;
              return Effect.fail(new Executor.ExecutionError({ operation: "invoke", reason }));
            }),
          () => Effect.sync(() => ({ ...bound, processGeneration: ++binds }))
        );
        const { events, next } = yield* recorder;
        const failure = yield* events
          .withEvent(
            { type: "request" },
            invocations.call(
              { handler: "demo.mutation", args: {}, mutationKey: yield* MutationTransaction.mint },
              { ...binding, correlationId: `unrecovered-${reason}` },
              Effect.succeed(viewer)
            )
          )
          .pipe(Effect.flip);
        assert.strictEqual(failure.code, "handler_failed", reason);
        assert.strictEqual(invokes, expected, reason);
        assert.strictEqual(binds, expected, reason);
        // A rebind that fails still shows the refusal behind it; a lost reply never rebinds.
        const event = yield* next;
        if (reason === "transport") assert.notProperty(event, "rebound", reason);
        else assert.include(event, { rebound: true }, reason);
      }
    })
  );

  it.effect("never binds or invokes again past the call's deadline", () =>
    Effect.gen(function* () {
      // Refused just as the deadline passes, then refused in time with a rebind that outlasts it.
      for (const [late, expectedBinds] of [
        ["refusal", 1],
        ["rebind", 2]
      ] as const) {
        let binds = 0;
        let invokes = 0;
        let deadline = 0;
        const invocations = yield* makeInvocation(
          (request) =>
            Effect.gen(function* () {
              invokes++;
              deadline = request.deadline;
              if (late === "refusal") yield* TestClock.setTime(deadline);
              return yield* new Executor.ExecutionError({
                operation: "invoke",
                reason: "stale_generation"
              });
            }),
          () =>
            ++binds === 1
              ? Effect.succeed(bound)
              : TestClock.setTime(deadline).pipe(Effect.andThen(Effect.never))
        );
        const failure = yield* invocations
          .call(
            { handler: "demo.query", args: { id: 1 } },
            { ...binding, correlationId: `late-${late}` },
            Effect.succeed(viewer)
          )
          .pipe(Effect.flip);
        assert.strictEqual(failure.code, "handler_timeout", late);
        assert.strictEqual(binds, expectedBinds, late);
        assert.strictEqual(invokes, 1, late);
      }
    })
  );

  it.effect(
    "waits for the company's server outside the call's deadline, and its process start inside it",
    () =>
      Effect.gen(function* () {
        // A bind wait of 30 s, then a process start just within the query's 3 s, then just past.
        for (const [startMs, expected] of [
          [2_900, "success"],
          [3_100, "handler_timeout"]
        ] as const) {
          const invocations = yield* makeInvocation(
            () =>
              Effect.succeed({
                outcome: "returned" as const,
                reply: { ok: true as const, value: 1 },
                guestMs: 1
              }),
            () => Effect.sleep(startMs).pipe(Effect.as(bound))
          ).pipe(
            Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
              prewarm: () => Effect.die("Nothing here prewarms."),
              touch: () => Effect.succeed({ outcome: "absent" as const }),
              connect: () => Effect.void,
              acquire: () =>
                Effect.sleep("30 seconds").pipe(
                  Effect.as({
                    binding: { taskId: "cold-task", bindingEpoch: 1 },
                    release: Effect.void
                  })
                )
            })
          );
          const call = yield* invocations
            .call(
              { handler: "demo.query", args: { id: 1 } },
              { ...binding, correlationId: `cold-${startMs}` },
              Effect.succeed(viewer)
            )
            .pipe(
              Effect.map(() => "success"),
              Effect.catch((error) => Effect.succeed(error.code)),
              Effect.forkChild
            );
          yield* TestClock.adjust("30 seconds");
          yield* TestClock.adjust(startMs);
          assert.strictEqual(yield* Fiber.join(call), expected, `${startMs} ms`);
        }
      })
  );

  it.effect("admits an agent's call as the agent's, and its nested calls ride on it", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const done = yield* Deferred.make<void>();
      const callers: Array<ExecutionLifecycle.Caller> = [];
      const released: Array<ExecutionLifecycle.Caller> = [];
      const invocations = yield* makeInvocation((request) =>
        Queue.offer(seen, request).pipe(
          Effect.andThen(request.handler === "agent.gather" ? Deferred.await(done) : Effect.void),
          Effect.as({
            outcome: "returned" as const,
            reply: { ok: true as const, value: 1 },
            guestMs: 1
          })
        )
      ).pipe(
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () => Effect.void,
          acquire: (_company, _patch, caller) =>
            Effect.sync(() => {
              callers.push(caller);
              return {
                binding: { taskId: "agent-task", bindingEpoch: 1 },
                release: Effect.sync(() => {
                  released.push(caller);
                })
              };
            })
        })
      );
      yield* invocations.call(
        { handler: "demo.query", args: { id: 1 } },
        { ...binding, correlationId: "page-caller" },
        Effect.succeed(viewer)
      );
      yield* Queue.take(seen);
      const agent = yield* Invocation.callAgent({
        version: binding,
        person: viewer,
        agent: { name: "Claude" },
        tool: "gather",
        args: {},
        recheck: Effect.succeed(viewer)
      }).pipe(Effect.provideService(Invocation.Invocation, invocations), Effect.forkChild);
      const request = yield* Queue.take(seen);
      const capability = yield* capabilities.resolve(request.callback.capability, request);
      yield* capability.run!({ handler: "demo.query", args: { id: 1 } });
      assert.deepStrictEqual(callers, ["page", "agent"]);
      // The agent's one admission settles with its nested work, and only then.
      assert.notInclude(released, "agent");
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(agent);
      assert.include(released, "agent");
    })
  );

  it.effect("keeps a nested call on its parent's process generation", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const actionDone = yield* Deferred.make<void>();
      let binds = 0;
      const invocations = yield* makeInvocation(
        (request) =>
          Queue.offer(seen, request).pipe(
            Effect.andThen(
              request.handler === "demo.action"
                ? Deferred.await(actionDone).pipe(
                    Effect.as({
                      outcome: "returned" as const,
                      reply: { ok: true as const, value: 42 },
                      guestMs: 1
                    })
                  )
                : Effect.fail(
                    new Executor.ExecutionError({ operation: "invoke", reason: "stale_generation" })
                  )
            )
          ),
        () =>
          Effect.sync(() => {
            binds++;
            return bound;
          })
      );
      const parent = yield* invocations
        .call(
          { handler: "demo.action", args: {} },
          { ...binding, correlationId: "nested-generation" },
          Effect.succeed(viewer)
        )
        .pipe(Effect.forkChild);
      const request = yield* Queue.take(seen);
      const capability = yield* capabilities.resolve(request.callback.capability, request);
      const child = yield* capability.run!({ handler: "demo.query", args: { id: 1 } }).pipe(
        Effect.flip
      );
      assert.strictEqual(child.code, "handler_failed");
      // One child dispatch on the parent's generation, and no bind of its own.
      assert.strictEqual((yield* Queue.take(seen)).processGeneration, bound.processGeneration);
      assert.strictEqual(yield* Queue.size(seen), 0);
      assert.strictEqual(binds, 1);
      yield* Deferred.succeed(actionDone, undefined);
      assert.deepStrictEqual(yield* Fiber.join(parent), { ok: true, value: 42 });
    })
  );

  it.effect(
    "a read-only action's capability carries the flag and its nested calls reach queries only",
    () =>
      Effect.gen(function* () {
        const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
        const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
        const done = yield* Deferred.make<void>();
        const invocations = yield* makeInvocation((request) =>
          Queue.offer(seen, request).pipe(
            Effect.andThen(request.handler === "demo.query" ? Effect.void : Deferred.await(done)),
            Effect.as({
              outcome: "returned" as const,
              reply: { ok: true as const, value: 1 },
              guestMs: 1
            })
          )
        );
        const capabilityOf = Effect.fnUntraced(function* (handler: string) {
          const fiber = yield* invocations
            .call(
              { handler, args: {} },
              { ...binding, correlationId: newInternalId("call") },
              Effect.succeed(viewer)
            )
            .pipe(Effect.forkChild);
          const request = yield* Queue.take(seen);
          return {
            fiber,
            capability: yield* capabilities.resolve(request.callback.capability, request)
          };
        });
        const action = yield* capabilityOf("demo.action");
        assert.isFalse(action.capability.readOnly);
        const peek = yield* capabilityOf("demo.peek");
        assert.isTrue(peek.capability.readOnly);
        for (const handler of ["demo.mutation", "demo.action"])
          assert.strictEqual(
            (yield* peek.capability.run!({ handler, args: {} }).pipe(Effect.flip)).code,
            "access_denied"
          );
        // Nothing ran for either refusal.
        assert.strictEqual(yield* Queue.size(seen), 0);
        assert.deepStrictEqual(
          yield* peek.capability.run!({ handler: "demo.query", args: { id: 1 } }),
          {
            ok: true,
            value: 1
          }
        );
        yield* Deferred.succeed(done, undefined);
        assert.deepStrictEqual(yield* Fiber.join(peek.fiber), { ok: true, value: 1 });
        assert.deepStrictEqual(yield* Fiber.join(action.fiber), { ok: true, value: 1 });
      })
  );

  it.effect("only an agent's call reaches a marked agent tool, nested calls included", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const done = yield* Deferred.make<void>();
      const invocations = yield* makeInvocation((request) =>
        Queue.offer(seen, request).pipe(
          Effect.andThen(
            request.handler === "demo.action" || request.handler === "agent.gather"
              ? Deferred.await(done)
              : Effect.void
          ),
          Effect.as({
            outcome: "returned" as const,
            reply: { ok: true as const, value: 1 },
            guestMs: 1
          })
        )
      );
      const call = (handler: string, from = binding) =>
        invocations.call(
          { handler, args: {} },
          { ...from, correlationId: newInternalId("call") },
          Effect.succeed(viewer)
        );
      const agentCall = (tool: string, person: Invocation.AgentCall["person"] = viewer) =>
        Invocation.callAgent({
          version: binding,
          person,
          agent: { name: "Claude" },
          tool,
          args: {},
          recheck: Effect.succeed(person)
        }).pipe(
          Effect.provideService(Invocation.Invocation, invocations),
          Effect.provide(NodeCryptography.layer)
        );
      const refused = (effect: Effect.Effect<unknown, { readonly code: string }>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error.code)
        );
      // A page's call, its live query, and an action's nested call are all refused.
      assert.strictEqual(yield* refused(call("agent.lookup")), "access_denied");
      assert.strictEqual(
        yield* refused(
          invocations.call({ handler: "agent.lookup", args: {} }, binding, Effect.succeed(viewer), {
            onDependency: () => {},
            onSnapshot: () => {}
          })
        ),
        "access_denied"
      );
      // An agent starts only a marked tool: never a page handler, nor an agent.* handler with no
      // mark, which stays an ordinary page handler; and only in its person's own company.
      const agent = { ...binding, agent: { name: "Claude" } };
      assert.strictEqual(yield* refused(call("demo.query", agent)), "access_denied");
      assert.strictEqual(yield* refused(agentCall("legacy")), "access_denied");
      assert.strictEqual(yield* refused(agentCall("missing")), "invalid_request");
      assert.strictEqual(
        yield* refused(
          agentCall("lookup", { ...viewer, company: { ...viewer.company, id: "cmp_elsewhere" } })
        ),
        "access_denied"
      );
      assert.strictEqual(yield* Queue.size(seen), 0);
      assert.deepStrictEqual(yield* call("agent.legacy"), { ok: true, value: 1 });
      assert.notProperty(yield* Queue.take(seen), "agent");
      // Whether a call came from an agent is Patchy's own invocation context, and the guest
      // hears it as ctx.agent.
      assert.deepStrictEqual(yield* agentCall("lookup"), { ok: true, value: 1 });
      assert.deepStrictEqual((yield* Queue.take(seen)).agent, { name: "Claude" });
      const nestedFrom = Effect.fnUntraced(function* (parent: Effect.Effect<unknown, unknown>) {
        const fiber = yield* parent.pipe(Effect.forkChild);
        const request = yield* Queue.take(seen);
        const capability = yield* capabilities.resolve(request.callback.capability, request);
        return { fiber, request, run: capability.run! };
      });
      const page = yield* nestedFrom(call("demo.action"));
      assert.strictEqual(
        yield* refused(page.run({ handler: "agent.lookup", args: {} })),
        "access_denied"
      );
      // Inside an agent tool, ctx.run reaches ordinary siblings, and each carries the agent.
      const fromAgent = yield* nestedFrom(agentCall("gather"));
      assert.deepStrictEqual(fromAgent.request.agent, { name: "Claude" });
      for (const [handler, args] of [
        ["demo.query", { id: 1 }],
        ["agent.lookup", {}]
      ] as const) {
        assert.deepStrictEqual(yield* fromAgent.run({ handler, args }), {
          ok: true,
          value: 1
        });
        const nested = yield* Queue.take(seen);
        assert.strictEqual(nested.handler, handler);
        assert.deepStrictEqual(nested.agent, { name: "Claude" });
      }
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(page.fiber);
      yield* Fiber.join(fromAgent.fiber);
    })
  );

  it.effect("does not persist a quiet successful query", () =>
    Effect.gen(function* () {
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const invocations = yield* makeInvocation((request) =>
        Queue.offer(seen, request).pipe(
          Effect.as({
            outcome: "returned" as const,
            reply: { ok: true as const, value: 42 },
            guestMs: 1
          })
        )
      );
      assert.deepStrictEqual(
        yield* invocations.call(
          { handler: "demo.query", args: { id: 42 } },
          binding,
          Effect.succeed(viewer)
        ),
        { ok: true, value: 42 }
      );
      const request = yield* Queue.take(seen);
      const logs = yield* InvocationLog.InvocationLog;
      assert.isNull(
        yield* logs.find({ companyId: binding.companyId, invocationId: request.invocationId })
      );
    })
  );

  it.effect(
    "fences and settles a disconnected caller at its deadline without an executor return",
    () =>
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
        const released = yield* Deferred.make<void>();
        let active = false;
        const invocations = yield* makeInvocation((request) =>
          Queue.offer(seen, request).pipe(Effect.andThen(Effect.never))
        ).pipe(
          Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
            prewarm: () => Effect.die("Nothing here prewarms."),
            touch: () => Effect.succeed({ outcome: "absent" as const }),
            connect: () => Effect.void,
            acquire: () =>
              Effect.sync(() => {
                active = true;
                return {
                  binding: { taskId: "disconnect-task", bindingEpoch: 1 },
                  release: Effect.sync(() => {
                    active = false;
                  }).pipe(Effect.andThen(Deferred.succeed(released, undefined)), Effect.asVoid)
                };
              })
          })
        );
        const runtime = yield* Runtime.make(
          {},
          {
            origin: "http://localhost",
            identity: () => Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
          }
        ).pipe(
          Effect.provideService(Invocation.Invocation, invocations),
          Effect.provideService(LoadedVersions.LoadedVersions, {
            find: () =>
              Effect.succeed(Option.some({ ...binding, patchTier: binding.manifest.tier }))
          })
        );
        const request = HttpServerRequest.fromWeb(
          new Request("http://localhost/api/runtime/call", {
            method: "POST",
            headers: {
              origin: "http://localhost",
              "x-patchy-wire": "1",
              "x-patchy-principal": JSON.stringify({ userId: viewer.user.id })
            }
          })
        );
        const caller = yield* runtime
          .call({
            patchId: binding.patchId,
            versionId: binding.versionId,
            wire: 1,
            principal: binding.principal,
            op: "server.call",
            args: {
              handler: "demo.mutation",
              args: {},
              mutationKey: yield* MutationTransaction.mint
            }
          })
          .pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.forkChild
          );
        const dispatched = yield* Queue.take(seen);
        yield* Fiber.interrupt(caller);
        assert.isTrue(active);
        yield* TestClock.adjust("5 seconds");
        const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
        assert.strictEqual(
          (yield* capabilities
            .resolve(dispatched.callback.capability, dispatched)
            .pipe(Effect.flip)).reason,
          "deadline"
        );
        // The owner fiber is independent of the closed request; wait for its durable settlement.
        const log = yield* InvocationLog.InvocationLog;
        const readSettled = Effect.gen(function* () {
          while (true) {
            const row = yield* log.find({
              companyId: binding.companyId,
              invocationId: dispatched.invocationId
            });
            if (row !== null && row.settledAt !== null) return row;
            yield* Effect.yieldNow;
          }
        });
        const row = yield* readSettled;
        yield* Deferred.await(released);
        assert.isFalse(active);
        assert.strictEqual(row?.outcome, "handler_timeout");
        assert.strictEqual(row?.replyDelivered, false);
      })
  );

  it.effect(
    "destroys unresolved resources and keeps the invocation unknown instead of claiming timeout",
    () =>
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
        const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
        const cancelled = yield* Deferred.make<void>();
        const resourceSettled = yield* Deferred.make<void>();
        let destroyed = false;
        let active = false;
        const invocations = yield* makeInvocation((request) =>
          Effect.gen(function* () {
            yield* capabilities
              .retain(request.callback.capability, request, {
                cancel: Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
                settled: Deferred.await(resourceSettled),
                destroy: () => {
                  destroyed = true;
                }
              })
              .pipe(Effect.orDie);
            yield* Queue.offer(seen, request);
            return yield* Effect.never;
          })
        ).pipe(
          Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
            prewarm: () => Effect.die("Nothing here prewarms."),
            touch: () => Effect.succeed({ outcome: "absent" as const }),
            connect: () => Effect.void,
            acquire: () =>
              Effect.sync(() => {
                active = true;
                return {
                  binding: { taskId: "cleanup-task", bindingEpoch: 1 },
                  release: Effect.sync(() => {
                    active = false;
                  })
                };
              })
          })
        );
        const caller = yield* invocations
          .call(
            { handler: "demo.mutation", args: {}, mutationKey: yield* MutationTransaction.mint },
            binding,
            Effect.succeed(viewer)
          )
          .pipe(Effect.result, Effect.forkChild);
        const request = yield* Queue.take(seen);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(cancelled);
        assert.isTrue(active);
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(caller);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.code, "unknown_outcome");
        assert.isTrue(destroyed);
        assert.isFalse(active);
        const log = yield* InvocationLog.InvocationLog;
        assert.strictEqual(
          (yield* log.find({ companyId: binding.companyId, invocationId: request.invocationId }))
            ?.outcome,
          "unknown_outcome"
        );
        yield* Deferred.succeed(resourceSettled, undefined);
      })
  );

  it.effect("nested queries inherit the remaining action budget and keep their parent row", () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const route = { taskId: "original-task", bindingEpoch: 7 };
      let acquisitions = 0;
      let released = false;
      const releasedSignal = yield* Deferred.make<void>();
      const invocations = yield* makeInvocation((request, selected) => {
        assert.deepStrictEqual(selected, route);
        return Queue.offer(seen, request).pipe(Effect.andThen(Effect.never));
      }).pipe(
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
          prewarm: () => Effect.die("Nothing here prewarms."),
          touch: () => Effect.succeed({ outcome: "absent" as const }),
          connect: () => Effect.void,
          acquire: () =>
            Effect.sync(() => {
              acquisitions++;
              return {
                binding: route,
                release: Effect.sync(() => {
                  released = true;
                }).pipe(Effect.andThen(Deferred.succeed(releasedSignal, undefined)), Effect.asVoid)
              };
            })
        })
      );
      const parent = yield* invocations
        .call(
          { handler: "demo.action", args: {} },
          { ...binding, correlationId: "nested-action" },
          Effect.succeed(viewer)
        )
        .pipe(Effect.exit, Effect.forkChild);
      const request = yield* Queue.take(seen);
      const capability = yield* capabilities.resolve(request.callback.capability, request);
      assert.isDefined(capability.run);
      const forbidden = yield* capability.run!({ handler: "demo.action", args: {} }).pipe(
        Effect.flip
      );
      assert.strictEqual(forbidden.code, "access_denied");
      yield* Fiber.interrupt(parent);
      assert.isFalse(released);
      yield* TestClock.adjust("59 seconds");
      const child = yield* capability.run!({ handler: "demo.query", args: { id: 1 } }).pipe(
        Effect.exit,
        Effect.forkChild
      );
      const nested = yield* Queue.take(seen);
      assert.strictEqual(nested.deadline, request.deadline);
      assert.notStrictEqual(nested.invocationId, request.invocationId);
      const childCapability = yield* capabilities.resolve(nested.callback.capability, nested);
      assert.strictEqual(childCapability.tree, capability.tree);
      assert.strictEqual(acquisitions, 1);
      assert.isFalse(released);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(child);
      assert.isTrue(Exit.isFailure(result));
      yield* Deferred.await(releasedSignal);
      assert.isTrue(released);
      const log = yield* InvocationLog.InvocationLog;
      const row = yield* log.find({
        companyId: binding.companyId,
        invocationId: nested.invocationId
      });
      assert.strictEqual(row?.parentId, request.invocationId);
      assert.strictEqual(row?.outcome, "handler_timeout");
    })
  );

  it.effect("attributes only root timeouts while retaining handled nested deadline peaks", () =>
    Effect.gen(function* () {
      const queryDeadline = yield* ContractLimits.get("tier2.query.deadline");
      const gateway = yield* CallbackGateway.make({}).pipe(Effect.provide(RuntimeLog.layer));
      const queries = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const invocations = yield* makeInvocation((request) =>
        Effect.gen(function* () {
          if (request.handler === "demo.query") {
            yield* Queue.offer(queries, request);
            return yield* Effect.never;
          }
          const reply = yield* gateway.callback(request.callback.capability, request, {
            op: "server.call",
            args: { handler: "demo.query", args: { id: 1 } }
          });
          assert.deepInclude(reply, { ok: false, source: "patchy", code: "handler_timeout" });
          return {
            outcome: "returned" as const,
            reply: { ok: true as const, value: "recovered" },
            guestMs: 0
          };
        })
      );
      const records = yield* Queue.unbounded<WideEvents.WideEvent>();
      const events = yield* WideEvents.make.pipe(
        Effect.provideService(WideEvents.Sink, {
          write: (event) => Queue.offer(records, event).pipe(Effect.asVoid)
        })
      );
      for (const handler of ["demo.action", "demo.query"]) {
        const caller = yield* events
          .withEvent(
            { type: "request" },
            invocations.call(
              { handler, args: handler === "demo.query" ? { id: 1 } : {} },
              { ...binding, correlationId: newInternalId("call") },
              Effect.succeed(viewer)
            )
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* Queue.take(queries);
        yield* TestClock.adjust(queryDeadline);
        const result = yield* Fiber.join(caller);
        const event = yield* Queue.take(records);
        if (event.type !== "request") return assert.fail("Expected request event");
        assert.strictEqual(event.handler, handler);
        assert.strictEqual(event.closestLimitId, "tier2.query.deadline");
        assert.isDefined(event.limits);
        assert.deepInclude(event.limits, {
          limitId: "tier2.query.deadline",
          value: queryDeadline,
          peak: queryDeadline,
          configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
        });
        if (handler === "demo.action") {
          assert.strictEqual(result._tag, "Success");
          if (result._tag === "Success")
            assert.deepStrictEqual(result.success, { ok: true, value: "recovered" });
          assert.strictEqual(event.outcome, "success");
          assert.isUndefined(event.limitId);
          assert.isUndefined(event.code);
        } else {
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure") assert.strictEqual(result.failure.code, "handler_timeout");
          assert.strictEqual(event.outcome, "failure");
          assert.strictEqual(event.limitId, "tier2.query.deadline");
          assert.strictEqual(event.code, "handler_timeout");
        }
      }
    })
  );

  it.effect("enforces viewer action slots and releases them after settlement", () =>
    Effect.gen(function* () {
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const finish = yield* Deferred.make<GuestProtocol.InvokeReply>();
      const invocations = yield* makeInvocation((request) =>
        Queue.offer(seen, request).pipe(Effect.andThen(Deferred.await(finish)))
      );
      const call = Effect.suspend(() =>
        invocations.call(
          { handler: "demo.action", args: {} },
          {
            ...binding,
            correlationId: newInternalId("call")
          },
          Effect.succeed(viewer)
        )
      );
      const first = yield* call.pipe(Effect.forkChild);
      yield* Queue.take(seen);
      const second = yield* call.pipe(Effect.forkChild);
      yield* Queue.take(seen);
      assert.deepInclude(Runtime.toFailure(yield* call.pipe(Effect.flip)), {
        code: "busy",
        limitId: "tier2.actions.viewer",
        value: 2
      });
      yield* Deferred.succeed(finish, {
        outcome: "returned",
        reply: { ok: true, value: null },
        guestMs: 1
      });
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(yield* call, { ok: true, value: null });
    })
  );

  it.effect(
    "gives an agent its own action slots beside its person's page, shares the company's, and refuses before any row",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const limits = yield* OperatingLimits.OperatingLimits;
        const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
        let gate = yield* Deferred.make<GuestProtocol.InvokeReply>();
        const invocations = yield* makeInvocation((request) =>
          Queue.offer(seen, request).pipe(Effect.andThen(Deferred.await(gate)))
        );
        const page = Effect.suspend(() =>
          invocations.call(
            { handler: "demo.action", args: {} },
            { ...binding, correlationId: newInternalId("call") },
            Effect.succeed(viewer)
          )
        );
        const agent = Effect.suspend(() =>
          Invocation.callAgent({
            version: binding,
            person: viewer,
            agent: { name: "Claude" },
            tool: "gather",
            args: {},
            recheck: Effect.succeed(viewer)
          }).pipe(
            Effect.provideService(Invocation.Invocation, invocations),
            Effect.provide(NodeCryptography.layer)
          )
        );
        const refused = (effect: Effect.Effect<unknown, Runtime.RuntimeError>) =>
          effect.pipe(
            Effect.flip,
            Effect.map((error) => {
              const { code, limitId, value } = Runtime.toFailure(error);
              return { code, limitId, value };
            })
          );
        const rows = Effect.map(
          sql<{ readonly count: string }>`
            SELECT count(*) AS count FROM runtime_invocations WHERE patch_id = ${binding.patchId}`,
          ([row]) => Number(row?.count)
        );
        const run = Effect.fnUntraced(function* (calls: ReadonlyArray<typeof page>) {
          const fibers = [];
          for (const call of calls) fibers.push(yield* call.pipe(Effect.forkChild));
          yield* Effect.forEach(calls, () => Queue.take(seen), { discard: true });
          return fibers;
        });
        const settle = Effect.fnUntraced(function* (
          fibers: ReadonlyArray<Fiber.Fiber<unknown, Runtime.RuntimeError>>
        ) {
          yield* Deferred.succeed(gate, {
            outcome: "returned",
            reply: { ok: true, value: null },
            guestMs: 1
          });
          for (const fiber of fibers) yield* Fiber.join(fiber);
          gate = yield* Deferred.make<GuestProtocol.InvokeReply>();
        });
        const before = yield* rows;

        // The person's tab fills its two slots, and their agent still runs on its own two.
        const running = yield* run([page, page, agent, agent]);
        for (const call of [page, agent])
          assert.deepStrictEqual(yield* refused(call), {
            code: "busy",
            limitId: "tier2.actions.viewer",
            value: 2
          });
        // Refused at admission, neither wrote a row.
        assert.strictEqual(yield* rows, before + running.length);
        yield* settle(running);

        // The company's slots stay shared: the page's two and the agent's one fill three.
        yield* limits.setOverride({
          companyId: binding.companyId,
          limitId: "tier2.actions.company",
          value: 3,
          actor: "agent-slots-test"
        });
        const shared = yield* run([page, page, agent]);
        assert.deepStrictEqual(yield* refused(agent), {
          code: "busy",
          limitId: "tier2.actions.company",
          value: 3
        });
        yield* settle(shared);
      }).pipe(
        Effect.ensuring(
          OperatingLimits.OperatingLimits.use((limits) =>
            limits.removeOverride({
              companyId: binding.companyId,
              limitId: "tier2.actions.company",
              actor: "agent-slots-test"
            })
          ).pipe(Effect.ignore)
        )
      )
  );

  it.effect(
    "an agent's call retains its caller's hold from dispatch until its work settles, past a caller that went away",
    () =>
      Effect.gen(function* () {
        const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
        const finish = yield* Deferred.make<void>();
        const invocations = yield* makeInvocation((request) =>
          Queue.offer(seen, request).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as({
              outcome: "returned" as const,
              reply: { ok: true as const, value: 1 },
              guestMs: 1
            })
          )
        );
        const holds: string[] = [];
        const letGo = yield* Deferred.make<void>();
        const agent = (tool: string, from = invocations) =>
          Invocation.callAgent({
            version: binding,
            person: viewer,
            agent: { name: "Claude" },
            tool,
            args: {},
            recheck: Effect.succeed(viewer),
            retain: Effect.sync(() => {
              holds.push(`${tool} held`);
              return Effect.sync(() => void holds.push(`${tool} let go`)).pipe(
                Effect.andThen(Deferred.succeed(letGo, undefined))
              );
            })
          }).pipe(Effect.provideService(Invocation.Invocation, from));

        // Its client went away: the caller is gone at once, and the work keeps its hold.
        const caller = yield* agent("gather").pipe(Effect.forkChild);
        yield* Queue.take(seen);
        assert.deepStrictEqual(holds, ["gather held"]);
        yield* Fiber.interrupt(caller);
        assert.deepStrictEqual(holds, ["gather held"]);
        yield* Deferred.succeed(finish, undefined);
        yield* Deferred.await(letGo);
        assert.deepStrictEqual(holds, ["gather held", "gather let go"]);

        // A call refused before dispatch, or given up while it waits for the company's server,
        // never holds anything.
        holds.length = 0;
        yield* agent("legacy").pipe(Effect.flip);
        const waiting = yield* Deferred.make<void>();
        const cold = yield* makeInvocation(() => Effect.die("Nothing is dispatched.")).pipe(
          Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
            prewarm: () => Effect.die("Nothing here prewarms."),
            touch: () => Effect.succeed({ outcome: "absent" as const }),
            connect: () => Effect.void,
            acquire: () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
          })
        );
        const starting = yield* agent("gather", cold).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* Fiber.interrupt(starting);
        assert.deepStrictEqual(holds, []);

        // Work the action starts through ctx.run holds it too, after the action has settled.
        const capabilities = yield* InvocationCapabilities.InvocationCapabilities;
        const actionDone = yield* Deferred.make<void>();
        const childDone = yield* Deferred.make<void>();
        const nesting = yield* makeInvocation((request) =>
          Queue.offer(seen, request).pipe(
            Effect.andThen(
              Deferred.await(request.handler === "agent.gather" ? actionDone : childDone)
            ),
            Effect.as({
              outcome: "returned" as const,
              reply: { ok: true as const, value: 1 },
              guestMs: 1
            })
          )
        );
        const parent = yield* agent("gather", nesting).pipe(Effect.forkChild);
        const request = yield* Queue.take(seen);
        const capability = yield* capabilities.resolve(request.callback.capability, request);
        const child = yield* capability.run!({ handler: "demo.query", args: { id: 1 } }).pipe(
          Effect.forkChild
        );
        yield* Queue.take(seen);
        yield* Deferred.succeed(actionDone, undefined);
        yield* Fiber.join(parent);
        const outstanding = () =>
          holds.filter((hold) => hold.endsWith("held")).length -
          holds.filter((hold) => hold.endsWith("let go")).length;
        assert.strictEqual(outstanding(), 1);
        yield* Deferred.succeed(childDone, undefined);
        yield* Fiber.join(child);
        assert.strictEqual(outstanding(), 0);
      })
  );
});
