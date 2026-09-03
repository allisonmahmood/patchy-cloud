/**
 * The routes a reader hits: the home page, the health check, and a patch at
 * its latest URL (`/d/:patchId`) or a version URL (`/d/:patchId/v/:n`), plus
 * the HTML 404 for everything that is not a route. Pages read through
 * `patches` — the record and the HTML behind it come from `Content`, the
 * visit that keeps a patch alive goes to `Patches` — and never touch bytes
 * themselves. The serving guarantees these routes answer under are
 * `serving-headers.ts`.
 *
 * PROTOTYPE for #119 (throwaway): the routes are registered in two layers,
 * the open ones and the ones behind the login door (`LoginDoor.prototype.ts`),
 * which is route-scoped middleware provided to the second layer only.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Content, Patches, PatchesConfig } from "@patchy/patches";
import * as LoginDoor from "./LoginDoor.prototype.js";
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
 * The open routes: home, health, and the catch-all 404. The router prefers a
 * static or parametric match over the wildcard, so the 404 can live in its
 * own layer without depending on how layers happen to build.
 */
const open = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
    const home = HttpServerResponse.html(renderHome({ publicBaseUrl }));

    yield* router.add("GET", "/", home);
    yield* router.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ ok: true }));
    // PROTOTYPE for #131 (throwaway): the confirm page's variants, undoored, with sample data.
    yield* router.add("GET", "/prototype/login/device", LoginDoor.mock);
    yield* router.add("*", "/*", notFound);
  })
);

/** PROTOTYPE for #119: the routes behind the login door. */
const doored = HttpRouter.use((router) =>
  Effect.gen(function* () {
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
    yield* router.add("GET", "/login/device", LoginDoor.device);
    yield* router.add("POST", "/login/device", LoginDoor.deviceConfirm);
    yield* router.add("POST", "/sign-out", LoginDoor.signOut);
  })
).pipe(Layer.provide(LoginDoor.layer));

/** The page routes, open and doored. */
export const layer = Layer.mergeAll(open, doored);
