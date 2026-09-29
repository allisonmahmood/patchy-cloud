import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { Limits, OperatingLimits } from "@patchy/limits";
import { newInternalId } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Binding from "./Binding.js";
import * as Executor from "./Executor.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as LoadedVersions from "./LoadedVersions.js";
import * as Runtime from "./Runtime.js";
import * as ServerBundles from "./ServerBundles.js";

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
const makeInvocation = (invoke: Executor.Executor["Service"]["invoke"]) =>
  Invocation.make({ callbackUrl: "http://127.0.0.1:1/callback" }).pipe(
    Effect.provideService(Executor.Executor, { bind: () => Effect.succeed(bound), invoke }),
    Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) })
  );

it.layer(services)("Invocation", (it) => {
  it.effect("validates loaded descriptors and refuses undeclared and forged handler failures", () =>
    Effect.gen(function* () {
      const seen = yield* Queue.unbounded<GuestProtocol.Invoke>();
      const replies = yield* Queue.unbounded<GuestProtocol.InvokeReply>();
      const invocations = yield* makeInvocation((request) =>
        Queue.offer(seen, request).pipe(Effect.andThen(Queue.take(replies)))
      );
      assert.strictEqual(
        (yield* invocations
          .call({ handler: "demo.query", args: { id: "wrong" } }, binding, Effect.succeed(viewer))
          .pipe(Effect.flip)).code,
        "invalid_request"
      );
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
        const invocations = yield* makeInvocation((request) =>
          Queue.offer(seen, request).pipe(Effect.andThen(Effect.never))
        );
        const runtime = yield* Runtime.make(
          {},
          { origin: "http://localhost", identity: Effect.succeed(viewer) }
        ).pipe(
          Effect.provideService(Invocation.Invocation, invocations),
          Effect.provideService(LoadedVersions.LoadedVersions, {
            find: () => Effect.succeed(Option.some(binding))
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
            args: { handler: "demo.mutation", args: {} }
          })
          .pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.forkChild
          );
        const dispatched = yield* Queue.take(seen);
        yield* Fiber.interrupt(caller);
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
            if (row?.outcome !== "pending") return row;
            yield* Effect.yieldNow;
          }
        });
        const row = yield* readSettled;
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
        );
        const caller = yield* invocations
          .call({ handler: "demo.mutation", args: {} }, binding, Effect.succeed(viewer))
          .pipe(Effect.result, Effect.forkChild);
        const request = yield* Queue.take(seen);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(cancelled);
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(caller);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.code, "unknown_outcome");
        assert.isTrue(destroyed);
        const log = yield* InvocationLog.InvocationLog;
        assert.strictEqual(
          (yield* log.find({ companyId: binding.companyId, invocationId: request.invocationId }))
            ?.outcome,
          "unknown_outcome"
        );
        yield* Deferred.succeed(resourceSettled, undefined);
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
