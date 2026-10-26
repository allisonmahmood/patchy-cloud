/**
 * The routes a reader hits: the health checks, patch addresses
 * (`/:company/:name[/~v/:n][/route]`) and exact-version content URLs.
 * The server owns the root and catch-all together. Pages read through
 * `patches`; metadata, visits and opens go through `Patches`, a colleague's
 * first open is reported as `patch.first_opened`, and `Content` reads the
 * HTML only after admission. A content URL's document comes from the
 * host's memory once read, compressed by `Accept-Encoding`. The serving
 * guarantees these routes answer under are `serving-headers.ts`.
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Session, withCookies, sessionScripts, returnPath, pageResponse } from "@patchy/auth";
import { WIRE_VERSION, handlerKinds } from "@patchy/api";
import { contentHash, isWelcomePage, newInternalId } from "@patchy/core";
import type { Companies, Users } from "@patchy/companies";
import { DeploymentConfig } from "@patchy/limits";
import { Content, Patches, PatchesConfig } from "@patchy/patches";
import { withReportedCommit } from "@patchy/sql";
import * as Door from "./Door.js";
import { renderNotFound } from "./render.js";
import { renderAddressNotice } from "./address-notice.js";
import { compress, negotiate, type Precompressed } from "./compression.js";
import {
  renderPatchWrapper,
  renderShellNotice,
  isShellNotice,
  brokerScript,
  brokerDigest
} from "./shell.js";
import {
  NO_REFERRER_POLICY,
  PATCH_CONTENT_SECURITY_POLICY,
  PATCH_ROBOTS_TAG,
  PUBLIC_PATCH_CACHE_CONTROL,
  PRIVATE_PATCH_CACHE_CONTROL,
  contentSecurityPolicy,
  PATCH_PERMISSIONS_POLICY,
  shellContentSecurityPolicy
} from "./serving-headers.js";

/** A version's stored document whose bytes no longer match its recorded digest: a fault. */
class StoredDocumentMismatch extends Schema.TaggedError<StoredDocumentMismatch>()(
  "StoredDocumentMismatch",
  { objectKey: Schema.String }
) {
  override get message() {
    return `The stored document at ${this.objectKey} does not match its recorded digest.`;
  }
}

/** The HTML 404, uncached like every non-patch response. */
export const notFound = HttpServerResponse.html(renderNotFound()).pipe(
  HttpServerResponse.setStatus(404)
);

/**
 * Patch documents, redirects and refusals are never indexed or sent as referrers.
 * Address notices stay unindexed but use pageResponse's same-origin referrer
 * policy so their Restore form can submit with a valid Origin.
 */
const patchUrlHeaders = {
  "x-robots-tag": PATCH_ROBOTS_TAG,
  "referrer-policy": NO_REFERRER_POLICY,
  "cache-control": PRIVATE_PATCH_CACHE_CONTROL
};
const noticeHeaders = {
  ...patchUrlHeaders,
  "content-security-policy": PATCH_CONTENT_SECURITY_POLICY
};

/** What names a version's stored document: its object key and recorded digest, and its size. */
type StoredDocument = Pick<Patches.PatchVersion, "objectKey" | "contentHash" | "fileSize">;

/** A document in every coding while the host keeps it; one too large to keep has identity alone. */
type Document = Precompressed | Pick<Precompressed, "identity">;

const encoder = new TextEncoder();

/** How a kept document is compressed: `compress`, which tests replace to watch it run. */
export const DocumentCompression = Context.Reference<
  (body: Uint8Array) => Effect.Effect<Precompressed>
>("@patchy/serving/Pages/DocumentCompression", { defaultValue: () => compress });

/**
 * Content URL documents in memory, within the `serving.contentCache.*` bounds. The body is the
 * stored bytes verbatim, the same for every viewer who passes the door, so a kept or compressed
 * body suits them all: the nonce stays in the URL and every header is computed per request. A
 * miss checks the bytes against the version's recorded digest before anyone receives them.
 *
 * A host reads and prepares at most four documents at a time, from the read through keeping
 * them, so documents waiting their turn hold no bytes; their wait counts against the job's
 * deadline. Within those four, it compresses one at a time, leaving the rest of libuv's
 * threadpool to file, crypto and DNS work, while the others' storage reads overlap.
 */
