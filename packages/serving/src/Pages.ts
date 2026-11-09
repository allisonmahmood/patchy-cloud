import { Audiences } from "@patchy/patches";
/**
 * The routes a reader hits: the health checks, patch addresses
 * (`/:company/:name[/~v/:n][/route]`) and exact-version content URLs.
 * The server owns the root and catch-all together. Pages read through
 * `patches`; metadata, visits and opens go through `Patches`, a colleague's
 * first open is reported as `patch.first_opened`, and `Content` reads the
 * HTML only after admission. A content URL's document, its stored bytes with
 * the switcher relay inserted, comes from the host's memory once read,
 * compressed by `Accept-Encoding`. The serving guarantees these routes answer
 * under are `serving-headers.ts`.
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
import {
  type RequireSession,
  Session,
  withCookies,
  sessionScripts,
  returnPath,
  pageResponse
} from "@patchy/auth";
import { WIRE_VERSION, handlerKinds } from "@patchy/api";
import { Cryptography, isWelcomePage, SWITCHER_PATH, switcherRelay } from "@patchy/core";
import { switcherDigest, switcherScript } from "@patchy/core/switcher-script";
import type { Companies, Users } from "@patchy/companies";
import { DeploymentConfig } from "@patchy/limits";
import { Content, GuestGrants, Patches, PatchesConfig } from "@patchy/patches";
import { withReportedCommit } from "@patchy/sql";
import * as Door from "./Door.js";
import { renderNotFound } from "./render.js";
import { renderAddressNotice } from "./address-notice.js";
import { compress, negotiate, type Precompressed } from "./compression.js";
import {
  renderPatchWrapper,
  renderShellNotice,
  isShellNotice,
  type ShellNotice,
  brokerScript,
  brokerDigest,
  withSwitcherRelay
} from "./shell.js";
import {
  NO_REFERRER_POLICY,
  CONTENT_SECURITY_POLICY,
  PATCH_CONTENT_SECURITY_POLICY,
  PATCH_ROBOTS_TAG,
  PUBLIC_PATCH_CACHE_CONTROL,
  PRIVATE_PATCH_CACHE_CONTROL,
  PATCH_PERMISSIONS_POLICY,
  noticeContentSecurityPolicy,
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

/**
 * A stopping or needs-rebuild notice. A top-level one for an active signed-in viewer loads their
 * switcher and the session's scripts under the policy that admits them; anyone else's, the public
 * page's and a framed one carry the relay alone. Each is private and never stored, so one viewer's
 * notice can't reach anyone else.
 */
const shellNotice = (
  code: ShellNotice,
  returnTo: string,
  options: {
    readonly status?: number;
    readonly viewer?: RequireSession.Viewer["Service"] | undefined;
    /** The patch the notice is about, when Serving knows it. */
    readonly patchId?: string;
    readonly session: Session.Session["Service"];
  }
) => {
  const { viewer, session } = options;
  return HttpServerResponse.text(
    renderShellNotice(
      code,
      returnTo,
      viewer && {
        userId: viewer.user.id,
        companyId: viewer.company.id,
        patchId: options.patchId,
        session: sessionScripts(session)
      }
    ),
    {
      contentType: "text/html",
      status: options.status ?? 200,
      headers: {
        ...patchUrlHeaders,
        "content-security-policy":
          viewer === undefined
            ? PATCH_CONTENT_SECURITY_POLICY
            : noticeContentSecurityPolicy(session.clerk?.frontendApiHost)
      }
    }
  );
};

/** What names a version's stored document: its object key and recorded digest, and its size. */
type StoredDocument = Pick<Patches.PatchVersion, "objectKey" | "contentHash" | "fileSize">;

/** A document in every coding while the host keeps it; one too large to keep has identity alone. */
type Document = Precompressed | Pick<Precompressed, "identity">;

const encoder = new TextEncoder();
/** What the relay adds to every document, whatever its stored size. */
const relayBytes = encoder.encode(switcherRelay).byteLength;

/** How a kept document is compressed: `compress`, which tests replace to watch it run. */
export const DocumentCompression = Context.Reference<
  (body: Uint8Array) => Effect.Effect<Precompressed>
>("@patchy/serving/Pages/DocumentCompression", { defaultValue: () => compress });

/**
 * Content URL documents in memory, within the `serving.contentCache.*` bounds. The body is the
 * stored bytes with the switcher relay first in their head, the same for every viewer who passes
 * the door, so a kept or compressed body suits them all: the nonce stays in the URL and every
 * header is computed per request. A miss checks the stored bytes against the version's recorded
 * digest before the relay goes in and anyone receives them.
 *
 * A host reads and prepares at most four documents at a time, from the read through keeping
 * them, so documents waiting their turn hold no bytes; their wait counts against the job's
 * deadline. Within those four, it compresses one at a time, leaving the rest of libuv's
 * threadpool to file, crypto and DNS work, while the others' storage reads overlap.
 */
