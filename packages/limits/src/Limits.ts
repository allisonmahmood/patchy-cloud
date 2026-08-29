/**
 * The limits capability: a fixed-window rate limiter behind one `Limits`
 * service. The interface mirrors Effect's `RateLimiter.consume` (a key, a
 * limit and a window per call, an answer with what is left) so a shared
 * store for a multi-replica deployment is a layer swap, not a consumer
 * change. Quotas are not here: they are database counts owned by the
 * capability that enforces them.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ConsumeOptions {
  /**
   * What the window is counted for: a source address, a token id. Consumers
   * prefix it with the limit's name, since every limit shares one store.
   */
  readonly key: string;
  /** Attempts admitted per window. */
  readonly limit: number;
  readonly window: Duration.Input;
}

export interface ConsumeResult {
  readonly allowed: boolean;
  /** Attempts left in the current window; `0` when refused. */
  readonly remaining: number;
  /**
   * What `Retry-After` should say: whole seconds until the window resets, at
   * least `1` when refused, and `0` when the attempt was admitted.
   */
  readonly retryAfterSeconds: number;
}

/**
 * The most keys the in-memory store tracks at once. Past it the limiter fails
 * closed: a key it has never seen is refused until an expired window frees a
 * slot, so a flood of fresh addresses can exhaust memory no faster than it
 * can wait out a window.
 */
export const MAX_TRACKED_KEYS = 10_000;

export class Limits extends Context.Service<
  Limits,
  {
    /** Spends one attempt from the key's current window, or reports why not. */
    readonly consume: (options: ConsumeOptions) => Effect.Effect<ConsumeResult>;
  }
>()("@patchy/limits/Limits") {}

interface Window {
  count: number;
  resetAt: number;
}

const retryAfterSeconds = (now: number, resetAt: number) =>
  Math.max(1, Math.ceil((resetAt - now) / 1_000));

/**
 * The in-memory store: one map of windows. A key's own window is replaced
 * when it has expired; the store is only scanned end to end when it is full,
 * which at 10k entries is cheap and rare.
 */
export const make = Effect.sync(() => {
  const windows = new Map<string, Window>();
  // The wall clock may step backwards; a window never does.
  let lastNow = 0;

  const now = Effect.map(Clock.currentTimeMillis, (current) => {
    lastNow = Math.max(lastNow, current);
    return lastNow;
  });

  /** Drops every expired window and answers with the earliest reset among the rest. */
  const pruneExpired = (at: number) => {
    let earliestReset = at + 1_000;
    for (const [key, window] of windows) {
      if (at >= window.resetAt) windows.delete(key);
      else earliestReset = Math.min(earliestReset, window.resetAt);
    }
    return earliestReset;
  };

  const consume = Effect.fn("Limits.consume")(function* (options: ConsumeOptions) {
    const at = yield* now;
    const window = windows.get(options.key);

    if (window !== undefined && at < window.resetAt) {
      if (window.count >= options.limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: retryAfterSeconds(at, window.resetAt)
        };
      }
      window.count += 1;
      return { allowed: true, remaining: options.limit - window.count, retryAfterSeconds: 0 };
    }

    if (window === undefined && windows.size >= MAX_TRACKED_KEYS) {
      const earliestReset = pruneExpired(at);
      if (windows.size >= MAX_TRACKED_KEYS) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: retryAfterSeconds(at, earliestReset)
        };
      }
    }

    windows.set(options.key, { count: 1, resetAt: at + Duration.toMillis(options.window) });
    return { allowed: true, remaining: options.limit - 1, retryAfterSeconds: 0 };
  });

  return Limits.of({ consume });
});

export const layer = Layer.effect(Limits, make);