const makeDocuments = Effect.gen(function* () {
  const content = yield* Content.Content;
  const deployment = yield* DeploymentConfig.load;
  const compressDocument = yield* DocumentCompression;
  const preparing = yield* Semaphore.make(4);
  const compressing = yield* Semaphore.make(1);
  const prepare = Effect.fnUntraced(function* (stored: StoredDocument, keep: boolean) {
    const html = yield* content.read(stored);
    if (contentHash(html) !== stored.contentHash)
      return yield* new StoredDocumentMismatch({ objectKey: stored.objectKey });
    const identity = encoder.encode(html);
    // One that won't be kept goes out as stored, rather than compressed on every load. The
    // permit is held until zlib finishes, so the bound counts native work, not waiting fibers.
    const document: Document = keep
      ? yield* compressing.withPermits(1)(Effect.uninterruptible(compressDocument(identity)))
      : { identity };
    // Every coding it holds counts against the byte bound.
    const bytes = Object.values(document).reduce((sum, body) => sum + body.byteLength, 0);
    return { value: document, bytes };
  });
  return yield* Content.makeArtifactCache({
    maxBytes: deployment.get("serving.contentCache.bytes"),
    maxEntries: deployment.get("serving.contentCache.entries"),
    identity: (stored: StoredDocument) => `${stored.objectKey}#${stored.contentHash}`,
    size: (stored) => stored.fileSize,
    read: (stored, keep) => preparing.withPermits(1)(prepare(stored, keep)),
    loaded: (contentLoad) => WideEvents.enrich({ contentLoad })
  });
});
type Documents = Effect.Success<typeof makeDocuments>;

/** The coding and body to send a reader whose request asked for `acceptEncoding`. */
const negotiated = (document: Document, acceptEncoding: string | undefined) => {
  if (!("br" in document)) return { coding: "identity", body: document.identity } as const;
  const coding = negotiate(acceptEncoding);
  return { coding, body: document[coding] };
};