const makeDocuments = Effect.gen(function* () {
  const cryptography = yield* Cryptography.Cryptography;
  const content = yield* Content.Content;
  const deployment = yield* DeploymentConfig.load;
  const compressDocument = yield* DocumentCompression;
  const preparing = yield* Semaphore.make(4);
  const compressing = yield* Semaphore.make(1);
  const prepare = Effect.fnUntraced(function* (stored: StoredDocument, keep: boolean) {
    const html = yield* content.read(stored);
    if ((yield* cryptography.contentHash(html)) !== stored.contentHash)
      return yield* new StoredDocumentMismatch({ objectKey: stored.objectKey });
    const identity = encoder.encode(withSwitcherRelay(html));
    // One that won't be kept goes out uncompressed, rather than compressed on every load. The
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
    size: (stored) => stored.fileSize + relayBytes,
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

/** Whether this person may open this version as the patch's guest. */
const grantedGuest = Effect.fn("Pages.grantedGuest")(function* (
  patch: Patches.Patch,
  version: Patches.PatchVersion,
  userId: string
) {
  const host = yield* (yield* GuestGrants.GuestGrants)
    .host({
      patchId: patch.id,
      userId,
      state: patch.state,
      current: patch.currentVersionId === version.id,
      version
    })
    .pipe(Effect.catchTags({ SqlError: Effect.die, ConnectionStorageFailed: Effect.die }));
  return Option.isSome(host);
});

const servePatch = Effect.fn("Pages.servePatch")(function* (
  kind: "address" | "content",
  documents: Documents
) {
  const cryptography = yield* Cryptography.Cryptography;
  const patches = yield* Patches.Patches;
  const analytics = yield* Analytics.Analytics;
  const { result: admission, cookies, handshake } = yield* Door.Admission;
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
  // A public page follows the redirect that completes a verified sign-in, and its address the
  // handshake Clerk starts for a session the browser holds, so a member whose token lapsed is
  // known on the way back. Nothing else admission says reaches a public reader: a content URL
  // never starts a handshake, and no one is asked to sign in or join.
  const followsHandshake =
    handshake === "completed" || (kind === "address" && handshake === "session");
  if (!isPublic || followsHandshake) {
    if (HttpServerResponse.isHttpServerResponse(admission)) {
      return withCookies(
        HttpServerResponse.setHeaders(admission, {
          ...patchUrlHeaders,
          "referrer-policy": admission.headers["referrer-policy"] ?? NO_REFERRER_POLICY
        }),
        cookies
      );
    }
    if (
      served.value.patch.companyId === admission.company.id &&
      !(yield* Audiences.canOpen(
        served.value.patch.id,
        admission.company.id,
        admission.user.id
      ).pipe(Effect.catchTags({ SqlError: Effect.die })))
    ) {
      return withCookies(HttpServerResponse.setHeaders(notFound, patchUrlHeaders), cookies);
    }
    // Someone from another company opens only the current version of a patch shared with them,
    // while its guests can open it; anyone else gets the same 404 as a stranger.
    if (
      served.value.patch.companyId !== admission.company.id &&
      !(yield* grantedGuest(served.value.patch, served.value.version, admission.user.id))
    ) {
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
  // Clerk's cookies, which renew or end the session or finish a handshake, go out on every page,
  // and a page that sets one is never publicly cached. A handshake's own cookies belong to its
  // redirect, so a public page that didn't follow one drops them.
  const pageCookies = handshake === undefined ? cookies : [];
  if (url !== undefined && isAlias) {
    return withCookies(
      HttpServerResponse.redirect(
        `/${served.value.patch.companyHandle}/${served.value.patch.name}${suffix}${url.search}`,
        { status: 308, headers: patchUrlHeaders }
      ),
      pageCookies
    );
  }
  // Whom the page is rendered for: a company page's admitted viewer, a guest included, or a public
  // patch's own signed-in member at its address. The member gets the public page as anyone does,
  // with their switcher and session on top, so the document they read is everyone's. Anyone
  // else's public page, and every public frame's content, is rendered for no one.
  const viewer = HttpServerResponse.isHttpServerResponse(admission)
    ? undefined
    : !isPublic || (kind === "address" && admission.company.id === served.value.patch.companyId)
      ? admission
      : undefined;
  if (served.value.version.wireVersion !== WIRE_VERSION) {
    return withCookies(
      shellNotice("needs_rebuild", request.url, {
        status: 409,
        // A frame's notice keeps the relay alone. The switcher treats the patch that can't open as
        // the one on screen: never a row, and never the flip back.
        viewer: kind === "address" ? viewer : undefined,
        patchId: served.value.patch.id,
        session
      }),
      pageCookies
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
  // frame's content request, is an open for their own Home: it is what clears "new to you". A
  // public patch's member counts too; a public page rendered for no one records none.
  const viewerId = viewer?.user.id;
  // A guest has no Home in the patch's company to record an open for.
  const member =
    !HttpServerResponse.isHttpServerResponse(admission) &&
    admission.company.id === served.value.patch.companyId;
  // A colleague's first open is the one business event serving reports: activation is counted
  // in it. It reports with the open's commit, so a reader who leaves mid-COMMIT can't leave a first
  // open recorded and never reported, while the open itself, lock waits included, stays
  // cancellable. Tracking never fails the page.
  if (kind === "address" && viewerId !== undefined && member) {
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

  // The public page caches for a minute when it is no one's, sets no cookie and isn't reloading a
  // stale shell. Its members' copy carries their switcher, so it varies by Cookie: a cache never
  // hands a member, or anyone whose session changed, the copy it kept for someone else.
  const cacheable =
    isPublic &&
    viewer === undefined &&
    pageCookies.length === 0 &&
    url?.searchParams.get("__patchy_shell_reload") !== "1";
  const headers = {
    ...patchUrlHeaders,
    "content-security-policy":
      kind === "content"
        ? CONTENT_SECURITY_POLICY
        : shellContentSecurityPolicy(viewer && session.clerk?.frontendApiHost),
    ...(kind === "content" ? { "permissions-policy": PATCH_PERMISSIONS_POLICY } : {}),
    "cache-control": cacheable ? PUBLIC_PATCH_CACHE_CONTROL : PRIVATE_PATCH_CACHE_CONTROL,
    ...(cacheable && kind === "address" ? { vary: "Cookie" } : {})
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
          handlerKinds: handlerKinds(served.value.version.manifest.handlers),
          scope: isPublic ? "public" : "company",
          viewerId,
          // The viewer's own company, a guest's too, keys the switcher's list.
          companyId: viewer?.company.id,
          head: viewer && sessionScripts(session),
          // Only an address renders a shell, so its route selection is always there.
          nonce: yield* cryptography.internalId("boot"),
          base: `/${served.value.patch.companyHandle}/${served.value.patch.name}${selection?.versionNumber === undefined ? "" : `/~v/${selection.versionNumber}`}`,
          ...(selection === undefined ? {} : { route: selection.route })
        }),
        { contentType: "text/html", headers }
      );
  return withCookies(response, pageCookies);
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
    // Shell scripts by URL. Mixed releases share each path during a rolling deploy: only bytes
    // whose digest is `v` are kept for good, and a page from another release, or none,
    // revalidates every load.
    for (const [path, text, digest] of [
      ["/~shell/broker.js", brokerScript, brokerDigest],
      [SWITCHER_PATH, switcherScript, switcherDigest]
    ] as const) {
      const bytes = yield* compress(encoder.encode(text));
      yield* router.add(
        "GET",
        path,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const coding = negotiate(request.headers["accept-encoding"]);
          const current = new URL(request.url, publicBaseUrl).searchParams.get("v") === digest;
          return HttpServerResponse.uint8Array(bytes[coding], {
            contentType: "text/javascript",
            headers: {
              "cache-control": current ? "public, max-age=31536000, immutable" : "no-cache",
              vary: "Accept-Encoding",
              ...(coding === "identity" ? {} : { "content-encoding": coding })
            }
          });
        })
      );
    }
    yield* router.add(
      "GET",
      "/~shell/notice/:code",
      Effect.gen(function* () {
        const { code } = yield* HttpRouter.params;
        if (code === undefined || !isShellNotice(code)) return notFound;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, publicBaseUrl);
        const returnTo = returnPath(url.searchParams.get("return"), publicBaseUrl) ?? "/";
        const { viewer, cookies } = yield* Door.noticeViewer;
        return withCookies(
          shellNotice(code, returnTo, { viewer, session: yield* Session.Session }),
          cookies
        );
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
  | Cryptography.Cryptography
  | HttpRouter.Request.From<
      "Requires",
      | Cryptography.Cryptography
      | Content.Content
      | Patches.Patches
      | GuestGrants.GuestGrants
      | Session.Session
      | Users.Users
      | Analytics.Analytics
      | SqlClient.SqlClient
    >
> = Layer.mergeAll(patches, otherPages, health);
