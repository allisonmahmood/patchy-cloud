/** The patches capability's configuration, read from the environment through Effect `Config`. */
import * as Config from "effect/Config";
import { CURRENT_RELEASE, MANIFEST_VERSION, WIRE_VERSION } from "@patchy/api";

export const release = Config.string("PATCHY_RELEASE").pipe(Config.withDefault(CURRENT_RELEASE));
export const manifestVersion = Config.int("PATCHY_MANIFEST_VERSION").pipe(
  Config.withDefault(MANIFEST_VERSION)
);
export const wireVersion = Config.int("PATCHY_WIRE_VERSION").pipe(Config.withDefault(WIRE_VERSION));
export const packageIntegrity = Config.string("PATCHY_PACKAGE_INTEGRITY").pipe(
  Config.withDefault("")
);

/** The required origin a patch's public URL is built on. */
export const publicBaseUrl = Config.string("PATCHY_PUBLIC_BASE_URL");

/** The largest HTML bundle a publish may carry, in bytes. */
export const maxHtmlBytes = Config.int("PATCHY_MAX_HTML_BYTES").pipe(
  Config.withDefault(512 * 1024)
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
export const maxPublishBodyBytes = Config.map(maxHtmlBytes, (bytes) => bytes * 3);
