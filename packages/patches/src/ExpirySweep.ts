/**
 * The expiry sweep — the job that makes patch expiry real.
 *
 * A patch whose retention clock has run out already stops serving and
 * refuses updates; the row and its stored HTML are still there, still
 * costing storage, still counting against its creator's quota. The sweep is
 * what finishes the job: for each expired patch it hard-deletes the record
 * and durably queues the content behind it for removal. There is no recovery
 * — republishing is the way back.
 *
 * It also reclaims expired publication intents. Claiming an intent fences
 * out a late version transaction; committing a version consumes its intent.
 * Store deletion happens without a database lock, and only a successful
 * delete forgets the claimed key. Failures and interrupted runs therefore
 * retry without risking committed content.
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
  /** Patches hard-deleted, with their content durably queued for removal. */
  readonly deleted: number;
  /** Patches no longer the sweep's to take — already swept. */
  readonly skipped: number;
  /** Patches whose delete failed. They stay expired, and the next run retries. */
  readonly failed: number;
  /** Objects whose cleanup failed; their durable intents remain for retry. */
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

  /** One patch's share of a run: exactly one of `deleted`, `skipped` or `failed`. */
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

    // Reported once the record is gone, which is the moment the patch stops
    // existing. No principal performed it — the clock ran out.
    yield* analytics.track({
      name: "patch.expired",
      principalId: null,
      properties: { patchId, versionsRemoved: keys.length }
    });

    return { deleted: 1, skipped: 0, failed: 0, orphanedObjects: 0 } satisfies SweepResult;
  });

  const reclaimObjects = Effect.fn("ExpirySweep.reclaimObjects")(function* () {
    const keys = yield* patches.claimObjects(MAX_PER_RUN).pipe(
      Effect.catchTags({
        SqlError: (error) =>
          Effect.logWarning("Expiry sweep could not claim stored objects.", error).pipe(
            Effect.as([])
          )
      })
    );
    let failed = 0;
    // Claim only once per run: a failing store must not spin on the same keys.
    for (const key of keys) {
      yield* store.delete(key).pipe(
        Effect.andThen(patches.completeObject(key)),
        Effect.catch((error) =>
          Effect.logWarning("Expiry sweep could not reclaim a stored object.", error).pipe(
            Effect.annotateLogs({ objectKey: key }),
            Effect.map(() => {
              failed += 1;
            })
          )
        )
      );
    }
    return failed;
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
    result = { ...result, orphanedObjects: yield* reclaimObjects() };

    return result;
  }).pipe(Effect.withSpan("ExpirySweep.sweep"));

  return ExpirySweep.of({ sweep });
});

/** Over `Patches`, the content store and analytics. */
export const layer = Layer.effect(ExpirySweep, make);
