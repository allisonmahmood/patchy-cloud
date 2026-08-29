/**
 * The runtime a test app runs on: no-op analytics unless a test provides its
 * own layer, the in-memory limiter, and — when a test winds a clock — that
 * clock, so a window boundary is crossed without waiting a minute.
 */
import { Analytics } from "@patchy/analytics";
import { Limits } from "@patchy/limits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { ServerRuntime } from "./runtime.js";

export interface TestRuntimeOptions {
  readonly clock?: () => number;
  readonly analytics?: Layer.Layer<Analytics.Analytics>;
}

export function createTestRuntime(options: TestRuntimeOptions = {}): ServerRuntime {
  const services = Layer.merge(options.analytics ?? Analytics.layerNoop, Limits.layer);
  const clock = options.clock;
  if (clock === undefined) return ManagedRuntime.make(services);
  // Merged rather than only provided: the limiter reads the clock when it
  // consumes, not when it is built, so the clock has to be in the runtime.
  const testClock = Layer.effect(
    Clock.Clock,
    Clock.clockWith((live) =>
      // Spelled out member by member: the live clock is a class instance, so a
      // spread would drop its prototype methods.
      Effect.succeed<Clock.Clock>({
        currentTimeMillisUnsafe: clock,
        currentTimeMillis: Effect.sync(clock),
        currentTimeNanosUnsafe: () => BigInt(clock()) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(clock()) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: live.monotonicTimeNanos,
        sleep: (duration) => live.sleep(duration)
      })
    )
  );
  return ManagedRuntime.make(services.pipe(Layer.provideMerge(testClock)));
}

/** An analytics layer that keeps what it was handed instead of reporting it. */
export function recordingAnalytics() {
  const events: Analytics.AnalyticsEvent[] = [];
  const layer = Layer.succeed(
    Analytics.Analytics,
    Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
  );
  return { events, layer };
}