const servePatch = Effect.fn("Pages.servePatch")(function* (
  kind: "address" | "content",
  documents: Documents
) {
  const content = yield* Content.Content;
  const patches = yield* Patches.Patches;
  const analytics = yield* Analytics.Analytics;
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
          .findRetained(
            patchId,
            selection?.versionNumber ?? undefined,
            kind === "content" ? params.versionId : undefined
          )
          .pipe(Effect.catchTags({ SqlError: Effect.die }));
  if (Option.isSome(served))
    yield* WideEvents.enrich({
      patchId: served.value.patch.id,
      versionId: served.value.version.id
    });
  // Gone and operator-disabled patches are absent even before sign-in.
  if (Option.isNone(served) || served.value.patch.disabledAt !== null) {
    return withCookies(HttpServerResponse.setHeaders(notFound, patchUrlHeaders), cookies);
  }
  const isPublic =
    served.value.patch.state === "live" &&
    served.value.patch.scope === "public" &&
    served.value.version.id === served.value.patch.currentVersionId;
  const isAlias = Option.isSome(resolved) && !resolved.value.current;
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
    if (served.value.patch.companyId !== admission.company.id) {
      return withCookies(HttpServerResponse.setHeaders(notFound, patchUrlHeaders), cookies);
    }
    if (served.value.patch.state !== "live" && !isAlias) {
      const canOpen = yield* Patches.Openability;
      const notice = yield* patches
        .addressNotice(served.value.patch.id, {
          companyId: admission.company.id,
          userId: admission.user.id,
          canOpen: (patch) => canOpen(patch, admission.user.id)
        })
        .pipe(Effect.catchTags({ SqlError: Effect.die }));
      if (Option.isNone(notice)) {
        return withCookies(HttpServerResponse.setHeaders(notFound, patchUrlHeaders), cookies);
      }
      const now = yield* Clock.currentTimeMillis;
      return withCookies(
        pageResponse(
          {
            title: `${notice.value.patch.name} is ${notice.value.patch.state}`,
            body: renderAddressNotice({ ...notice.value, viewer: admission, now }),
            app: { viewer: admission, section: "patches" }
          },
          session
        ).pipe(HttpServerResponse.setHeader("x-robots-tag", PATCH_ROBOTS_TAG)),
        cookies
      );
    }
  }
  if (url !== undefined && isAlias) {
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
        headers: noticeHeaders
      }),
      isPublic ? [] : cookies
    );
  }
  const { version } = served.value;
  // Simultaneous misses join on an equal key, so it holds only what names the bytes.
  const document =
    kind === "content"
      ? yield* documents({
          objectKey: version.objectKey,
          contentHash: version.contentHash,
          fileSize: version.fileSize
        }).pipe(
          Effect.catchTags({
            InvalidObjectKey: Effect.die,
            StoreUnavailable: Effect.die,
            StoredDocumentMismatch: Effect.die,
            TimeoutError: Effect.die
          })
        )
      : undefined;
  // Only a tier 0 shell embeds its document; a scripted one frames the content URL.
  const html =
    kind === "address" && served.value.version.tier === 0
      ? yield* content
          .read(served.value.version)
          .pipe(Effect.catchTags({ InvalidObjectKey: Effect.die, StoreUnavailable: Effect.die }))
      : "";
  const publicDirectory =
    isPublic &&
    served.value.version.tier === 1 &&
    served.value.version.manifest.uses.members?.kind === "members";

  // Count only successful requests that reach the origin. Cached reads may
  // undercount visits. A failed counter write must not deny the fetched page.
  yield* patches.recordVisit(served.value.patch.id).pipe(
    Effect.catchTags({
      SqlError: (error) =>
        Effect.logWarning("Patch visit recording failed.", error).pipe(
          Effect.annotateLogs({ patchId: served.value.patch.id })
        )
    })
  );
  // An admitted member opening the current version's address, not an older version or the
  // frame's content request, is an open for their own Home: it is what clears "new to you".
  // Public pages are served without a session, so they record none.
  const viewerId =
    !isPublic && !HttpServerResponse.isHttpServerResponse(admission)
      ? admission.user.id
      : undefined;
  // A colleague's first open is the one business event serving reports: activation is counted
  // in it. It reports with the open's commit, so a reader who leaves mid-COMMIT can't leave a first
  // open recorded and never reported, while the open itself, lock waits included, stays
  // cancellable. Tracking never fails the page.
  if (kind === "address" && viewerId !== undefined) {
    const { patch } = served.value;
    yield* withReportedCommit(patches.recordOpen(viewerId, patch.id, version.id), (firstOpen) =>
      firstOpen && viewerId !== patch.ownerUserId
        ? analytics.track({
            name: "patch.first_opened",
            principalId: viewerId,
            companyId: patch.companyId,
            properties: {
              patchId: patch.id,
              ownerUserId: patch.ownerUserId,
              tier: version.tier,
              welcomePage: isWelcomePage({ name: patch.name, tier: version.tier })
            }
          })
        : Effect.void
    ).pipe(
      Effect.catchTags({
        SqlError: (error) =>
          Effect.logWarning("Patch open recording failed.", error).pipe(
            Effect.annotateLogs({ patchId: patch.id })
          )
      })
    );
  }

  const headers = {
    ...patchUrlHeaders,
    "content-security-policy":
      kind === "content"
        ? contentSecurityPolicy(served.value.version.tier)
        : shellContentSecurityPolicy(
            served.value.version.tier,
            !isPublic || publicDirectory ? session.clerk?.frontendApiHost : undefined
          ),
    ...(kind === "content" ? { "permissions-policy": PATCH_PERMISSIONS_POLICY } : {}),
    "cache-control":
      isPublic && url?.searchParams.get("__patchy_shell_reload") !== "1"
        ? PUBLIC_PATCH_CACHE_CONTROL
        : PRIVATE_PATCH_CACHE_CONTROL
  };
  const sent = document && negotiated(document, request.headers["accept-encoding"]);
  if (sent) yield* WideEvents.enrich({ contentEncoding: sent.coding });
  const response = sent
    ? HttpServerResponse.uint8Array(sent.body, {
        contentType: "text/html; charset=utf-8",
        headers: {
          ...headers,
          vary: "Accept-Encoding",
          ...(sent.coding === "identity" ? {} : { "content-encoding": sent.coding })
        }
      })
    : HttpServerResponse.text(
        renderPatchWrapper({
          ...served.value,
          html,
          handlerKinds: handlerKinds(served.value.version.manifest.handlers),
          scope: isPublic ? "public" : "company",
          viewerId,
          head: isPublic
            ? publicDirectory
              ? `<template id="patchy-session">${sessionScripts(session)}</template>`
              : undefined
            : sessionScripts(session),
          ...(selection !== undefined && served.value.version.tier >= 1
            ? {
                nonce: newInternalId("boot"),
                base: `/${served.value.patch.companyHandle}/${served.value.patch.name}${selection.versionNumber === undefined ? "" : `/~v/${selection.versionNumber}`}`,
                route: selection.route
              }
            : {})
        }),
        { contentType: "text/html", headers }
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
export const addressRouteOf = (
  suffix: string
): { versionNumber?: number | null; route: string } => {
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
 * Only addresses and exact-version content receive viewer admission here.
 * The server owns the signed-in root and the catch-all.
 */
const patches = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const documents = yield* makeDocuments;
    yield* router.add("GET", "/:company/:name/*", servePatch("address", documents));
    yield* router.add("GET", "/~content/:patchId/:versionId", servePatch("content", documents));
  })
).pipe(Layer.provide(Door.layer));

