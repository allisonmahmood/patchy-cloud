import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { MAX_TRACKED_KEYS } from "./Limits.js";
import * as TokenBucket from "./TokenBucket.js";

it.effect("refuses the 201st burst call and refills at 100 calls per second", () =>
  Effect.gen(function* () {
    const limiter = yield* TokenBucket.make;
    const options = { key: "company:one", rate: 100, burst: 200 };
    for (let index = 0; index < 200; index++) {
      assert.isTrue((yield* limiter.consume(options)).allowed);
    }
    assert.deepStrictEqual(yield* limiter.consume(options), {
      allowed: false,
      reason: "rate",
      remaining: 0,
      retryAfterSeconds: 1
    });
    yield* TestClock.adjust(9);
    assert.isFalse((yield* limiter.consume(options)).allowed);
    yield* TestClock.adjust(1);
    assert.isTrue((yield* limiter.consume(options)).allowed);
    assert.isFalse((yield* limiter.consume(options)).allowed);
    yield* TestClock.adjust(1_000);
    for (let index = 0; index < 100; index++) {
      assert.isTrue((yield* limiter.consume(options)).allowed);
    }
    assert.isFalse((yield* limiter.consume(options)).allowed);
    yield* TestClock.adjust(60_000);
    assert.strictEqual((yield* limiter.consume(options)).remaining, 199);
  })
);

it.effect("isolates companies and replicas without admitting concurrent overspend", () =>
  Effect.gen(function* () {
    const first = yield* TokenBucket.make;
    const second = yield* TokenBucket.make;
    const options = { key: "company:one", rate: 100, burst: 200 };
    const attempts = yield* Effect.all(
      Array.from({ length: 201 }, () => first.consume(options)),
      { concurrency: "unbounded" }
    );
    assert.strictEqual(attempts.filter((attempt) => attempt.allowed).length, 200);
    assert.isTrue((yield* first.consume({ ...options, key: "company:two" })).allowed);
    assert.strictEqual((yield* second.consume(options)).remaining, 199);
  })
);

it.effect("changes live rate and burst overrides without resetting spent tokens", () =>
  Effect.gen(function* () {
    const limiter = yield* TokenBucket.make;
    const options = { key: "company:override", rate: 1, burst: 2 };
    yield* limiter.consume(options);
    yield* limiter.consume(options);
    yield* TestClock.adjust(500);
    const raised = { ...options, rate: 2, burst: 4 };
    assert.isFalse((yield* limiter.consume(raised)).allowed);
    yield* TestClock.adjust(250);
    assert.isTrue((yield* limiter.consume(raised)).allowed);
    assert.isFalse((yield* limiter.consume(raised)).allowed);
    yield* TestClock.adjust(2_000);
    assert.strictEqual((yield* limiter.consume(raised)).remaining, 3);
    assert.strictEqual((yield* limiter.consume(options)).remaining, 1);
  })
);

it.effect("does not refill twice when the clock steps backwards", () =>
  Effect.gen(function* () {
    const limiter = yield* TokenBucket.make;
    const options = { key: "company:clock", rate: 1, burst: 1 };
    yield* TestClock.setTime(1_000);
    assert.isTrue((yield* limiter.consume(options)).allowed);
    yield* TestClock.setTime(500);
    assert.isFalse((yield* limiter.consume(options)).allowed);
    yield* TestClock.setTime(1_500);
    assert.isFalse((yield* limiter.consume(options)).allowed);
    yield* TestClock.setTime(2_000);
    assert.isTrue((yield* limiter.consume(options)).allowed);
  })
);

it.effect("fails closed at capacity and reclaims only fully refilled buckets", () =>
  Effect.gen(function* () {
    const limiter = yield* TokenBucket.make;
    for (let index = 0; index < MAX_TRACKED_KEYS; index++) {
      yield* limiter.consume({ key: `company:${index}`, rate: 0.5, burst: 1 });
    }
    const newcomer = { key: "company:new", rate: 1, burst: 1 };
    assert.deepStrictEqual(yield* limiter.consume(newcomer), {
      allowed: false,
      reason: "capacity",
      remaining: 0,
      retryAfterSeconds: 2
    });
    yield* TestClock.adjust(1_000);
    assert.isFalse((yield* limiter.consume(newcomer)).allowed);
    yield* TestClock.adjust(1_000);
    assert.isTrue((yield* limiter.consume(newcomer)).allowed);
  })
);
