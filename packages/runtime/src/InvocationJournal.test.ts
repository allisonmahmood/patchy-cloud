import { assert, it } from "@effect/vitest";
import { CURRENT_RELEASE, WIRE_VERSION, type GuestProtocol } from "@patchy/api";
import { DEV_SEED } from "@patchy/auth/seed";
import { newInternalId } from "@patchy/core";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Binding from "./Binding.js";
import * as Executor from "./Executor.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
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
  patchId: "journal397001",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  companyId: DEV_SEED.companyId,
  wireVersion: WIRE_VERSION,
  scope: "company",
  principal: { userId: viewer.user.id },
  identity: viewer,
  correlationId: "journal-test",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 2,
    tables: {},
    files: {},
    uses: {},
    handlers: { "demo.action": { kind: "action", args: {}, result: { kind: "json" } } }
  }
};
const bundle: GuestProtocol.Bundle = {
  companyId: binding.companyId,
  patchId: binding.patchId,
  versionId: binding.versionId,
  sha256: "0".repeat(64),
  bundle: "executor-fault-layer"
};
const reply: GuestProtocol.InvokeReply = {
  outcome: "returned",
  reply: { ok: true, value: null },
  guestMs: 1
};
const services = Layer.mergeAll(
  InvocationLog.layer,
  OperatingLimits.layer,
  Limits.layer,
  InvocationCapabilities.layer
).pipe(Layer.provideMerge(Testing.layer()));
const makeInvocation = (invoke: Executor.Executor["Service"]["invoke"]) =>
  Invocation.make({ callbackUrl: "http://127.0.0.1:1/callback" }).pipe(
    Effect.provideService(MutationTransaction.MutationTransaction, mutations),
    Effect.provideService(QuerySnapshot.QuerySnapshot, { open: () => Effect.succeed(snapshot) }),
    Effect.provideService(Executor.Executor, {
      bind: () =>
        Effect.succeed({
          binding: {
            companyId: bundle.companyId,
            patchId: bundle.patchId,
            versionId: bundle.versionId,
            sha256: bundle.sha256
          },
          processGeneration: 1
        }),
      invoke
    }),
    Effect.provideService(ServerBundles.ServerBundles, { load: () => Effect.succeed(bundle) }),
    Effect.provideService(ContractLimits.overrides, {
      "tier2.action.deadline": 500,
      "tier2.settlement.cleanup": 100
    })
  );
const call = (invocations: Invocation.Invocation["Service"]) =>
  Effect.suspend(() =>
    invocations.call(
      { handler: "demo.action", args: {} },
      { ...binding, correlationId: newInternalId("journal") },
      Effect.succeed(viewer)
    )
  );

const lockJournal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const locked = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const holder = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`LOCK TABLE runtime_invocations IN ACCESS EXCLUSIVE MODE`;
        yield* Deferred.succeed(locked, undefined);
        yield* Deferred.await(release);
      })
    )
    .pipe(Effect.forkChild);
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  yield* Deferred.await(locked);
  return Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.join(holder)));
});
const awaitBlocked = Effect.fnUntraced(function* (count: number) {
  const sql = yield* SqlClient.SqlClient;
  while (true) {
    const rows = yield* sql<{ count: number }>`
      SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%runtime_invocations%'`;
    if (rows[0]!.count === count) return;
    yield* Effect.yieldNow;
  }
});

