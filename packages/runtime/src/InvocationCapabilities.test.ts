import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import * as InvocationCapabilities from "./InvocationCapabilities.js";
import * as Fixtures from "./test/callbacks.js";
import { NodeCryptography } from "@patchy/core";

it.effect("capabilities keep their original attempt and explain every ended reason", () =>
  Effect.gen(function* () {
    const capabilities = yield* InvocationCapabilities.make;
    const otherReplica = yield* InvocationCapabilities.make;
    for (const reason of ["returned", "deadline", "superseded", "process_killed"] as const) {
      const attempt = {
        invocationId: "inv_test",
        attemptId: "one",
        processGeneration: 7,
        deadline: (yield* Clock.currentTimeMillis) + 60_000
      };
      const capability = yield* Fixtures.issue(capabilities, { attempt });
      attempt.attemptId = "two";
      assert.strictEqual(capability.attempt.attemptId, "one");
      for (const mismatch of [
        { ...capability.attempt, invocationId: "inv_other" },
        { ...capability.attempt, attemptId: "two" },
        { ...capability.attempt, processGeneration: 8 }
      ])
        assert.strictEqual(
          (yield* capabilities.resolve(capability.token, mismatch).pipe(Effect.flip)).reason,
          "attempt_mismatch"
        );
      assert.strictEqual(
        (yield* otherReplica.resolve(capability.token, capability.attempt).pipe(Effect.flip))
          .reason,
        "unknown"
      );
      yield* capabilities.end(capability.token, reason);
      yield* capabilities.end(capability.token, "process_killed");
      const refusal = yield* capabilities
        .resolve(capability.token, capability.attempt)
        .pipe(Effect.flip);
      assert.strictEqual(refusal.reason, reason);
      assert.include(refusal.failure.error, reason);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

it.effect("the deadline fences callbacks without a caller asking to settle", () =>
  Effect.gen(function* () {
    const capabilities = yield* InvocationCapabilities.make;
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const capability = yield* Fixtures.issue(capabilities, {
      attempt: {
        invocationId: "inv_deadline",
        attemptId: "one",
        processGeneration: 1,
        deadline: (yield* Clock.currentTimeMillis) + 10
      }
    });
    const callback = yield* capabilities
      .execute(
        capability,
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(interrupted, undefined))
        )
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust(10);
    yield* Deferred.await(interrupted);
    yield* Fiber.join(callback);
    assert.strictEqual(
      (yield* capabilities.resolve(capability.token, capability.attempt).pipe(Effect.flip)).reason,
      "deadline"
    );
    assert.isTrue(yield* capabilities.settle(capability.token, "returned"));
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

it.effect("interrupting a started effect is not confirmation that it did not commit", () =>
  Effect.gen(function* () {
    const capabilities = yield* InvocationCapabilities.make;
    const capability = yield* Fixtures.issue(capabilities);
    const started = yield* Deferred.make<void>();
    const callback = yield* capabilities
      .execute(
        capability,
        capabilities.performEffect(
          capability,
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        )
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);
    assert.isFalse(yield* capabilities.settle(capability.token, "returned"));
    yield* Fiber.join(callback);
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

it.effect(
  "unresolved resources are destroyed at the cleanup bound and never reported settled",
  () =>
    Effect.gen(function* () {
      const capabilities = yield* InvocationCapabilities.make;
      const capability = yield* Fixtures.issue(capabilities);
      const cancelled = yield* Deferred.make<void>();
      let destroyed = 0;
      yield* capabilities.retain(capability.token, capability.attempt, {
        cancel: Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid),
        settled: Effect.never,
        destroy: () => {
          destroyed++;
        }
      });
      const settling = yield* capabilities
        .settle(capability.token, "deadline", 5)
        .pipe(Effect.forkChild);
      yield* Deferred.await(cancelled);
      assert.strictEqual(destroyed, 0);
      yield* TestClock.adjust(5);
      assert.isFalse(yield* Fiber.join(settling));
      assert.strictEqual(destroyed, 1);
      assert.strictEqual(
        (yield* capabilities.resolve(capability.token, capability.attempt).pipe(Effect.flip))
          .reason,
        "deadline"
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

it.effect("unfinished cancellation is destroyed even after the outcome signal resolves", () =>
  Effect.gen(function* () {
    const capabilities = yield* InvocationCapabilities.make;
    const capability = yield* Fixtures.issue(capabilities);
    const outcome = yield* Deferred.make<void>();
    const cancellationStopped = yield* Deferred.make<void>();
    let destroyed = false;
    yield* capabilities.retain(capability.token, capability.attempt, {
      cancel: Deferred.succeed(outcome, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(cancellationStopped, undefined))
      ),
      settled: Deferred.await(outcome),
      destroy: () => {
        destroyed = true;
      }
    });
    const settling = yield* capabilities
      .settle(capability.token, "deadline", 5)
      .pipe(Effect.forkChild);
    yield* Deferred.await(outcome);
    yield* TestClock.adjust(5);
    assert.isFalse(yield* Fiber.join(settling));
    assert.isTrue(destroyed);
    yield* Deferred.await(cancellationStopped);
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

it.effect("resolved cancellation releases the invocation without destroying the resource", () =>
  Effect.gen(function* () {
    const capabilities = yield* InvocationCapabilities.make;
    const capability = yield* Fixtures.issue(capabilities);
    const settled = yield* Deferred.make<void>();
    let destroyed = false;
    yield* capabilities.retain(capability.token, capability.attempt, {
      cancel: Deferred.succeed(settled, undefined).pipe(Effect.asVoid),
      settled: Deferred.await(settled),
      destroy: () => {
        destroyed = true;
      }
    });
    assert.isTrue(yield* capabilities.settle(capability.token, "returned"));
    assert.isFalse(destroyed);
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

it.effect("the scope sweeps replay tombstones after their configured retention", () =>
  Effect.gen(function* () {
    const capabilities = yield* InvocationCapabilities.make;
    const capability = yield* Fixtures.issue(capabilities);
    yield* capabilities.end(capability.token, "superseded");
    assert.strictEqual(
      (yield* capabilities.resolve(capability.token, capability.attempt).pipe(Effect.flip)).reason,
      "superseded"
    );
    yield* TestClock.adjust(5);
    assert.strictEqual(
      (yield* capabilities.resolve(capability.token, capability.attempt).pipe(Effect.flip)).reason,
      "unknown"
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ PATCHY_LIMITS_JSON: '{"tier2.capability.tombstone":5}' })
      )
    ),
    Effect.provide(NodeCryptography.layer)
  )
);

/**
 * The hand-off from a callback's waiter to the work the service owns, cut at every step: the
 * waiter yields after each operation, and the test interrupts it, or ends the action, that many
 * steps in. Whatever was handed off is in the set the action's end cancels, and its settlement
 * runs exactly once, whether the work ran, was cancelled, or never started.
 */
it.effect("a waiter interrupted at the hand-off leaves no work the action's end can't cancel", () =>
  Effect.gen(function* () {
    const capabilities = yield* InvocationCapabilities.make;
    for (const budget of [1, 2, 3, 2048]) {
      const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
      let started = 0;
      let cancelled = 0;
      const waiter = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      // The work's first step is the page's request going away: its waiter is interrupted the
      // moment the work it handed off begins.
      const work = Effect.gen(function* () {
        started++;
        (yield* Deferred.await(waiter)).interruptUnsafe();
        return yield* Effect.never;
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => void cancelled++)));
      yield* Deferred.succeed(
        waiter,
        yield* Effect.forkChild(
          capabilities
            .execute(capability, work)
            .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))
        )
      );
      while (started === 0) yield* Effect.yieldNow;
      for (let wait = 0; wait < 5; wait++) yield* Effect.yieldNow;
      // The action ends: the work it handed off is cancelled with it.
      yield* capabilities.settle(capability.token, "returned", 1_000);
      assert.strictEqual(cancelled, started, `budget ${budget}`);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);

it.effect("work cancelled before its first step still gives its place back, once", () =>
  Effect.gen(function* () {
    const capabilities = yield* InvocationCapabilities.make;
    for (let step = 0; step < 12; step++) {
      const capability = yield* Fixtures.issue(capabilities, { kind: "action" });
      let taken = 0;
      let given = 0;
      const hold = {
        take: () => {
          taken++;
          return true;
        },
        give: () => {
          given++;
        }
      };
      // On the ordinary budget the waiter forks and registers in one run, and the action's end,
      // queued ahead of the new work, reaches it before its first step.
      const waiter = yield* Effect.forkChild(capabilities.execute(capability, Effect.never, hold));
      for (let wait = 0; wait < step; wait++) yield* Effect.yieldNow;
      // The action ends: the work it owns is cancelled wherever its hand-off had got to.
      yield* capabilities.end(capability.token, "returned");
      yield* Fiber.await(waiter);
      yield* capabilities.settle(capability.token, "returned", 1_000);
      assert.isAtMost(taken, 1, `step ${step}`);
      assert.strictEqual(given, taken, `step ${step}`);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeCryptography.layer))
);
