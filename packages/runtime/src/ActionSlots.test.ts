import { assert, it } from "@effect/vitest";
import { OperatingLimits } from "@patchy/limits";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as ActionSlots from "./ActionSlots.js";
import * as Runtime from "./Runtime.js";

const limit = (limitId: string, value: number) =>
  new OperatingLimits.EffectiveLimit({
    companyId: "cmp_slots",
    limitId,
    value,
    overrideValue: null,
    configRevision: new OperatingLimits.ConfigRevision({
      deploymentRevision: "test",
      overrideRevision: "0"
    })
  });
const actions = (company: number, viewer: number) => ({
  company: limit("tier2.actions.company", company),
  viewer: limit("tier2.actions.viewer", viewer)
});
const models = (company: number, viewer: number) => ({
  company: limit("tier2.models.company", company),
  viewer: limit("tier2.models.viewer", viewer)
});

const person = (userId: string, holder: Partial<ActionSlots.Holder> = {}): ActionSlots.Holder => ({
  companyId: "cmp_slots",
  patchId: "pch_slots",
  userId,
  caller: "page",
  ...holder
});
const alice = person("usr_alice");
const bob = person("usr_bob");

/** The limit that refused, the tag of a refusal that names none, or `null` for no refusal. */
const refusal = (
  effect: Effect.Effect<
    unknown,
    ActionSlots.InvocationBusy | ActionSlots.ModelPoolBusy | ActionSlots.SlotReleased
  >
) =>
  Effect.match(effect, {
    onFailure: (error) => (error._tag === "SlotReleased" ? error._tag : error.limitId),
    onSuccess: () => null
  });

/** One replica's slots under fixed limits, with probes that take a place and give it straight back. */
const replica = (
  options: {
    readonly replica?: number;
    readonly actions?: ActionSlots.Limits;
    readonly models?: ActionSlots.Limits;
  } = {}
) => {
  const slots = ActionSlots.make({ replica: options.replica ?? 64 });
  const ordinary = options.actions ?? actions(8, 2);
  const pool = options.models ?? models(24, 4);
  const admit = (holder: ActionSlots.Holder) => slots.admit(holder, ordinary);
  const transfer = (slot: ActionSlots.Slot) => slot.transfer(pool);
  return {
    admit,
    transfer,
    /** An action that has moved to the pool, held until the test releases it. */
    pooled: (holder: ActionSlots.Holder) => admit(holder).pipe(Effect.tap(transfer)),
    /** An action as Invocation runs one: its slot is released when it ends, however it ends. */
    action: <A, E>(
      holder: ActionSlots.Holder,
      body: (slot: ActionSlots.Slot) => Effect.Effect<A, E>
    ) =>
      admit(holder).pipe(Effect.flatMap((slot) => body(slot).pipe(Effect.ensuring(slot.release)))),
    canAdmit: (holder: ActionSlots.Holder) =>
      refusal(admit(holder).pipe(Effect.flatMap((slot) => slot.release))),
    canTransfer: (holder: ActionSlots.Holder) =>
      refusal(
        admit(holder).pipe(
          Effect.flatMap((slot) => transfer(slot).pipe(Effect.ensuring(slot.release)))
        )
      )
  };
};
type Replica = ReturnType<typeof replica>;

it.effect(
  "moves an action to the model pool once, freeing its action slot, and holds its place until it ends",
  () =>
    Effect.gen(function* () {
      const r = replica({ actions: actions(8, 1), models: models(24, 1) });
      const calling = yield* r.admit(alice);
      assert.strictEqual(yield* r.canAdmit(alice), "tier2.actions.viewer");
      yield* r.transfer(calling);
      // While it waits on a model, alice's quick actions have her action slot.
      assert.strictEqual(yield* r.canAdmit(alice), null);
      assert.strictEqual(yield* r.canTransfer(alice), "tier2.models.viewer");
      // Its later model calls change nothing: nothing moves back.
      yield* r.transfer(calling);
      assert.strictEqual(yield* r.canAdmit(alice), null);
      yield* calling.release;
      assert.strictEqual(yield* r.canTransfer(alice), null);
    })
);

it.effect("a refused transfer keeps the action's slot and answers busy naming the limit", () =>
  Effect.gen(function* () {
    const r = replica({ actions: actions(8, 1), models: models(24, 1) });
    const waiting = yield* r.pooled(alice);
    const next = yield* r.admit(alice);
    const busy = yield* Effect.flip(r.transfer(next));
    if (busy._tag !== "ModelPoolBusy")
      return assert.fail(`Expected ModelPoolBusy, got ${busy._tag}`);
    assert.deepInclude(Runtime.toFailure(busy), {
      code: "busy",
      limitId: "tier2.models.viewer",
      scope: "viewer",
      value: 1,
      retryAfter: 1
    });
    // It still holds its action slot, so alice's next action is refused for it.
    assert.strictEqual(yield* r.canAdmit(alice), "tier2.actions.viewer");
    // Once the pool has room, its next model call moves it.
    yield* waiting.release;
    yield* r.transfer(next);
    assert.strictEqual(yield* r.canAdmit(alice), null);
  })
);

