/**
 * The routes a reader hits: the home page, the health check, and a patch at
 * its latest URL (`/d/:patchId`) or a version URL (`/d/:patchId/v/:n`), plus
 * the HTML 404 for everything that is not a route. Pages read through
 * `patches` — the record and the HTML behind it come from `Content`, the
 * visit that keeps a patch alive goes to `Patches` — and never touch bytes
 * themselves. The serving guarantees these routes answer under are
 * `serving-headers.ts`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Content, Patches, PatchesConfig } from "@patchy/patches";
import { renderHome, renderNotFound, renderPatchWrapper } from "./render.js";
import {
  NO_REFERRER_POLICY,
  PATCH_CONTENT_SECURITY_POLICY,
  PATCH_ROBOTS_TAG,
  servedPatchCacheControl
} from "./serving-headers.js";

/** The HTML 404, uncached like every non-patch response. */
export const notFound = HttpServerResponse.html(renderNotFound()).pipe(
  HttpServerResponse.setStatus(404)
);

/**
 * On every answer under `/d/`, the 404 included: a patch URL is never indexed
 * and never handed on as a referrer, whether or not it currently serves.
 */
const patchUrlHeaders = {
  "x-robots-tag": PATCH_ROBOTS_TAG,
  "referrer-policy": NO_REFERRER_POLICY
};

const servePatch = Effect.fn("Pages.servePatch")(function* (
  patchId: string,
  versionNumber?: number
) {
  const content = yield* Content.Content;
  const patches = yield* Patches.Patches;

  const served = yield* content.read(patchId, versionNumber).pipe(
    Effect.catchTags({
      SqlError: Effect.die,
      InvalidObjectKey: Effect.die,
      StoreUnavailable: Effect.die
    })
  );
  if (Option.isNone(served)) return HttpServerResponse.setHeaders(notFound, patchUrlHeaders);

  // The page is real and already fetched, so this is a visit — the thing that
  // keeps a patch people still visit from ageing out. The database decides
  // whether the clock actually moves and writes nothing when it does not.
  //
  // Best-effort on purpose: this is a read path, and a reader who is one header
  // away from their page should get it even if the top-up write fails. Losing a
  // clock extension costs at most some retention; turning a fetched page into a
  // 500 costs the reader the page itself.
  //
  // Only requests that reach the server are visits, and the cache headers below
  // mean repeat reads inside the latest URL's window may not. That undercount is
  // harmless: topping up needs one visit somewhere in the final stretch of a
  // 30-day window, not a true read count — this is a retention clock, not
  // analytics.
  yield* patches.recordVisit(served.value.patch.id).pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.logWarning("Patch visit top-up failed.", error).pipe(
          Effect.annotateLogs({ patchId: served.value.patch.id })
        )
    })
  );

  return HttpServerResponse.html(renderPatchWrapper(served.value)).pipe(
    HttpServerResponse.setHeaders({
      ...patchUrlHeaders,
      "content-security-policy": PATCH_CONTENT_SECURITY_POLICY,
      "cache-control": servedPatchCacheControl(versionNumber)
    })
  );
});

/** A version number as the URL spells it: a positive integer, or nothing. */
const versionNumberOf = (segment: string | undefined) =>
  segment !== undefined && /^[1-9]\d*$/.test(segment) ? Number(segment) : undefined;

/**
 * The page routes. Registered in one pass so the catch-all 404 comes last:
 * the router prefers a static or parametric match over the wildcard either
 * way, and the order keeps that from depending on how layers happen to build.
 */
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
    const home = HttpServerResponse.html(renderHome({ publicBaseUrl }));

    yield* router.add("GET", "/", home);
    yield* router.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ ok: true }));
    yield* router.add(
      "GET",
      "/d/:patchId",
      Effect.flatMap(HttpRouter.params, (params) => servePatch(params.patchId ?? ""))
    );
    yield* router.add(
      "GET",
      "/d/:patchId/v/:versionNumber",
      Effect.flatMap(HttpRouter.params, (params) => {
        const versionNumber = versionNumberOf(params.versionNumber);
        return versionNumber === undefined
          ? Effect.succeed(HttpServerResponse.setHeaders(notFound, patchUrlHeaders))
          : servePatch(params.patchId ?? "", versionNumber);
      })
    );
    yield* router.add("*", "/*", notFound);
  })
);
