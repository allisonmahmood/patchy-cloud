import { assert, it } from "@effect/vitest";
import type { GuestProtocol, RuntimeStreamFrame } from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { DEV_SEED } from "@patchy/auth/seed";
import { ContractLimits, Limits, OperatingLimits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Executor from "./Executor.js";
import * as Invocation from "./Invocation.js";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as InvocationLog from "./InvocationLog.js";
import * as MutationTransaction from "./MutationTransaction.js";
import * as QuerySnapshot from "./QuerySnapshot.js";
import * as ServerBundles from "./ServerBundles.js";
import * as StreamLimits from "./StreamLimits.js";
import * as SubscriptionReads from "./SubscriptionReads.js";
import * as Subscriptions from "./Subscriptions.js";
import * as Fixtures from "./test/callbacks.js";

interface Attempt {
  readonly patchId: string;
  readonly release: Deferred.Deferred<void>;
  readonly cancelled: Deferred.Deferred<void>;
  readonly executorCancelled: Deferred.Deferred<void>;
  readonly reply: Deferred.Deferred<GuestProtocol.InvokeReply>;
  destroyed: boolean;
}

const viewer = {
  user: { id: DEV_SEED.userId, email: "dev@patchy.local", name: "Dev" },
  company: { id: DEV_SEED.companyId, name: "Patchy Dev", handle: "patchy-dev" },
  admin: true
};

const services = Layer.mergeAll(InvocationLog.layer, OperatingLimits.layer, Limits.layer).pipe(
  Layer.provideMerge(Testing.layer())
);

const fixture = Effect.gen(function* () {
  const scope = yield* Scope.fork(yield* Scope.Scope);
  const capabilities = yield* InvocationCapabilities.make.pipe(Scope.provide(scope));
  const started = yield* Queue.unbounded<Attempt>();
  const attempts = new Map<string, Attempt>();
  const held = new Set<Attempt>();
  const peaks = { company: 0, patch: 0 };
  const snapshots: QuerySnapshot.QuerySnapshot["Service"] = {
    open: (capability) =>
      Effect.gen(function* () {
        const attempt: Attempt = {
          patchId: capability.binding.patchId,
          release: yield* Deferred.make<void>(),
          cancelled: yield* Deferred.make<void>(),
          executorCancelled: yield* Deferred.make<void>(),
          reply: yield* Deferred.make<GuestProtocol.InvokeReply>(),
          destroyed: false
        };
        const settled = yield* Deferred.make<void>();
        attempts.set(capability.attempt.invocationId, attempt);
        held.add(attempt);
        peaks.company = Math.max(peaks.company, held.size);
        peaks.patch = Math.max(
          peaks.patch,
          [...held].filter((other) => other.patchId === attempt.patchId).length
        );
        const resource: QuerySnapshot.Resource = {
          watermark: {},
          run: (effect) => effect,
          cancel: Deferred.succeed(attempt.cancelled, undefined).pipe(
            Effect.andThen(Deferred.await(attempt.release)),
            Effect.andThen(Effect.sync(() => held.delete(attempt))),
            Effect.andThen(Deferred.succeed(settled, undefined)),
            Effect.asVoid
          ),
          settled: Deferred.await(settled),
          destroy: () => {
            attempt.destroyed = true;
            held.delete(attempt);
            Deferred.doneUnsafe(attempt.release, Effect.void);
          }
        };
        yield* capabilities.retain(capability.token, capability.attempt, resource);
        return resource;
      })
  };
  const invocations = yield* Invocation.make({ callbackUrl: "http://127.0.0.1:1/callback" }).pipe(
    Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities),
    Effect.provideService(QuerySnapshot.QuerySnapshot, snapshots),
    Effect.provideService(MutationTransaction.MutationTransaction, Fixtures.mutations),
    Effect.provideService(ServerBundles.ServerBundles, {
      load: (binding) =>
        Effect.succeed({
          companyId: binding.companyId,
          patchId: binding.patchId,
          versionId: binding.versionId,
          sha256: "0".repeat(64),
          bundle: "settlement-executor-port"
        })
    }),
    Effect.provideService(Executor.Executor, {
      bind: ({ companyId, patchId, versionId, sha256 }) =>
        Effect.succeed({
          binding: { companyId, patchId, versionId, sha256 },
          processGeneration: 1
        }),
      invoke: (request) =>
        Effect.gen(function* () {
          const attempt = attempts.get(request.invocationId)!;
          yield* Queue.offer(started, attempt);
          return yield* Deferred.await(attempt.reply).pipe(
            Effect.onInterrupt(() =>
              Deferred.succeed(attempt.executorCancelled, undefined).pipe(
                Effect.andThen(Deferred.await(attempt.release))
              )
            )
          );
        })
    }),
    Scope.provide(scope)
  );
  const registry = yield* Subscriptions.make.pipe(
    Effect.provideService(Invocation.Invocation, invocations),
    Effect.provideService(SubscriptionReads.SubscriptionReads, {
      admit: () => Effect.die("Unexpected table subscription admission"),
      read: () => Effect.die("Unexpected table subscription read"),
      revisions: () => Effect.succeed({})
    }),
    Effect.provide(StreamLimits.layerLocal),
    Effect.provide(WideEvents.layerNoop),
    Scope.provide(scope)
  );
  const documents: Array<Subscriptions.DocumentSubscriptions> = [];
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const document of documents) document.close();
      for (const attempt of attempts.values()) Deferred.doneUnsafe(attempt.release, Effect.void);
    })
  );
  const attach = Effect.fnUntraced(function* (generation: string, patchId: string) {
    const documentScope = yield* Scope.fork(scope);
    const frames = yield* Queue.unbounded<RuntimeStreamFrame>();
    const binding = {
      ...Fixtures.binding,
      companyId: viewer.company.id,
      identity: viewer,
      principal: { userId: viewer.user.id },
      patchId,
      manifest: {
        ...Fixtures.binding.manifest,
        handlers: {
          "demo.query": { kind: "query" as const, args: {}, result: { kind: "text" as const } }
        }
      }
    };
    const document = registry.attach({
      generation,
      binding: () => binding,
      check: Effect.void,
      scope: documentScope,
      send: (frame) => {
        Queue.offerUnsafe(frames, frame);
      }
    });
    documents.push(document);
    const subscribe = document
      .update({
        type: "subscribe",
        patchId,
        versionId: binding.versionId,
        documentId: generation,
        generation,
        sequence: 1,
        subscription: { id: "query", op: "server.call", args: { handler: "demo.query", args: {} } }
      })
      .pipe(
        Effect.andThen(Queue.take(frames)),
        Effect.tap((frame) => Effect.sync(() => assert.strictEqual(frame.type, "admitted")))
      );
    const close = Effect.sync(document.close).pipe(
      Effect.andThen(Scope.close(documentScope, Exit.void))
    );
    return { subscribe, close, frames, next: Queue.take(frames) };
  });
  return { attach, started, attempts, held, peaks };
});

