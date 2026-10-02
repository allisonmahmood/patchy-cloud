import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as DatabaseMeter from "./DatabaseMeter.js";

// Readings land 1µs apart, except the `stalls` readings after the first, which each land 30µs
// late like a GC pause. TestClock cannot stall between the synchronous readings inside start().
const stallingClock = (stalls: number) =>
  Effect.map(Clock.Clock, (clock): Clock.Clock => {
    let now = 0n;
    let readings = 0;
    return {
      ...clock,
      monotonicTimeNanosUnsafe: () => {
        const stalled = readings > 0 && readings <= stalls;
        readings++;
        return (now += stalled ? 30_000n : 1_000n);
      }
    };
  });

const childOf = (parent: DatabaseMeter.Collector) =>
  DatabaseMeter.make.pipe(Effect.provideService(DatabaseMeter.current, parent));

it.effect("a parent's metered time contains its child's despite a stall inside start", () =>
  Effect.gen(function* () {
    const parent = yield* DatabaseMeter.make;
    const child = yield* childOf(parent);
    const release = child.start();
    release();
    assert.isAtLeast(parent.snapshot(), child.snapshot());
  }).pipe(Effect.provideServiceEffect(Clock.Clock, stallingClock(1)))
);

it.effect("each ancestor's metered time contains its descendants' at any depth", () =>
  Effect.gen(function* () {
    const grandparent = yield* DatabaseMeter.make;
    const parent = yield* childOf(grandparent);
    const child = yield* childOf(parent);
    const release = child.start();
    release();
    assert.isAtLeast(grandparent.snapshot(), parent.snapshot());
    assert.isAtLeast(parent.snapshot(), child.snapshot());
  }).pipe(Effect.provideServiceEffect(Clock.Clock, stallingClock(2)))
);
