/**
 * The expiry sweep — the job that makes patch expiry real.
 *
 * A patch whose retention clock has run out already stops serving and
 * refuses updates; the row and its stored HTML are still there, still
 * costing storage, still counting against its creator's quota. The sweep is
 * what finishes the job: for each expired, unpinned patch it hard-deletes the
 * record and then the content behind it. There is no recovery — republishing
 * is the way back.
 *
 * Order is deliberate. The record goes first, so a failure between the two
 * halves leaves unreachable objects rather than a live patch with no content;
 * an orphaned object costs storage, a contentless patch costs the reader the
 * page. Everything else follows from re-reading the database: a run is
 * idempotent, two runs overlapping is safe, and a patch pinned mid-run stays.
 *
 * `sweep` is one run. Deciding when to run is the server's: it forks
 * `Effect.repeat(sweep, Schedule.spaced("1 hour"))` in its scope, which also
 * sweeps once on the way up, when a backlog is most likely.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Analytics } from "@patchy/analytics";
import { ContentStore } from "@patchy/content-store";
import * as Patches from "./Patches.js";

/** How many patches one database listing asks for. */
const BATCH_SIZE = 100;

/**
 * The most patches one run will take. A backlog is drained across runs rather
 * than in one unbounded pass, so the sweep never becomes the thing that
 * stalls a serving process.
 */
const MAX_PER_RUN = 1_000;

export interface SweepResult {
  /** Patches hard-deleted: record gone, content gone. */
  readonly deleted: number;
  /** Patches no longer the sweep's to take — pinned, or already swept. */
  readonly skipped: number;
  /** Patches whose delete failed. They stay expired, and the next run retries. */
  readonly failed: number;
  /** Objects left behind because their delete failed after the record's did not. */
  readonly orphanedObjects: number;
}

export class ExpirySweep extends Context.Service<
  ExpirySweep,
  {
    /** Sweeps what is expired now. Never fails: a patch it cannot take is counted, not thrown. */
    readonly sweep: Effect.Effect<SweepResult>;
  }
>()("@patchy/patches/ExpirySweep") {}

export const make = Effect.gen(function* () {
  const patches = yield* Patches.Patches;
  const store = yield* ContentStore.ContentStore;
  const analytics = yield* Analytics.Analytics;

  /** One patch's share of a run: exactly one of `deleted`, `skipped` or `failed`, plus what it orphaned. */
  const sweepOne = Effect.fn("ExpirySweep.sweepOne")(function* (patchId: string) {
    // Some(None) is a patch no longer the sweep's to take; None is a delete that failed.
    const taken = yield* patches.deleteExpired(patchId).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        SqlError: (error) =>
          Effect.logWarning("Expiry sweep could not delete a patch record.", error).pipe(
            Effect.annotateLogs({ patchId }),
            Effect.as(Option.none())
          )
      })
    );
    if (Option.isNone(taken)) return { deleted: 0, skipped: 0, failed: 1, orphanedObjects: 0 };
    if (Option.isNone(taken.value))
      return { deleted: 0, skipped: 1, failed: 0, orphanedObjects: 0 };
    const keys = taken.value.value;
    let orphanedObjects = 0;

    // Reported once the record is gone, which is the moment the patch stops
    // existing. No principal performed it — the clock ran out.
    yield* analytics.track({
      name: "patch.expired",
      principalId: null,
      properties: { patchId, versionsRemoved: keys.length }
    });

    for (const key of keys) {
      // The record is already gone, so nothing serves this object and no later
      // run will list it again. It is storage to reclaim by hand, not a patch
      // that survived, and it must not fail the rest of the sweep.
      yield* store.delete(key).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Expiry sweep orphaned a stored object.", error).pipe(
            Effect.annotateLogs({ patchId, objectKey: key }),
            Effect.map(() => {
              orphanedObjects += 1;
            })
          )
        )
      );
    }
    return { deleted: 1, skipped: 0, failed: 0, orphanedObjects } satisfies SweepResult;
  });

  const sweep = Effect.gen(function* () {
    let result: SweepResult = { deleted: 0, skipped: 0, failed: 0, orphanedObjects: 0 };
    let attempted = 0;

    while (attempted < MAX_PER_RUN) {
      const batchLimit = Math.min(BATCH_SIZE, MAX_PER_RUN - attempted);
      const patchIds = yield* patches
        .listExpired(batchLimit)
        .pipe(Effect.catchTags({ SqlError: Effect.die }));
      if (patchIds.length === 0) break;

      const deletedBefore = result.deleted;
      for (const patchId of patchIds) {
        attempted += 1;
        const one = yield* sweepOne(patchId);
        result = {
          deleted: result.deleted + one.deleted,
          skipped: result.skipped + one.skipped,
          failed: result.failed + one.failed,
          orphanedObjects: result.orphanedObjects + one.orphanedObjects
        };
      }

      // A short batch is the end of the backlog. A full batch that deleted
      // nothing is a batch the next listing would hand back unchanged, so stop
      // rather than spin on patches this run cannot take.
      if (patchIds.length < batchLimit || result.deleted === deletedBefore) break;
    }

    return result;
  }).pipe(Effect.withSpan("ExpirySweep.sweep"));

  return ExpirySweep.of({ sweep });
});

/** Over `Patches`, the content store and analytics. */
export const layer = Layer.effect(ExpirySweep, make);