const otherPages = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const publicBaseUrl = yield* PatchesConfig.publicBaseUrl;
    const broker = yield* compress(encoder.encode(brokerScript));
    yield* router.add(
      "GET",
      "/~shell/broker.js",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const coding = negotiate(request.headers["accept-encoding"]);
        // Mixed releases share this path during a rolling deploy. Only bytes whose digest is `v`
        // are kept for good; a shell from another release, or none, revalidates every load.
        const current = new URL(request.url, publicBaseUrl).searchParams.get("v") === brokerDigest;
        return HttpServerResponse.uint8Array(broker[coding], {
          contentType: "text/javascript",
          headers: {
            "cache-control": current ? "public, max-age=31536000, immutable" : "no-cache",
            vary: "Accept-Encoding",
            ...(coding === "identity" ? {} : { "content-encoding": coding })
          }
        });
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
          headers: noticeHeaders
        });
      })
    );
    yield* router.add("*", "/~content/*", notFound);
  })
);

/**
 * The health routes. `/healthz` is shallow, for the load balancer and ECS: a
 * database blip must not make ECS replace every host. `/healthz/deep` is the
 * uptime check's: 200 only while the platform database answers, and either
 * way it names the running build, so anyone can see which revision is live.
 */
export const health = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const revision = yield* Config.String("PATCHY_DEPLOYMENT_REVISION").pipe(
      Config.withDefault("development")
    );
    yield* router.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ ok: true }));
    yield* router.add(
      "GET",
      "/healthz/deep",
      sql`SELECT 1`.pipe(
        // Route 53 waits two seconds for an answer; a slow database is a failed probe.
        Effect.timeout("2 seconds"),
        Effect.as(true),
        // Every failure is the probe's answer, not the route's error.
        Effect.catch(() => Effect.succeed(false)),
        Effect.map((ok) =>
          HttpServerResponse.jsonUnsafe({ ok, revision }, { status: ok ? 200 : 503 })
        )
      )
    );
  })
);

export const layer: Layer.Layer<
  never,
  Config.ConfigError | DeploymentConfig.InvalidLimit,
  | HttpRouter.HttpRouter
  | Session.Session
  | Companies.Companies
  | Users.Users
  | SqlClient.SqlClient
  | Content.Content
  | HttpRouter.Request.From<
      "Requires",
      | Content.Content
      | Patches.Patches
      | Session.Session
      | Analytics.Analytics
      | SqlClient.SqlClient
    >
> = Layer.mergeAll(patches, otherPages, health);
