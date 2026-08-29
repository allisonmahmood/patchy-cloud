import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import * as Limits from "./Limits.js";

const consume = (key: string, limit = 2) =>
  Effect.flatMap(Limits.Limits, (limits) => limits.consume({ key, limit, window: "1 second" }));

it.layer(Limits.layer)("Limits", (it) => {
  it.effect("refuses over-limit attempts with a Retry-After until the exact reset boundary", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      assert.deepStrictEqual(yield* consume("client"), {
        allowed: true,
        remaining: 1,
        retryAfterSeconds: 0
      });
      assert.deepStrictEqual(yield* consume("client"), {
        allowed: true,
        remaining: 0,
        retryAfterSeconds: 0
      });
      assert.deepStrictEqual(yield* consume("client"), {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 1
      });

      yield* TestClock.setTime(1_999);
      assert.isFalse((yield* consume("client")).allowed);

      yield* TestClock.setTime(2_000);
      assert.deepStrictEqual(yield* consume("client"), {
        allowed: true,
        remaining: 1,
        retryAfterSeconds: 0
      });
    })
  );

  it.effect("keys are independent and Retry-After rounds up to whole seconds", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      yield* consume("one", 1);
      yield* TestClock.setTime(10_100);
      assert.deepStrictEqual(yield* consume("two", 1), {
        allowed: true,
        remaining: 0,
        retryAfterSeconds: 0
      });
      assert.strictEqual((yield* consume("one", 1)).retryAfterSeconds, 1);
      // A minute-long window reports the full minute on its first refusal.
      const minute = Effect.flatMap(Limits.Limits, (limits) =>
        limits.consume({ key: "minute", limit: 1, window: "1 minute" })
      );
      yield* minute;
      assert.strictEqual((yield* minute).retryAfterSeconds, 60);
    })
  );

  it.effect("fails closed at the tracked-key cap until an expired window frees a slot", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(100_000);
      for (let index = 0; index < Limits.MAX_TRACKED_KEYS; index += 1) {
        assert.isTrue((yield* consume(`flood-${index}`, 1)).allowed);
      }
      // Never seen before, and no room: refused, and told when room opens.
      assert.deepStrictEqual(yield* consume("late", 1), {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 1
      });
      // A key already tracked is still served from its own window.
      assert.isFalse((yield* consume("flood-0", 1)).allowed);

      yield* TestClock.setTime(101_000);
      assert.isTrue((yield* consume("late", 1)).allowed);
    })
  );
});
