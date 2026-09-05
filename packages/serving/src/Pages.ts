/**
 * The routes a reader hits: the home page, the health check, and a patch at
 * its latest URL (`/d/:patchId`) or a version URL (`/d/:patchId/v/:n`), plus
 * the HTML 404 for everything that is not a route. Pages read through
 * `patches` — metadata and visits go through `Patches`, and `Content` reads
 * the HTML only after admission. The serving guarantees these routes answer under are
 * `serving-headers.ts`.
 */
import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Session, withCookies } from "@patchy/auth";
import type { Companies, Users } from "@patchy/companies";
import { Content, Patches, PatchesConfig } from "@patchy/patches";
import * as Door from "./Door.js";
import { renderHome, renderNotFound, renderPatchWrapper } from "./render.js";
import {
  NO_REFERRER_POLICY,
  PATCH_CONTENT_SECURITY_POLICY,
  PATCH_ROBOTS_TAG,
  PUBLIC_PATCH_CACHE_CONTROL,
  PRIVATE_PATCH_CACHE_CONTROL,
  sessionContentSecurityPolicy
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
  "referrer-policy": NO_REFERRER_POLICY,
  "cache-control": PRIVATE_PATCH_CACHE_CONTROL
};

const servePatch = Effect.fn("Pages.servePatch")(function* (
  patchId: string,
  versionNumber?: number | null
) {
  const content = yield* Content.Content;
  const patches = yield* Patches.Patches;
  const { result: admission, cookies } = yield* Door.Admission;
  const session = yield* Session.Session;

  const served =
    versionNumber === null
      ? Option.none()
      : yield* patches
          .find(patchId, versionNumber)
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
  const isPublic = Option.isSome(served) && served.value.patch.scope === "public";
  if (!isPublic) {
    if (HttpServerResponse.isHttpServerResponse(admission)) {
      return withCookies(
        HttpServerResponse.setHeaders(admission, {
          ...patchUrlHeaders,
          "referrer-policy": admission.headers["referrer-policy"] ?? NO_REFERRER_POLICY
        }),
        cookies
      );
    }
    if (Option.isNone(served) || served.value.patch.companyId !== admission.company.id) {
      return withCookies(HttpServerResponse.setHeaders(notFound, patchUrlHeaders), cookies);
    }
  }
  if (Option.isNone(served))
    return withCookies(HttpServerResponse.setHeaders(notFound, patchUrlHeaders), cookies);
  const html = yield* content
    .read(served.value.version)
    .pipe(Effect.catchTags({ InvalidObjectKey: Effect.die, StoreUnavailable: Effect.die }));

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

  const response = HttpServerResponse.html(
    renderPatchWrapper({ ...served.value, html }, isPublic ? undefined : session)
  ).pipe(
    HttpServerResponse.setHeaders({
      ...patchUrlHeaders,
      "content-security-policy": isPublic
        ? PATCH_CONTENT_SECURITY_POLICY
        : sessionContentSecurityPolicy(session.frontendApiHost),
      "cache-control": isPublic ? PUBLIC_PATCH_CACHE_CONTROL : PRIVATE_PATCH_CACHE_CONTROL
    })
  );
  return isPublic ? response : withCookies(response, cookies);
});

/** A version number as the URL spells it: a positive integer, or nothing. */
const versionNumberOf = (segment: string | undefined) =>
  segment !== undefined && /^[1-9]\d*$/.test(segment) ? Number(segment) : undefined;

/**
 * Only the two patch registrations receive viewer admission. The home, health
 * and catch-all routes never authenticate a session.
 */
const patches = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      "/d/:patchId",
      Effect.flatMap(HttpRouter.params, (params) => servePatch(params.patchId ?? ""))
    );
    yield* router.add(
      "GET",
      "/d/:patchId/v/:versionNumber",
      Effect.flatMap(HttpRouter.params, (params) =>
        servePatch(params.patchId ?? "", versionNumberOf(params.versionNumber) ?? null)
      )
    );
  })
).pipe(Layer.provide(Door.layer));

const otherPages = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
    yield* router.add("GET", "/", HttpServerResponse.html(renderHome({ publicBaseUrl })));
    yield* router.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ ok: true }));
    yield* router.add("*", "/*", notFound);
  })
);

export const layer: Layer.Layer<
  never,
  ConfigError,
  | HttpRouter.HttpRouter
  | Session.Session
  | Companies.Companies
  | Users.Users
  | HttpRouter.Request.From<"Requires", Content.Content | Patches.Patches | Session.Session>
> = Layer.mergeAll(patches, otherPages);