it.layer(services)("Invocation journal deadlines", (it) => {
  it.effect(
    "bounds locked admission after disconnect without dispatching unattributed guests",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* Queue.unbounded<GuestProtocol.Invoke>();
        const invocations = yield* makeInvocation((request) =>
          Queue.offer(dispatched, request).pipe(Effect.as(reply))
        );
        const unlock = yield* lockJournal;
        const first = yield* call(invocations).pipe(Effect.result, Effect.forkChild);
        const second = yield* call(invocations).pipe(Effect.result, Effect.forkChild);
        yield* awaitBlocked(2);
        assert.strictEqual((yield* call(invocations).pipe(Effect.flip)).code, "busy");
        yield* Fiber.interrupt(first);
        yield* TestClock.adjust(500);
        const result = yield* Fiber.join(second);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.code, "handler_timeout");
        yield* TestClock.adjust(100);
        yield* awaitBlocked(0);
        assert.strictEqual(yield* Queue.size(dispatched), 0);
        const replacement = yield* call(invocations).pipe(Effect.forkChild);
        yield* awaitBlocked(1);
        yield* unlock;
        assert.deepStrictEqual(yield* Fiber.join(replacement), { ok: true, value: null });
        const request = yield* Queue.take(dispatched);
        const log = yield* InvocationLog.InvocationLog;
        const row = yield* log.find({
          companyId: binding.companyId,
          invocationId: request.invocationId
        });
        assert.strictEqual(row?.initiatingViewerId, viewer.user.id);
        assert.strictEqual(row?.outcome, "success");
        assert.strictEqual(yield* Queue.size(dispatched), 0);
      })
  );

  it.effect(
    "bounds locked settlement after disconnect and releases slots with unknown evidence",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* Queue.unbounded<GuestProtocol.Invoke>();
        const returned = yield* Deferred.make<void>();
        const invocations = yield* makeInvocation((request) =>
          Queue.offer(dispatched, request).pipe(
            Effect.andThen(Deferred.await(returned)),
            Effect.as(reply)
          )
        );
        const first = yield* call(invocations).pipe(Effect.result, Effect.forkChild);
        const firstRequest = yield* Queue.take(dispatched);
        const second = yield* call(invocations).pipe(Effect.result, Effect.forkChild);
        const secondRequest = yield* Queue.take(dispatched);
        const unlock = yield* lockJournal;
        yield* Deferred.succeed(returned, undefined);
        yield* awaitBlocked(2);
        yield* Fiber.interrupt(first);
        yield* TestClock.adjust(600);
        const result = yield* Fiber.join(second);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.code, "unknown_outcome");
        yield* awaitBlocked(0);
        const replacement = yield* call(invocations).pipe(Effect.forkChild);
        yield* awaitBlocked(1);
        yield* unlock;
        assert.deepStrictEqual(yield* Fiber.join(replacement), { ok: true, value: null });
        const log = yield* InvocationLog.InvocationLog;
        for (const request of [firstRequest, secondRequest]) {
          const row = yield* log.find({
            companyId: binding.companyId,
            invocationId: request.invocationId
          });
          assert.strictEqual(row?.outcome, "unknown_outcome");
          assert.isNull(row?.settledAt);
          assert.isFalse(row?.replyDelivered);
        }
      })
  );

  for (const phase of ["begin", "finish"] as const) {
    for (const fault of ["uninterruptible", "finalizer"] as const) {
      it.effect(`releases slots when journal ${phase} has a stuck ${fault}`, () =>
        Effect.gen(function* () {
          const log = yield* InvocationLog.InvocationLog;
          const entered = yield* Queue.unbounded<void>();
          const unblock = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(unblock, undefined));
          const completed = yield* Queue.unbounded<void>();
          const stuck =
            fault === "uninterruptible"
              ? Deferred.await(unblock).pipe(Effect.uninterruptible)
              : Effect.never.pipe(Effect.ensuring(Deferred.await(unblock)));
          const hold = Queue.offer(entered, undefined).pipe(
            Effect.andThen(stuck),
            Effect.ensuring(Queue.offer(completed, undefined))
          );
          let holds = 0;
          const journal: InvocationLog.InvocationLog["Service"] = {
            ...log,
            begin: (input) =>
              phase === "begin" && ++holds <= 2 ? hold.pipe(Effect.as(input.id)) : log.begin(input),
            finish: (input) => (phase === "finish" && ++holds <= 2 ? hold : log.finish(input))
          };
          const dispatched = yield* Queue.unbounded<GuestProtocol.Invoke>();
          const invocations = yield* makeInvocation((request) =>
            Queue.offer(dispatched, request).pipe(Effect.as(reply))
          ).pipe(Effect.provideService(InvocationLog.InvocationLog, journal));
          const first = yield* call(invocations).pipe(Effect.result, Effect.forkChild);
          const second = yield* call(invocations).pipe(Effect.result, Effect.forkChild);
          yield* Queue.take(entered);
          yield* Queue.take(entered);
          yield* TestClock.adjust(600);
          for (const caller of [first, second]) {
            const result = yield* Fiber.join(caller);
            assert.strictEqual(result._tag, "Failure");
            if (result._tag === "Failure")
              assert.strictEqual(
                result.failure.code,
                phase === "begin" ? "handler_timeout" : "unknown_outcome"
              );
          }
          assert.strictEqual(yield* Queue.size(dispatched), phase === "begin" ? 0 : 2);
          assert.deepStrictEqual(yield* call(invocations), { ok: true, value: null });
          yield* Deferred.succeed(unblock, undefined);
          yield* Queue.take(completed);
          yield* Queue.take(completed);
        })
      );
    }
  }

  it.effect("closes its owner scope while interrupted journal finalizers remain stuck", () =>
    Effect.gen(function* () {
      const log = yield* InvocationLog.InvocationLog;
      const entered = yield* Deferred.make<void>();
      const unblock = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      yield* Effect.addFinalizer(() => Deferred.succeed(unblock, undefined));
      const invocations = yield* makeInvocation(() => Effect.succeed(reply)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(InvocationLog.InvocationLog, {
          ...log,
          finish: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.await(unblock)),
              Effect.ensuring(Deferred.succeed(completed, undefined))
            )
        })
      );
      const caller = yield* call(invocations).pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(entered);
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust(100);
      yield* Fiber.join(closing);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(caller)));
      yield* Deferred.succeed(unblock, undefined);
      yield* Deferred.await(completed);
    })
  );
});
