import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { MAX_TRACKED_KEYS, type ConsumeResult } from "./Limits.js";

export interface ConsumeOptions {
  /** Prefix the company or other identity with the limit's name. */
  readonly key: string;
  readonly rate: number;
  readonly burst: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
  rate: number;
  burst: number;
}

/** One in-memory bucket per key and host replica, independent of fixed windows. */
export const make = Effect.sync(() => {
  const buckets = new Map<string, Bucket>();
  let lastNow = 0;
  const now = Effect.map(Clock.currentTimeMillis, (current) => {
    lastNow = Math.max(lastNow, current);
    return lastNow;
  });
  const fullAt = (bucket: Bucket) =>
    bucket.updatedAt + ((bucket.burst - bucket.tokens) / bucket.rate) * 1_000;

  const consume = Effect.fnUntraced(function* (
    options: ConsumeOptions
  ): Effect.fn.Return<ConsumeResult> {
    const at = yield* now;
    let bucket = buckets.get(options.key);
    if (bucket === undefined) {
      if (buckets.size >= MAX_TRACKED_KEYS) {
        let earliestFull = Infinity;
        for (const [key, candidate] of buckets) {
          const refillAt = fullAt(candidate);
          if (at >= refillAt) buckets.delete(key);
          else earliestFull = Math.min(earliestFull, refillAt);
        }
        if (buckets.size >= MAX_TRACKED_KEYS) {
          return {
            allowed: false,
            reason: "capacity",
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil((earliestFull - at) / 1_000))
          };
        }
      }
      bucket = { tokens: options.burst, updatedAt: at, rate: options.rate, burst: options.burst };
      buckets.set(options.key, bucket);
    } else {
      // Apply elapsed refill under the previous policy before changing an override.
      bucket.tokens = Math.min(
        options.burst,
        bucket.burst,
        bucket.tokens + ((at - bucket.updatedAt) * bucket.rate) / 1_000
      );
      bucket.updatedAt = at;
      bucket.rate = options.rate;
      bucket.burst = options.burst;
    }
    if (bucket.tokens < 1) {
      return {
        allowed: false,
        reason: "rate",
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / options.rate))
      };
    }
    bucket.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterSeconds: 0
    };
  });

  return { consume };
});
