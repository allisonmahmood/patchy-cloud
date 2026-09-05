/**
 * The serving guarantees every published patch is delivered under.
 *
 * Patch URLs are never bot-blocked or challenged by a WAF. Any agent that may
 * open a patch can read it: public by URL, company through its user's browser.
 * `X-Robots-Tag: noindex` keeps every patch out of search results.
 *
 * The patch runs no script. A company shell runs only the session scripts,
 * never analytics; a public shell loads no scripts or session cookies.
 *
 * Caching follows sharing, not URL shape: public pages cache for at most a
 * minute, including version URLs, so making a patch company-only takes effect
 * within a minute without a CDN purge. Doored responses are private, no-store.
 */
import * as Effect from "effect/Effect";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const PATCH_ROBOTS_TAG = "noindex";

/**
 * Document-wide on every served patch. The patch's own frame is already
 * `referrerpolicy="no-referrer"`, and this says the same thing one level up:
 * navigating away from a served page must not hand anyone the patch URL the
 * reader was on. Sharing scope controls access; this prevents URL disclosure.
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

export const PUBLIC_PATCH_CACHE_CONTROL = "public, max-age=60";
export const PRIVATE_PATCH_CACHE_CONTROL = "private, no-store";

export function sessionContentSecurityPolicy(frontendApiHost: string): string {
  return `${PATCH_CONTENT_SECURITY_POLICY}; script-src 'self' https://${frontendApiHost}; connect-src https://${frontendApiHost}`;
}

/**
 * The two headers every response carries, whatever produced it: `nosniff`
 * always, and `no-store` unless the route chose a cache policy of its own.
 * The server installs this as global router middleware, outside everything
 * that can answer a request, so a refusal is covered as well as a page.
 */
export const servingHeaders = HttpMiddleware.make((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // A wildcard route masks the router's HEAD fallback. Resolve every HEAD as
    // GET before routing; the HTTP adapter still suppresses the body for HEAD.
    const response = yield* request.method === "HEAD"
      ? Effect.provideService(
          httpEffect,
          HttpServerRequest.HttpServerRequest,
          Object.create(request, {
            method: { value: "GET" }
          }) as HttpServerRequest.HttpServerRequest
        )
      : httpEffect;
    return HttpServerResponse.setHeaders(response, {
      "x-content-type-options": "nosniff",
      ...(response.headers["cache-control"] === undefined
        ? { "cache-control": NO_STORE_CACHE_CONTROL }
        : {})
    });
  })
);
