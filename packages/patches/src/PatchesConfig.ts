/** The patches capability's configuration, read from the environment through Effect `Config`. */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import { CURRENT_RELEASE } from "@patchy/api";
import { DEFAULT_MAX_HTML_BYTES } from "@patchy/core";
import { registry } from "@patchy/limits/registry";

/** The build binds production to its package version; tests can model an upgraded instance. */
export const release = Context.Reference<string>("@patchy/patches/Release", {
  defaultValue: () => CURRENT_RELEASE
});

/** Production admits server artifacts only when startup selects the ECS fleet. */
export const tier2Enabled = Config.map(
  Config.all({
    environment: Config.String("NODE_ENV").pipe(Config.withDefault("development")),
    provider: Config.String("EXECUTION_PROVIDER").pipe(Config.withDefault("local"))
  }),
  ({ environment, provider }) => environment !== "production" || provider === "ecs"
);

/** The required origin a patch's public URL is built on. */
export const publicBaseUrl = Config.String("PATCHY_PUBLIC_BASE_URL");

/** The largest tier 0 HTML document a publish may carry, in bytes. */
export const maxHtmlBytes = Config.Int("PATCHY_MAX_HTML_BYTES").pipe(
  Config.withDefault(DEFAULT_MAX_HTML_BYTES)
);

/** Scripted bundles have their own cap; tier 0 retains its safe-HTML limit. */
export const maxBundleBytes = Config.Int("PATCHY_MAX_BUNDLE_BYTES").pipe(
  Config.withDefault(10 * 1024 * 1024)
);

/** Creates admitted per token per minute, in memory. Updates never spend it. */
export const patchCreateRateLimitPerMinute = Config.Int(
  "PATCHY_PATCH_CREATE_RATE_LIMIT_PER_MINUTE"
).pipe(Config.withDefault(registry["rate.patchCreate.perMinute"].default));

/** The patch quota: live patches one user may hold at once, counted from the database. */
export const livePatchesPerUser = Config.Int("PATCHY_LIVE_PATCHES_PER_USER").pipe(
  Config.withDefault(1_000)
);

/** New publish attempts admitted per token per minute, after replay lookup. */
export const publishRateLimitPerMinute = Config.Int(
  "PATCHY_AUTHENTICATED_PUBLISH_RATE_LIMIT_PER_MINUTE"
).pipe(Config.withDefault(registry["rate.publish.perMinute"].default));

/** Room for both artifacts escaped into JSON and their manifest. */
export const maxPublishBodyBytes = Config.map(
  Config.all([maxHtmlBytes, maxBundleBytes]),
  ([htmlBytes, bundleBytes]) => (Math.max(htmlBytes, bundleBytes) + bundleBytes) * 3
);
