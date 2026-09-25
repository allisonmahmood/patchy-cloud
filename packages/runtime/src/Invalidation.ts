// PROTOTYPE for #314 round 3 (the after-commit wake lifted from #313's prototype, PR #343).
//
// Keys only, never rows: `table:<patch>/<name>` when a commit touched a table, and
// `version:<patch>` when the dev loop rebinds a server bundle. One process, so the bus is a
// module-level listener set shared by the runtime's dispatch (tier 1 writes), ServerCall (a
// tier 2 mutation's committed writes) and the subscription stream. #313 decided durable
// per-table revisions for v1; this in-memory bus is the prototype's shortcut, as it was there.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Runs in the writer's fiber right after commit; must be cheap (an unbounded queue offer). */
export type Listener = (keys: ReadonlyArray<string>) => Effect.Effect<void>;

const listeners = new Set<Listener>();
let wakes = 0;

export const tableKey = (patchId: string, table: string) => `table:${patchId}/${table}`;
export const versionKey = (patchId: string) => `version:${patchId}`;

/** Wakes every listener with the keys a commit touched. */
export const notify = (keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (keys.length === 0) return;
    wakes += 1;
    for (const listener of [...listeners]) yield* listener(keys);
  });

/** Registers a listener; the returned effect removes it. */
export const subscribe = (listener: Listener) =>
  Effect.sync(() => {
    listeners.add(listener);
    return Effect.sync(() => {
      listeners.delete(listener);
    });
  });

export const wakeCount = () => wakes;

/**
 * Set by the subscription stream around one re-run of a tier 2 query. ServerCall refuses any
 * handler that is not a query while it is set, and adds the table keys the run's callbacks
 * touched (table grain, shared aliases resolved to the owner's table), so the query's
 * dependencies are what it read on this run, never a declaration.
 */
export const Subscribed = Context.Reference<{ readonly dependencies: Set<string> } | undefined>(
  "@patchy/runtime/Invalidation/Subscribed",
  { defaultValue: () => undefined }
);
