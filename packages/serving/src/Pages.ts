/**
 * The routes a reader hits: the home page, the health check, patch addresses
 * (`/:company/:name[/~v/:n][/route]`) and exact-version content URLs, plus
 * the HTML 404 for everything that is not a route. Pages read through
 * `patches` — metadata and visits go through `Patches`, and `Content` reads
 * the HTML only after admission. The serving guarantees these routes answer
 * under are `serving-headers.ts`.
 */
import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Session, withCookies, sessionScripts, returnPath } from "@patchy/auth";
import { WIRE_VERSION } from "@patchy/api";
import { newInternalId } from "@patchy/core";
import type { Companies, Users } from "@patchy/companies";
import { Content, Patches, PatchesConfig } from "@patchy/patches";
import * as Door from "./Door.js";
import { renderHome, renderNotFound } from "./render.js";
import { renderPatchWrapper, renderShellNotice, isShellNotice, brokerScript } from "./shell.js";
import {
  NO_REFERRER_POLICY,
  SCRIPTED_SHELL_SECURITY_POLICY,
  PATCH_ROBOTS_TAG,
  PUBLIC_PATCH_CACHE_CONTROL,
  PRIVATE_PATCH_CACHE_CONTROL,
  contentSecurityPolicy,
  PATCH_PERMISSIONS_POLICY,
  shellContentSecurityPolicy
} from "./serving-headers.js";

/** The HTML 404, uncached like every non-patch response. */
export const notFound = HttpServerResponse.html(renderNotFound()).pipe(
  HttpServerResponse.setStatus(404)
);

/**
 * On every address and content answer, the 404 included: a patch URL is never
 * indexed or handed on as a referrer, whether or not it currently serves.
 */
const patchUrlHeaders = {
  "x-robots-tag": PATCH_ROBOTS_TAG,
  "content-security-policy": SCRIPTED_SHELL_SECURITY_POLICY,
  "referrer-policy": NO_REFERRER_POLICY,
  "cache-control": PRIVATE_PATCH_CACHE_CONTROL
};

const servePatch = Effect.fn("Pages.servePatch")(function* (kind: "address" | "content") {
  const content = yield* Content.Content;
  const patches = yield* Patches.Patches;
  const { result: admission, cookies, completedHandshake } = yield* Door.Admission;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const url = kind === "address" ? new URL(request.url, session.publicBaseUrl) : undefined;
  const suffix = url?.pathname.replace(/^\/[^/]+\/[^/]+/, "") ?? "";
  const selection = url === undefined ? undefined : addressRouteOf(suffix);
  const resolved =
    selection !== undefined && selection.versionNumber !== null
      ? yield* patches
          .resolveName(params.company ?? "", params.name ?? "")
          .pipe(Effect.catchTags({ SqlError: Effect.die }))
      : Option.none();
  const patchId =
    kind === "content"
      ? params.patchId
      : Option.isSome(resolved)
        ? resolved.value.patchId
        : undefined;
  const served =
    patchId === undefined
      ? Option.none()
      : yield* patches
          .find(
            patchId,
            selection?.versionNumber ?? undefined,
            kind === "content" ? params.versionId : undefined
          )
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
  const isPublic =
    Option.isSome(served) &&
    served.value.patch.scope === "public" &&
    served.value.version.id === served.value.patch.currentVersionId;
  // Finish a verified sign-in before serving a public document, but never require
  // a public reader to start a handshake or pass company admission.
  if (!isPublic || completedHandshake) {
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
  if (url !== undefined && Option.isSome(resolved) && !resolved.value.current) {
    const response = HttpServerResponse.redirect(
      `/${served.value.patch.companyHandle}/${served.value.patch.name}${suffix}${url.search}`,
      { status: 308, headers: patchUrlHeaders }
    );
    return isPublic ? response : withCookies(response, cookies);
  }
  if (served.value.version.tier >= 1 && served.value.version.wireVersion !== WIRE_VERSION) {
    return withCookies(
      HttpServerResponse.text(renderShellNotice("needs_rebuild", request.url), {
        contentType: "text/html",
        status: 409,
        headers: patchUrlHeaders
      }),
      isPublic ? [] : cookies
    );
  }
  const html =
    kind === "content" || served.value.version.tier === 0
      ? yield* content
          .read(served.value.version)
          .pipe(Effect.catchTags({ InvalidObjectKey: Effect.die, StoreUnavailable: Effect.die }))
      : "";

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
  // mean repeat reads inside the address's window may not. That undercount is
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
    kind === "content"
      ? html
      : renderPatchWrapper({
          ...served.value,
          html,
          head: isPublic ? undefined : sessionScripts(session),
          ...(selection !== undefined && served.value.version.tier >= 1
            ? {
                nonce: newInternalId("boot"),
                base: `/${served.value.patch.companyHandle}/${served.value.patch.name}${selection.versionNumber === undefined ? "" : `/~v/${selection.versionNumber}`}`,
                route: selection.route
              }
            : {})
        })
  ).pipe(
    HttpServerResponse.setHeaders({
      ...patchUrlHeaders,
      "content-security-policy":
        kind === "content"
          ? contentSecurityPolicy(served.value.version.tier)
          : shellContentSecurityPolicy(
              served.value.version.tier,
              isPublic ? undefined : session.frontendApiHost
            ),
      ...(kind === "content" ? { "permissions-policy": PATCH_PERMISSIONS_POLICY } : {}),
      "cache-control":
        isPublic && url?.searchParams.get("__patchy_shell_reload") !== "1"
          ? PUBLIC_PATCH_CACHE_CONTROL
          : PRIVATE_PATCH_CACHE_CONTROL
    })
  );
  return isPublic ? response : withCookies(response, cookies);
});