it.layer(services)("Subscription invocation settlement", (it) => {
  for (const disconnect of [false, true]) {
    it.effect(
      `holds one patch and two company snapshot slots through ${disconnect ? "disconnect and deadline" : "deadline cleanup"}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture;
          const first = yield* f.attach("first", "settlement-a");
          const other = yield* f.attach("other", "settlement-b");
          const samePatch = yield* f.attach("same-patch", "settlement-a");
          const thirdPatch = yield* f.attach("third-patch", "settlement-c");
          yield* first.subscribe;
          const a = yield* Queue.take(f.started);
          yield* other.subscribe;
          const b = yield* Queue.take(f.started);
          yield* samePatch.subscribe;
          yield* thirdPatch.subscribe;
          if (disconnect) {
            yield* first.close;
            yield* other.close;
          }
          yield* TestClock.adjust(0);
          assert.strictEqual(f.attempts.size, 2);
          assert.strictEqual(f.held.size, 2);
          assert.deepStrictEqual(f.peaks, { company: 2, patch: 1 });

          yield* TestClock.adjust((yield* ContractLimits.get("tier2.query.deadline")) + 1_000);
          yield* Deferred.await(a.cancelled);
          yield* Deferred.await(b.cancelled);
          yield* Deferred.await(a.executorCancelled);
          yield* Deferred.await(b.executorCancelled);
          assert.strictEqual(f.attempts.size, 2);
          assert.strictEqual(f.held.size, 2);
          assert.strictEqual(yield* Queue.size(first.frames), 0);
          assert.strictEqual(yield* Queue.size(other.frames), 0);
          assert.deepStrictEqual(f.peaks, { company: 2, patch: 1 });

          yield* Deferred.succeed(a.release, undefined);
          const replacement = yield* Queue.take(f.started);
          assert.strictEqual(replacement.patchId, "settlement-a");
          assert.isFalse(f.held.has(a));
          assert.isTrue(f.held.has(b));
          assert.strictEqual(f.held.size, 2);
          yield* Deferred.succeed(b.release, undefined);
          const third = yield* Queue.take(f.started);
          assert.strictEqual(third.patchId, "settlement-c");
          assert.deepStrictEqual(f.peaks, { company: 2, patch: 1 });
          assert.isFalse(a.destroyed);
          assert.isFalse(b.destroyed);
          if (disconnect) {
            assert.strictEqual(yield* Queue.size(first.frames), 0);
            assert.strictEqual(yield* Queue.size(other.frames), 0);
          } else {
            for (const document of [first, other]) {
              const frame = yield* document.next;
              assert.strictEqual(frame.type, "error");
              if (frame.type === "error") {
                assert.strictEqual(frame.error.code, "handler_timeout");
                assert.isFalse(frame.permanent);
              }
            }
          }
          // Close every document before releasing the remaining owners during fixture cleanup.
          yield* first.close;
          yield* other.close;
          yield* samePatch.close;
          yield* thirdPatch.close;
        }).pipe(Effect.scoped)
    );
  }

  it.effect(
    "retries an unknown query outcome after the cleanup ceiling destroys its snapshot",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const document = yield* f.attach("unknown", "settlement-unknown");
        yield* document.subscribe;
        const first = yield* Queue.take(f.started);
        yield* TestClock.adjust(yield* ContractLimits.get("tier2.query.deadline"));
        yield* Deferred.await(first.cancelled);
        assert.strictEqual(f.held.size, 1);
        yield* TestClock.adjust(yield* ContractLimits.get("tier2.settlement.cleanup"));
        const error = yield* document.next;
        assert.strictEqual(error.type, "error");
        if (error.type === "error") {
          assert.strictEqual(error.error.code, "unknown_outcome");
          assert.isFalse(error.permanent);
        }
        assert.isTrue(first.destroyed);
        assert.strictEqual(f.held.size, 0);
        yield* TestClock.adjust(250);
        const retry = yield* Queue.take(f.started);
        yield* Deferred.succeed(retry.reply, {
          outcome: "returned",
          guestMs: 1,
          reply: { ok: true, value: "recovered" }
        });
        yield* Deferred.await(retry.cancelled);
        yield* Deferred.succeed(retry.release, undefined);
        assert.deepStrictEqual(yield* document.next, {
          type: "snapshot",
          id: "query",
          revision: "1",
          result: "recovered",
          vector: {}
        });
        assert.strictEqual(f.held.size, 0);
        assert.deepStrictEqual(f.peaks, { company: 1, patch: 1 });
        yield* document.close;
      }).pipe(Effect.scoped)
  );
});
