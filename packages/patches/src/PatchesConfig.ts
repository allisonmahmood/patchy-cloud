/** The patches capability's configuration, read from the environment through Effect `Config`. */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import { CURRENT_RELEASE } from "@patchy/api";
import { DEFAULT_MAX_HTML_BYTES } from "@patchy/core";

/** The build binds production to its package version; tests can model an upgraded instance. */
export const release = Context.Reference<string>("@patchy/patches/Release", {
  defaultValue: () => CURRENT_RELEASE
});

/** The required origin a patch's public URL is built on. */
export const publicBaseUrl = Config.string("PATCHY_PUBLIC_BASE_URL");

/** The largest tier 0 HTML document a publish may carry, in bytes. */
export const maxHtmlBytes = Config.int("PATCHY_MAX_HTML_BYTES").pipe(
  Config.withDefault(DEFAULT_MAX_HTML_BYTES)
);

/** Scripted bundles have their own cap; tier 0 retains its safe-HTML limit. */
export const maxBundleBytes = Config.int("PATCHY_MAX_BUNDLE_BYTES").pipe(
  Config.withDefault(10 * 1024 * 1024)
);

/** Creates admitted per token per minute, in memory. Updates never spend it. */
export const patchCreateRateLimitPerMinute = Config.int(
  "PATCHY_PATCH_CREATE_RATE_LIMIT_PER_MINUTE"
).pipe(Config.withDefault(10));

/** The patch quota: live patches one user may hold at once, counted from the database. */
export const livePatchesPerUser = Config.int("PATCHY_LIVE_PATCHES_PER_USER").pipe(
  Config.withDefault(1_000)
);

/** New publish attempts admitted per token per minute, after replay lookup. */
export const publishRateLimitPerMinute = Config.int(
  "PATCHY_AUTHENTICATED_PUBLISH_RATE_LIMIT_PER_MINUTE"
).pipe(Config.withDefault(20));

/** Room for the HTML bundle escaped into JSON and its manifest. */
export const maxPublishBodyBytes = Config.map(
  Config.all([maxHtmlBytes, maxBundleBytes]),
  ([htmlBytes, bundleBytes]) => Math.max(htmlBytes, bundleBytes) * 3
);