/** Match the positive PostgreSQL INTEGER range before a version reaches the lookup. */
const versionNumberOf = (segment: string | undefined) => {
  if (segment === undefined || !/^[1-9]\d*$/.test(segment)) return undefined;
  const version = Number(segment);
  return version <= 2_147_483_647 ? version : undefined;
};

/** Every reserved segment is refused except the version selector at the address root. */
const addressRouteOf = (suffix: string): { versionNumber?: number | null; route: string } => {
  let segments: string[];
  try {
    segments = suffix === "" ? [] : decodeURIComponent(suffix.slice(1)).split("/");
  } catch {
    return { versionNumber: null, route: "" };
  }
  const versionNumber = segments[0] === "~v" ? (versionNumberOf(segments[1]) ?? null) : undefined;
  const route = segments[0] === "~v" ? segments.slice(2) : segments;
  if (route.some((segment) => segment.startsWith("~"))) return { versionNumber: null, route: "" };
  return { versionNumber, route: `/${route.join("/")}` };
};

/**
 * Only addresses and exact-version content receive viewer admission. The home,
 * health, removed `/d/*` and catch-all routes never authenticate a session.
 */
const patches = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/:company/:name/*", servePatch("address"));
    yield* router.add("GET", "/~content/:patchId/:versionId", servePatch("content"));
  })
).pipe(Layer.provide(Door.layer));

const otherPages = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
    yield* router.add(
      "GET",
      "/~shell/broker.js",
      HttpServerResponse.text(brokerScript, {
        contentType: "text/javascript",
        headers: { "cache-control": "no-store" }
      })
    );
    yield* router.add(
      "GET",
      "/~shell/notice/:code",
      Effect.gen(function* () {
        const { code } = yield* HttpRouter.params;
        if (code === undefined || !isShellNotice(code)) return notFound;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, publicBaseUrl);
        const returnTo = returnPath(url.searchParams.get("return"), publicBaseUrl) ?? "/";
        return HttpServerResponse.text(renderShellNotice(code, returnTo), {
          contentType: "text/html",
          headers: patchUrlHeaders
        });
      })
    );
    yield* router.add("GET", "/", HttpServerResponse.html(renderHome({ publicBaseUrl })));
    yield* router.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ ok: true }));
    yield* router.add("*", "/d/*", notFound);
    yield* router.add("*", "/~content/*", notFound);
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
