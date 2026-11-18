import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as CallGate from "./CallGate.js";

const one = { concurrent: 1, perPerson: 1, waiting: 8, perPersonWaiting: 8 };
const key = (person: string) => ({ connection: "provider", person });
const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

it.effect("people take turns: one person's burst queues behind itself", () =>
  Effect.gen(function* () {
    const gate = CallGate.make(one);
    const order: Array<string> = [];
    const held = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      gate.run(key("a"), 1_000_000, () => Deferred.await(held))
    );
    yield* settle;
    const queued = [];
    for (const [person, name] of [
      ["a", "a2"],
      ["a", "a3"],
      ["b", "b1"],
      ["c", "c1"]
    ] as const) {
      queued.push(
        yield* Effect.forkChild(
          gate.run(key(person), 1_000_000, () => Effect.sync(() => order.push(name)))
        )
      );
      yield* settle;
    }
    yield* Deferred.succeed(held, undefined);
    yield* Fiber.join(first);
    for (const fiber of queued) yield* Fiber.join(fiber);
    assert.deepStrictEqual(order, ["a2", "b1", "c1", "a3"]);
  })
);

it.effect("a full waiting room refuses at once, the person's before the connection's", () =>
  Effect.gen(function* () {
    const gate = CallGate.make({ ...one, waiting: 2, perPersonWaiting: 1 });
    const held = yield* Deferred.make<void>();
    yield* Effect.forkChild(gate.run(key("a"), 1_000_000, () => Deferred.await(held)));
    yield* settle;
    yield* Effect.forkChild(gate.run(key("a"), 1_000_000, () => Effect.void));
    yield* settle;
    const personFull = yield* Effect.flip(gate.run(key("a"), 1_000_000, () => Effect.void));
    assert.strictEqual(personFull.limit, "personWaiting");
    yield* Effect.forkChild(gate.run(key("b"), 1_000_000, () => Effect.void));
    yield* settle;
    const roomFull = yield* Effect.flip(gate.run(key("c"), 1_000_000, () => Effect.void));
    assert.strictEqual(roomFull.limit, "waiting");
    assert.strictEqual(roomFull.waitedMs, 0);
  })
);

it.effect("a waiter gives up at its cut-off, and its place is not lost", () =>
  Effect.gen(function* () {
    const gate = CallGate.make(one);
    const held = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(
      gate.run(key("a"), 1_000_000, () => Deferred.await(held))
    );
    yield* settle;
    const waiter = yield* Effect.forkChild(Effect.flip(gate.run(key("b"), 100, () => Effect.void)));
    yield* settle;
    yield* TestClock.adjust(100);
    const refused = yield* Fiber.join(waiter);
    assert.strictEqual(refused.limit, "concurrent");
    assert.strictEqual(refused.waitedMs, 100);
    yield* Deferred.succeed(held, undefined);
    yield* Fiber.join(first);
    // The connection is free again: the next call goes straight through.
    const through = yield* gate.run(key("c"), 1_000_000, (admitted) => Effect.succeed(admitted));
    assert.strictEqual(through.waitedMs, 0);
  })
);
