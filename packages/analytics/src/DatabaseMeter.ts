import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface Collector {
  /** Start only after acquiring a connection. The returned release is idempotent. */
  readonly start: () => () => void;
  /** Includes open reservations, so a killed invocation need not await cleanup. */
  readonly snapshot: () => number;
}

export const current = Context.Reference<Collector | undefined>(
  "@patchy/analytics/DatabaseMeter/current",
  { defaultValue: () => undefined }
);

/**
 * A nested invocation contributes each reservation to its ancestors once. Each ancestor's
 * interval contains its descendant's, so after release a child never meters more than its parent.
 */
export const make: Effect.Effect<Collector> = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const parent = yield* current;
  const reservations = new Set<{ readonly startedAt: bigint }>();
  let releasedNanos = 0n;
  return {
    start: () => {
      // Ancestors start before this reading and stop after this release's reading.
      const parentRelease = parent?.start();
      const startedAt = clock.monotonicTimeNanosUnsafe();
      // Separate tokens preserve simultaneous reservations starting on the same tick.
      const token = { startedAt };
      let released = false;
      reservations.add(token);
      return () => {
        if (released) return;
        released = true;
        releasedNanos += clock.monotonicTimeNanosUnsafe() - startedAt;
        reservations.delete(token);
        parentRelease?.();
      };
    },
    snapshot: () => {
      const now = clock.monotonicTimeNanosUnsafe();
      let nanos = releasedNanos;
      for (const reservation of reservations) nanos += now - reservation.startedAt;
      return Number(nanos) / 1_000_000;
    }
  };
});
