// PROTOTYPE for #313, not for merge.
// The after-commit wake: keys only, never rows. One replica, so an in-process listener set
// is sufficient; the per-key revision counter is the in-memory stand-in for durable
// per-table revisions (the named upgrade when the server runs more than one replica).
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Runs in the writer's fiber right after commit; must be cheap (an unbounded queue offer). */
export type Listener = (keys: ReadonlyArray<string>) => Effect.Effect<void>;

export class PrototypeInvalidation extends Context.Service<
  PrototypeInvalidation,
  {
    /** Called by Runtime.dispatch after a mutation's record returns success. */
    readonly notify: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
    /** Registers a wake listener; the returned effect removes it. */
    readonly subscribe: (listener: Listener) => Effect.Effect<Effect.Effect<void>>;
    /** Current in-memory revision of a key; 0 when never written in this process. */
    readonly revision: (key: string) => number;
    /** Process-scoped epoch so a client can tell revisions from a previous process apart. */
    readonly epoch: string;
    readonly wakes: () => number;
  }
>()("@patchy/runtime/PrototypeInvalidation") {}

export const make = Effect.gen(function* () {
  const started = yield* Clock.currentTimeMillis;
  const listeners = new Set<Listener>();
  const revisions = new Map<string, number>();
  let wakes = 0;
  return PrototypeInvalidation.of({
    notify: (keys) =>
      Effect.gen(function* () {
        wakes += 1;
        for (const key of keys) revisions.set(key, (revisions.get(key) ?? 0) + 1);
        for (const listener of [...listeners]) yield* listener(keys);
      }),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return Effect.sync(() => {
          listeners.delete(listener);
        });
      }),
    revision: (key) => revisions.get(key) ?? 0,
    epoch: `${process.pid}-${started.toString(36)}`,
    wakes: () => wakes
  });
});

export const layer = Layer.effect(PrototypeInvalidation, make);
