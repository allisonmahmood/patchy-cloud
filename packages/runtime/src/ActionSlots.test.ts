import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ActionSlots from "./ActionSlots.js";

const limits = { company: 1, viewer: 1 };
const settle = Effect.repeat(Effect.yieldNow, { times: 20 });
const slotOf = (admission: ActionSlots.Admission) => {
  if (admission.result.refused !== undefined)
    throw new Error(`refused: ${admission.result.refused}`);
  return admission.result.slot;
};

/** X parks on a model call, Y takes the freed slot, then X's answer comes back. */
const resumeWhileFull = (mode: ActionSlots.Mode) =>
  Effect.gen(function* () {
    const slots = ActionSlots.make(mode);
    const x = slotOf(slots.admit("company", "x", "x", limits));
    const answer = yield* Deferred.make<string>();
    const parked = yield* Effect.forkChild(x.park(Deferred.await(answer)));
    yield* settle;
    const y = slotOf(slots.admit("company", "y", "y", limits));
    yield* Deferred.succeed(answer, "answered");
    yield* settle;
    const refused = slots.admit("company", "z", "z", limits).result.refused;
    return { slots, x, y, parked, refused };
  });

it.effect("today: a model call keeps the action's slot", () =>
  Effect.gen(function* () {
    const slots = ActionSlots.make("today");
    const x = slotOf(slots.admit("company", "x", "x", limits));
    yield* x.park(Effect.void);
    assert.strictEqual(slots.admit("company", "y", "y", limits).result.refused, "company");
  })
);

it.effect("park-r1: the answer resumes at once, past the cap", () =>
  Effect.gen(function* () {
    const { x, parked, refused } = yield* resumeWhileFull("park-r1");
    assert.strictEqual(yield* Fiber.join(parked), "answered");
    assert.strictEqual(x.report.running, 2);
    assert.strictEqual(refused, "company");
  })
);

it.effect("park-r2: the answer waits for a slot, and a new action can't take it first", () =>
  Effect.gen(function* () {
    const { slots, x, y, parked, refused } = yield* resumeWhileFull("park-r2");
    assert.isUndefined(parked.pollUnsafe());
    assert.strictEqual(x.report.held, 1);
    assert.strictEqual(refused, "company");
    yield* y.release;
    assert.strictEqual(yield* Fiber.join(parked), "answered");
    assert.strictEqual(x.report.running, 1);
    // X holds the slot it was handed until it ends.
    assert.strictEqual(slots.admit("company", "z", "z", limits).result.refused, "company");
    yield* x.release;
    assert.isUndefined(slots.admit("company", "z", "z", limits).result.refused);
  })
);

it.effect("park-r2: an action that ends while its answer is held lets the answer go", () =>
  Effect.gen(function* () {
    const { slots, x, parked } = yield* resumeWhileFull("park-r2");
    yield* x.release;
    yield* Fiber.join(parked);
    assert.strictEqual(slots.admit("company", "z", "z", limits).result.refused, "company");
  })
);

it.effect("pool: the first model call moves the action out of the ordinary slots, for good", () =>
  Effect.gen(function* () {
    const slots = ActionSlots.make("pool", { company: 1, person: 1 });
    const x = slotOf(slots.admit("company", "x", "x", limits));
    const answer = yield* Deferred.make<void>();
    const first = yield* Effect.forkChild(x.park(Deferred.await(answer)));
    yield* settle;
    // A concurrent call of the same action changes nothing; it is already in the pool.
    yield* x.park(Effect.void);
    yield* Deferred.succeed(answer, undefined);
    yield* Fiber.join(first);
    // Its ordinary slot is free for others, though it carries on in the pool.
    const y = slotOf(slots.admit("company", "y", "y", limits));
    // The pool is full: Y's model call is refused before it runs, and Y keeps its slot.
    const refused = yield* Effect.flip(y.park(Effect.die("never sent")));
    assert.strictEqual(refused.limitId, "tier2.models.company");
    assert.strictEqual(y.report.poolRefused, 1);
    assert.strictEqual(slots.admit("company", "z", "z", limits).result.refused, "company");
    yield* x.release;
    // X's end frees its pool place, so Y's next call moves it.
    yield* y.park(Effect.void);
    assert.strictEqual(y.report.pooled, 1);
    assert.isUndefined(slots.admit("company", "z", "z", limits).result.refused);
  })
);
