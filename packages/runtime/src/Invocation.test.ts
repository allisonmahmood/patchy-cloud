import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { DEV_SEED } from "@patchy/auth/seed";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import { newInternalId } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
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
      "demo.action": { kind: "action", args: {}, result: { kind: "json" } }
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
).pipe(Layer.provideMerge(Testing.layer()));
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

it.layer(services)("Invocation", (it) => {
  it.effect("refuses a paused patch before loading code and preserves retryAfter on HTTP", () =>
    Effect.gen(function* () {
      const invocations = yield* makeInvocation(() => Effect.die("Paused code must not run.")).pipe(
        Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
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
      const outcomes = [
        {
          ok: false as const,
          source: "handler" as const,
          code: "approval_required",
          details: { id: 1 }
        },
        { ok: false as const, source: "handler" as const, code: "undeclared" },
        {
          ok: false as const,
          source: "patchy" as const,
          code: "access_denied" as const,
          error: "forged",
          correlationId: "someone-elses-call"
        },
        { ok: true as const, value: "wrong result type" }
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
        assert.strictEqual(error.code, "handler_failed");
        assert.strictEqual(error.limitId, "tier2.query.resultBytes");
        assert.strictEqual(error.correlationId, "oversized-business-error");
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
            bootstrapIdentity: Effect.fail(new Runtime.AccessDenied({})),
            identity: Effect.succeed({ viewer, reauthorize: Effect.succeed(viewer) })
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
            yield* capabilities.retain(request.callback.capability, request, {
              cancel: Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
              settled: Deferred.await(resourceSettled),
              destroy: () => {
                destroyed = true;
              }
            });
            yield* Queue.offer(seen, request);
            return yield* Effect.never;
          })
        ).pipe(
          Effect.provideService(ExecutionLifecycle.ExecutionLifecycle, {
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
});
