/** The patches capability's configuration, read from the environment through Effect `Config`. */
import * as Config from "effect/Config";

/** The required origin a patch's public URL is built on. */
export const publicBaseUrl = Config.string("PATCHY_PUBLIC_BASE_URL");

/** The largest document an upload may carry, in bytes. */
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

/**
 * Uploads admitted per token per minute, in memory. Spent before the body is
 * read, so a token cannot make the server read documents faster than this.
 */
export const uploadRateLimitPerMinute = Config.int(
  "PATCHY_AUTHENTICATED_UPLOAD_RATE_LIMIT_PER_MINUTE"
).pipe(Config.withDefault(20));

/**
 * The largest upload body the server reads, in bytes: the document as JSON
 * text, with room for escaping, and never under two megabytes.
 */
export const maxUploadBodyBytes = Config.map(maxHtmlBytes, (bytes) =>
  Math.max(bytes * 3, 2 * 1024 * 1024)
);