it.effect("the viewer and company limits each refuse on their own", () =>
  Effect.gen(function* () {
    const r = replica({ models: models(3, 2) });
    // A person's place counts across their patches, pages and worker agent.
    yield* r.pooled(alice);
    yield* r.pooled(person("usr_alice", { patchId: "pch_other", caller: "agent" }));
    assert.strictEqual(yield* r.canTransfer(alice), "tier2.models.viewer");
    // The company still has room for bob, and then for no one.
    yield* r.pooled(bob);
    assert.strictEqual(yield* r.canTransfer(person("usr_carol")), "tier2.models.company");
  })
);

it.effect("the replica's limit refuses across companies", () =>
  Effect.gen(function* () {
    const r = replica({ replica: 2 });
    yield* r.pooled(person("usr_alice", { companyId: "cmp_one" }));
    yield* r.pooled(person("usr_bob", { companyId: "cmp_two" }));
    assert.strictEqual(
      yield* r.canTransfer(person("usr_carol", { companyId: "cmp_three" })),
      "tier2.models.replica"
    );
  })
);

/** Asserts, from inside alice's action, that it holds the last of her two pool places. */
const holdsPlace = (r: Replica) =>
  Effect.map(r.canTransfer(alice), (refused) => assert.strictEqual(refused, "tier2.models.viewer"));

const endings: Record<string, (r: Replica) => Effect.Effect<unknown, unknown>> = {
  "it succeeds": (r) =>
    r.action(alice, (slot) => r.transfer(slot).pipe(Effect.andThen(holdsPlace(r)))),
  "its model call is refused after the transfer": (r) =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        r.action(alice, (slot) =>
          r
            .transfer(slot)
            .pipe(
              Effect.andThen(holdsPlace(r)),
              Effect.andThen(Effect.fail("source_rate_limited" as const))
            )
        )
      );
      assert.strictEqual(refused, "source_rate_limited");
    }),
  "it times out": (r) =>
    Effect.gen(function* () {
      const moved = yield* Deferred.make<void>();
      const fiber = yield* r
        .action(alice, (slot) =>
          r
            .transfer(slot)
            .pipe(
              Effect.andThen(holdsPlace(r)),
              Effect.andThen(Deferred.succeed(moved, undefined)),
              Effect.andThen(Effect.never)
            )
        )
        .pipe(Effect.timeout("60 seconds"), Effect.forkChild);
      yield* Deferred.await(moved);
      yield* TestClock.adjust("60 seconds");
      assert.strictEqual((yield* Effect.flip(Fiber.join(fiber)))._tag, "TimeoutError");
    }),
  "it is cancelled": (r) =>
    Effect.gen(function* () {
      const moved = yield* Deferred.make<void>();
      const fiber = yield* r
        .action(alice, (slot) =>
          r
            .transfer(slot)
            .pipe(
              Effect.andThen(holdsPlace(r)),
              Effect.andThen(Deferred.succeed(moved, undefined)),
              Effect.andThen(Effect.never)
            )
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(moved);
      yield* Fiber.interrupt(fiber);
    }),
  "it crashes": (r) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        r.action(alice, (slot) =>
          r.transfer(slot).pipe(Effect.andThen(holdsPlace(r)), Effect.andThen(Effect.die("crash")))
        )
      );
      assert.isTrue(Exit.hasDies(exit));
    })
};

for (const [ending, run] of Object.entries(endings))
  it.effect(`frees the action's pool place exactly once when ${ending}`, () =>
    Effect.gen(function* () {
      const r = replica({ models: models(24, 2) });
      yield* r.pooled(alice);
      yield* run(r).pipe(Effect.orDie);
      // One place came back, not two: one more of alice's actions fits, and the next does not.
      yield* r.pooled(alice);
      assert.strictEqual(yield* r.canTransfer(alice), "tier2.models.viewer");
    })
  );

it.effect("two first model calls arriving at once make one transfer", () =>
  Effect.gen(function* () {
    const r = replica({ actions: actions(8, 2), models: models(24, 2) });
    const calling = yield* r.admit(alice);
    const quick = yield* r.admit(alice);
    yield* Effect.all([r.transfer(calling), r.transfer(calling)], {
      concurrency: "unbounded",
      discard: true
    });
    // It freed one action slot, so alice's quick action still holds the other.
    yield* r.admit(alice);
    assert.strictEqual(yield* r.canAdmit(alice), "tier2.actions.viewer");
    // And it took one pool place, leaving the second for the quick action.
    yield* r.transfer(quick);
    assert.strictEqual(yield* r.canTransfer(alice), "tier2.models.viewer");
  })
);

it.effect("release after the fence is idempotent and a late transfer takes nothing", () =>
  Effect.gen(function* () {
    const r = replica({ actions: actions(8, 2), models: models(24, 2) });
    const fenced = yield* r.pooled(alice);
    yield* r.pooled(alice);
    yield* fenced.release;
    yield* fenced.release;
    assert.strictEqual(yield* refusal(r.transfer(fenced)), "SlotReleased");
    // Exactly one pool place came back.
    yield* r.pooled(alice);
    assert.strictEqual(yield* r.canTransfer(alice), "tier2.models.viewer");
    // An action fenced before any model call frees exactly its one action slot.
    const quick = yield* r.admit(alice);
    yield* r.admit(alice);
    yield* quick.release;
    yield* quick.release;
    yield* r.admit(alice);
    assert.strictEqual(yield* r.canAdmit(alice), "tier2.actions.viewer");
  })
);
