/**
 * The runtime a test app runs on: no-op analytics unless a test provides its
 * own layer, the in-memory limiter, tokens over the test's store, the auth
 * capability's configuration read from the app's `ServerConfig`, and — when
 * a test winds a clock — that clock, so a window boundary is crossed without
 * waiting a minute.
 */
import { Analytics } from "@patchy/analytics";
import type { Tokens } from "@patchy/auth";
import type { ServerConfig } from "@patchy/config";
import { jsonTokensLayer, type JsonFilePatchyDb } from "@patchy/db";
import type { ConfigError } from "effect/Config";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { layer, type ServerRuntime } from "./runtime.js";

export type TestRuntimeOptions = {
  readonly config: ServerConfig;
  readonly clock?: () => number;
  readonly analytics?: Layer.Layer<Analytics.Analytics>;
} & (
  | { readonly db: JsonFilePatchyDb }
  | { readonly tokens: Layer.Layer<Tokens.Tokens, ConfigError | SqlError> }
);

export function createTestRuntime(options: TestRuntimeOptions): ServerRuntime {
  const services = Layer.orDie(
    layer({
      tokens: "db" in options ? jsonTokensLayer(options.db) : options.tokens,
      analytics: options.analytics ?? Analytics.layerNoop
    })
  ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(authEnv(options.config)))));
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

/** The auth capability's environment, as the app's config spells it. */
function authEnv(config: ServerConfig): Record<string, string> {
  return {
    ...(config.bootstrapApiToken === null
      ? {}
      : { PATCHY_BOOTSTRAP_API_TOKEN: config.bootstrapApiToken }),
    PATCHY_ALLOW_SELF_SERVICE_TOKENS: String(config.allowSelfServiceTokens),
    PATCHY_SELF_SERVICE_MINT_RATE_LIMIT_PER_MINUTE: String(
      config.selfServiceMintRateLimitPerMinute
    ),
    PATCHY_SELF_SERVICE_MINTS_PER_IP_PER_DAY: String(config.selfServiceMintsPerIpPerDay)
  };
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
