/**
 * The runtime a test app runs on: no-op analytics unless a test provides its
 * own layer, the in-memory limiter, tokens and patches over the test's
 * Postgres, the filesystem content store under the config's `storageDir`
 * unless a test provides its own layer, the capabilities' configuration read
 * from the app's `ServerConfig`, and — when a test winds a clock — that
 * clock, so a window boundary is crossed without waiting a minute.
 */
import { Analytics } from "@patchy/analytics";
import type { ServerConfig } from "@patchy/config";
import { type ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { layerFromUrl } from "@patchy/sql";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { layer, type ServerRuntime } from "./runtime.js";

export interface TestRuntimeOptions {
  readonly config: ServerConfig;
  /** A migrated database the test owns. */
  readonly databaseUrl: string;
  readonly clock?: () => number;
  readonly analytics?: Layer.Layer<Analytics.Analytics>;
  readonly contentStore?: Layer.Layer<ContentStore.ContentStore>;
}

export function createTestRuntime(options: TestRuntimeOptions): ServerRuntime {
  const services = Layer.orDie(
    layer({
      sql: layerFromUrl(Redacted.make(options.databaseUrl)),
      analytics: options.analytics ?? Analytics.layerNoop,
      contentStore: options.contentStore ?? FilesystemContentStore.layer
    })
  ).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(capabilityEnv(options.config))))
  );
  const clock = options.clock;
  if (clock === undefined) return ManagedRuntime.make(services);
  // Merged rather than only provided: the limiter and the retention clock
  // read the clock when they run, not when they are built, so the clock has
  // to be in the runtime.
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

/** The ported capabilities' environment, as the app's config spells it. */
function capabilityEnv(config: ServerConfig): Record<string, string> {
  return {
    PATCHY_STORAGE_DIR: config.storageDir,
    PATCHY_PUBLIC_BASE_URL: config.publicBaseUrl,
    PATCHY_MAX_HTML_BYTES: String(config.maxHtmlBytes),
    PATCHY_PATCH_CREATE_RATE_LIMIT_PER_MINUTE: String(config.patchCreateRateLimitPerMinute),
    PATCHY_LIVE_PATCHES_PER_TOKEN: String(config.livePatchesPerToken),
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
