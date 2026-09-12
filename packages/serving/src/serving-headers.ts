/**
 * The serving guarantees every published patch is delivered under.
 *
 * Patch URLs are never bot-blocked or challenged by a WAF. Any agent that may
 * open a patch can read it: public by URL, company through its user's browser.
 * `X-Robots-Tag: noindex` keeps every patch out of search results.
 *
 * Tier-zero content runs no script; tier-one shells load Patchy's broker,
 * and company shells also maintain the session. Neither runs analytics.
 * Exact content URLs use their stored version's tier and sandbox policy.
 *
 * Only a public patch's current version is public, at its latest and version
 * URLs; older versions stay behind the company door. Public pages cache for at
 * most a minute, so a scope or current-version change takes effect within a
 * minute without a CDN purge. Doored responses are private, no-store.
 */
import * as Effect from "effect/Effect";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  NO_STORE_CACHE_CONTROL,
  SCRIPTED_SHELL_SECURITY_POLICY,
  SCRIPTED_CONTENT_SECURITY_POLICY,
  PATCH_PERMISSIONS_POLICY
} from "./shell-headers.js";
export * from "./shell-headers.js";

/**
 * Every response carries `nosniff`; CSP and `no-store` have safe fallbacks
 * unless the route chose its own policy.
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
    const contentUrl = new URL(request.url, "http://localhost").pathname.startsWith("/~content/");
    return HttpServerResponse.setHeaders(response, {
      "x-content-type-options": "nosniff",
      // Redirects and errors cannot become an unsandboxed navigation escape.
      ...(response.headers["content-security-policy"] === undefined
        ? { "content-security-policy": SCRIPTED_SHELL_SECURITY_POLICY }
        : {}),
      ...(contentUrl && response.status !== 200
        ? {
            "content-security-policy": SCRIPTED_CONTENT_SECURITY_POLICY,
            "permissions-policy": PATCH_PERMISSIONS_POLICY
          }
        : {}),
      ...(response.headers["cache-control"] === undefined
        ? { "cache-control": NO_STORE_CACHE_CONTROL }
        : {})
    });
  })
);
