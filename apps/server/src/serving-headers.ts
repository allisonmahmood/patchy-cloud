/**
 * The serving guarantees every published patch is delivered under.
 *
 * Standing rule: patch URLs are never bot-blocked, challenged, or put behind a
 * WAF human-check. Pages are share-a-link-never-be-found — `X-Robots-Tag:
 * noindex` keeps them out of search results, and that is the only measure taken
 * against discovery. Anything that makes an agent fail to fetch a pasted link is
 * a defect, not a defence.
 *
 * Readers are unwatched: no cookies, no auth or session on the serving host, and
 * a fully locked CSP with no script sources of any kind (no analytics JS).
 *
 * Cache lifetimes are keyed to URL shape and are never coupled to a CDN purge
 * API. A version URL names immutable content, so it is cached for a year; the
 * latest-patch URL follows the patch, so it gets a short window that lets an
 * update land on its own.
 */

export const PATCH_ROBOTS_TAG = "noindex";

/**
 * Document-wide on every served patch. The patch's own frame is already
 * `referrerpolicy="no-referrer"`, and this says the same thing one level up:
 * navigating away from a served page must not hand anyone the patch URL the
 * reader was on. An unlisted page's URL is the only thing keeping it unlisted.
 */
export const NO_REFERRER_POLICY = "no-referrer";

export const PATCH_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src https: data:",
  "frame-src 'self' about:",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");

/** Everything that is not a served patch — API routes included — stays uncached. */
export const NO_STORE_CACHE_CONTROL = "no-store";

const LATEST_PATCH_CACHE_CONTROL = "public, max-age=60";

const PATCH_VERSION_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function servedPatchCacheControl(versionNumber: number | undefined): string {
  return versionNumber === undefined ? LATEST_PATCH_CACHE_CONTROL : PATCH_VERSION_CACHE_CONTROL;
}
