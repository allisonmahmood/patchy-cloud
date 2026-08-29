import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import type { ServerConfig } from "@patchy/config";
import { isUploadTargetError } from "@patchy/db";
import type {
  ModeratedDraftRecord,
  PatchyDb,
  RecordUploadInput,
  RecordUploadResult,
  UploadTargetError
} from "@patchy/db";
import type { Limits } from "@patchy/limits";
import {
  BadRequest,
  Conflict,
  DisableRequest,
  Forbidden,
  type Identity,
  InvalidHtml,
  type ModeratedPatch,
  NotFound,
  Ok,
  PatchQuotaExceeded,
  PatchView,
  PayloadTooLarge,
  Pinned,
  PrincipalPatches,
  RateLimited,
  RequestTargetTooLong,
  Unauthorized,
  UploadCreated,
  UploadRequest,
  UploadUpdated
} from "@patchy/api";
import { Bearer, Tokens } from "@patchy/auth";
import { contentHash, newDraftId, newInternalId, validateHtml } from "@patchy/core";
import type { UploadMetadata } from "@patchy/core";
import { createExpirySweep, type ExpirySweepResult } from "./expiry-sweep.js";
import { getDraftPublicUrl } from "./public-url.js";
import {
  authenticate,
  consume,
  deleteObject,
  getObject,
  putObject,
  serveAuthApi,
  track,
  type ServerRuntime
} from "./runtime.js";
import { renderDraftWrapper, renderHome, renderNotFound } from "./render.js";
import {
  DRAFT_CONTENT_SECURITY_POLICY,
  DRAFT_ROBOTS_TAG,
  NO_REFERRER_POLICY,
  NO_STORE_CACHE_CONTROL,
  servedDraftCacheControl
} from "./serving-headers.js";
import { decodeBody, sendWire } from "./wire.js";

export interface CreateAppOptions {
  config: ServerConfig;
  db: PatchyDb;
  /** The Effect side — analytics, the rate limiter, tokens, the content store and the auth API — behind one runtime. */
  runtime: ServerRuntime;
}

/**
 * The per-minute limits the app enforces. Only these live in memory; the
 * long-window ceiling (draft quota) is a database count, so a restart empties
 * these buckets but not that. Every limit shares one store, so each prefixes
 * its keys with its own name. The mint limit is `@patchy/auth`'s.
 */
type RateLimitName = "protected-api" | "authenticated-upload" | "draft-create";

type ConsumeLimit = (name: RateLimitName, key: string) => Promise<Limits.ConsumeResult>;

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Runs the expiry sweep once, against this app's clock. The app owns it so
     * that winding the clock forward and sweeping is one seam, and so that the
     * only thing left to schedule is the calling.
     */
    sweepExpiredDrafts(): Promise<ExpirySweepResult>;
  }

  interface FastifyRequest {
    auth?: Identity;
    authState?: ApiRequestAuthState;
    preBodyAuthorizedScopes?: Set<string>;
    preBodyUploadLimiterConsumed?: boolean;
  }
}

type ApiRequestAuthState =
  { kind: "missing" } | { kind: "invalid" } | { kind: "authenticated"; auth: Identity };

interface ProtectedApiHookOptions {
  uploadLimit?: boolean;
}

type ApiPolicyScope = "admin" | "upload";

type ApiRequestTargetPolicy =
  | { protected: false }
  | {
      protected: true;
      requiredScope?: ApiPolicyScope;
      uploadLimit?: boolean;
    };

/**
 * Self-service minting's route, the service's only unauthenticated write. The
 * operation is `@patchy/auth`'s; the path is named here because the routing
 * policy below has to know it admits a request with no credential.
 */
const SELF_SERVICE_MINT_PATH = "/api/tokens/self-service";

const FASTIFY_DEFAULT_MAX_PARAM_LENGTH = 100;
/**
 * The `POST /api/patches/:patchId/<suffix>` routes that exist. An overlong
 * parameter on one of these is a too-long target; on anything else it is a
 * route that was never there. Adding a route here without adding it below
 * turns its overlong-parameter answer into a 404.
 */
const REGISTERED_DRAFT_POST_SUFFIXES = new Set(["disable", "pin", "unpin"]);
/**
 * How many of a principal's drafts one moderation list read returns, newest
 * first. A truncated answer says so rather than pretending to be whole.
 *
 * The list omits deleted drafts and keeps disabled ones, so *deleting* is the
 * only act that drains a page of results: work the page, read again, see the
 * rest. Disabling takes a draft out of service and leaves it on this list —
 * which is right, because a disabled draft is still one the operator may want
 * to come back and delete.
 */
const MODERATION_DRAFT_LIST_LIMIT = 200;
const PRE_ROUTING_API_ERROR_TARGET = "/api/__patchy_pre_routing_error__";
const preRoutingApiErrorStatus = Symbol("preRoutingApiErrorStatus");

type PreRoutingApiErrorStatus = 400 | 404 | 414;
type MarkedIncomingMessage = IncomingMessage & {
  [preRoutingApiErrorStatus]?: PreRoutingApiErrorStatus;
};

export function createApp(options: CreateAppOptions): FastifyInstance {
  const limitPerMinute: Record<RateLimitName, number> = {
    "protected-api": options.config.protectedApiRateLimitPerMinute,
    "authenticated-upload": options.config.authenticatedUploadRateLimitPerMinute,
    "draft-create": options.config.draftCreateRateLimitPerMinute
  };
  const consumeLimit: ConsumeLimit = (name, key) =>
    consume(options.runtime, {
      key: `${name}:${key}`,
      limit: limitPerMinute[name],
      window: "1 minute"
    });
  const app = Fastify({
    logger: false,
    bodyLimit: Math.max(options.config.maxHtmlBytes * 3, 2 * 1024 * 1024),
    trustProxy: options.config.trustProxy,
    rewriteUrl: rewriteProtectedApiRoutingFailure
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    // Served drafts set their own cache policy; everything else stays uncached.
    if (!reply.hasHeader("Cache-Control")) {
      reply.header("Cache-Control", NO_STORE_CACHE_CONTROL);
    }
  });

  app.addHook("onRequest", protectedApiPrefixGuard(options.runtime, consumeLimit));

  const protectedApi = (requiredScope?: string, hookOptions: ProtectedApiHookOptions = {}) =>
    protectedApiRouteHook(requiredScope, hookOptions, consumeLimit);

  const expirySweep = createExpirySweep({
    db: options.db,
    runtime: options.runtime,
    log: app.log
  });
  app.decorate("sweepExpiredDrafts", () => expirySweep.run());

  app.get("/", async (_request, reply) => {
    return reply
      .type("text/html")
      .send(renderHome({ publicBaseUrl: options.config.publicBaseUrl }));
  });

  app.get("/healthz", async () => ({ ok: true }));

  // The `auth` group — `/api/me`, token issue and revocation, the mint — is
  // answered by `@patchy/auth`'s handlers through the runtime seam. The
  // guard above still runs first, so the auth-before-body contract and the
  // per-minute protected-API limit are exactly what they are for every other
  // protected route; the handlers check the admin scope again themselves.
  const authApi = (request: FastifyRequest, reply: FastifyReply) =>
    serveAuthApi(options.runtime, request, reply);
  app.get("/api/me", { onRequest: protectedApi() }, authApi);
  app.post("/api/tokens", { onRequest: protectedApi("admin") }, authApi);
  app.post("/api/tokens/:apiTokenId/revoke", { onRequest: protectedApi("admin") }, authApi);

  // The mint route parses its own body. The operation takes no input at all, so
  // both an absent body and `{}` have to be accepted — and Fastify's stock JSON
  // parser rejects the absent one whenever the client still sends the JSON
  // content-type, which is the shape the CLI's auto-mint actually puts on the
  // wire. Encapsulated in its own scope so no other route's body handling
  // moves: an upload that arrives empty must keep failing exactly as it does.
  app.register(async (mintScope) => {
    mintScope.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body: string, done) => {
        if (body.trim().length === 0) {
          done(null, {});
          return;
        }
        try {
          done(null, JSON.parse(body) as unknown);
        } catch {
          const malformed = new Error("Malformed JSON body.") as Error & {
            statusCode?: number;
          };
          malformed.statusCode = 400;
          done(malformed);
        }
      }
    );

    mintScope.post(SELF_SERVICE_MINT_PATH, authApi);
  });

  // The moderation loop's first step: a flagged URL, answered with the
  // principal behind it and the token to revoke. Admin-scoped, and deliberately
  // answering for drafts that are already disabled, deleted, or expired — the
  // operator is asked about pages that are off as often as pages that are on.
  app.get("/api/patches/:patchId", { onRequest: protectedApi("admin") }, async (request, reply) => {
    const draftId = (request.params as { patchId: string }).patchId;
    const draft = await options.db.findDraftForModeration(draftId);
    if (!draft) return sendPatchNotFound(reply);
    return sendWire(reply, PatchView, { ok: true, patch: moderationPatchView(draft) });
  });

  // The second step: everything else that principal is holding, so one takedown
  // resolves the whole principal rather than the single page that was flagged.
  app.get(
    "/api/principals/:principalId/patches",
    { onRequest: protectedApi("admin") },
    async (request, reply) => {
      const principalId = (request.params as { principalId: string }).principalId;
      const listing = await options.db.listDraftsByPrincipal(
        principalId,
        MODERATION_DRAFT_LIST_LIMIT
      );

      return sendWire(reply, PrincipalPatches, {
        ok: true,
        principalId,
        patches: listing.drafts.map(moderationPatchView),
        truncated: listing.truncated
      });
    }
  );

  app.post(
    "/api/uploads",
    {
      onRequest: protectedApi("upload", { uploadLimit: true })
    },
    async (request, reply) => {
      const auth = authenticatedRequest(request);

      // The wire renamed this field. A client still sending the old name is
      // told so, rather than being answered with a fresh patch it did not ask for.
      if (typeof request.body === "object" && request.body !== null && "draftId" in request.body) {
        return sendWire(reply, BadRequest, {
          ok: false,
          error:
            "Unknown field draftId: the wire renamed it to patchId. Send patchId to update that patch."
        });
      }
      const decoded = decodeBody(UploadRequest, request.body);
      if (!decoded.ok) {
        // Which field failed decides the answer, as it always has: no usable
        // document is one refusal, an unusable target is another.
        const error =
          decoded.field === "patchId"
            ? "Invalid patch ID."
            : decoded.field === "html"
              ? "Missing HTML document."
              : "Malformed request body.";
        return sendWire(reply, BadRequest, { ok: false, error });
      }
      const body = decoded.value;
      const html = body.html;

      const validation = validateHtml(html, { maxBytes: options.config.maxHtmlBytes });
      if (!validation.ok) {
        return sendWire(reply, InvalidHtml, {
          ok: false,
          errors: validation.errors,
          warnings: validation.warnings
        });
      }

      const requestedDraftId = body.patchId ?? null;

      // Only creates are quota-bearing. An update rewrites a draft the token
      // already holds, so it costs nothing against either ceiling.
      if (requestedDraftId === null) {
        // The per-minute bucket is consumed before the quota is counted, so a
        // client parked at the quota is throttled instead of being free to
        // re-count the database at the higher upload-limit rate. The cost is
        // that such a client sees 403 flip to 429 once its bucket empties.
        const createAttempt = await consumeLimit("draft-create", auth.apiTokenId);
        if (!createAttempt.allowed) {
          sendRateLimited(reply, createAttempt);
          return reply;
        }

        // Recounted from the database every time, so the ceiling outlives a
        // restart. Concurrent creates can overshoot it by at most the burst the
        // per-minute limiter above allows through.
        const liveDrafts = await options.db.countLiveDraftsByCreatorApiToken(auth.apiTokenId);
        if (liveDrafts >= options.config.liveDraftsPerToken) {
          return sendLiveDraftQuotaExceeded(reply, options.config.liveDraftsPerToken);
        }
      }

      const draftId = requestedDraftId || newDraftId();
      const versionId = newInternalId("ver");
      const objectKey = `drafts/${draftId}/versions/${versionId}.html`;
      const filename = cleanText(body.filename);
      const metadata = normalizeMetadata(body.metadata);
      const title = validation.title || filename || "Untitled Draft";

      const uploadInput: RecordUploadInput = {
        intent: requestedDraftId ? "update" : "create",
        draftId,
        versionId,
        accountId: auth.accountId,
        apiTokenId: auth.apiTokenId,
        title,
        objectKey,
        contentHash: contentHash(html),
        fileSize: Buffer.byteLength(html, "utf8"),
        filename,
        metadata,
        sourceIp: request.ip || null,
        userAgent: request.headers["user-agent"] || null
      };

      try {
        await options.db.assertUploadTarget(uploadInput);
      } catch (error) {
        if (!isUploadTargetError(error)) throw error;
        return sendUploadTargetError(reply, error);
      }
      await putObject(options.runtime, objectKey, html);

      let upload: RecordUploadResult;
      try {
        upload = await options.db.recordUpload(uploadInput);
      } catch (error) {
        if (!isUploadTargetError(error)) throw error;
        try {
          await deleteObject(options.runtime, objectKey);
        } catch (cleanupError) {
          app.log.error(cleanupError);
          throw new Error("Upload cleanup failed.", { cause: cleanupError });
        }
        return sendUploadTargetError(reply, error);
      }

      const publicUrl = getDraftPublicUrl({
        draftId,
        publicBaseUrl: options.config.publicBaseUrl
      });

      // Reported once the upload is committed, so the event describes a draft
      // that exists. The size is the stored bytes, not the content.
      track(options.runtime, {
        name: requestedDraftId ? "draft.updated" : "draft.created",
        principalId: auth.accountId,
        properties: {
          draftId: upload.draftId,
          apiTokenId: auth.apiTokenId,
          versionNumber: upload.versionNumber,
          htmlBytes: uploadInput.fileSize
        }
      });

      return sendWire(reply, requestedDraftId ? UploadUpdated : UploadCreated, {
        ok: true,
        patchId: upload.draftId,
        versionId: upload.versionId,
        versionNumber: upload.versionNumber,
        title: upload.title,
        publicUrl,
        warnings: validation.warnings
      });
    }
  );

  app.post(
    "/api/patches/:patchId/disable",
    { onRequest: protectedApi() },
    async (request, reply) => {
      const auth = authenticatedRequest(request);

      const draftId = (request.params as { patchId: string }).patchId;
      const body = decodeBody(DisableRequest, request.body);
      if (!body.ok) return sendMalformedBody(reply);
      const reason = cleanText(body.value.reason) || "Disabled.";
      const disabled = await options.db.disableDraft(draftId, auth.accountId, reason, {
        canModerateAnyPrincipal: Tokens.hasScope(auth, "admin")
      });
      if (!disabled) return sendPatchNotFound(reply);

      track(options.runtime, {
        name: "draft.disabled",
        principalId: auth.accountId,
        properties: { draftId, admin: Tokens.hasScope(auth, "admin") }
      });
      return sendWire(reply, Ok, { ok: true });
    }
  );

  // Pinning is an operator's act on the instance's own pages, so it is
  // admin-scoped and unowned: an admin pins any draft, whoever holds it. The
  // pin exempts the draft from expiry and changes nothing else about it.
  //
  // A pin only holds a draft that is in service, so pinning a deleted or
  // disabled one is a 404 — while unpinning works on anything still there.
  for (const route of [
    { suffix: "pin", pinned: true },
    { suffix: "unpin", pinned: false }
  ] as const) {
    app.post(
      `/api/patches/:patchId/${route.suffix}`,
      { onRequest: protectedApi("admin") },
      async (request, reply) => {
        const draftId = (request.params as { patchId: string }).patchId;
        const applied = await options.db.setDraftPinned(draftId, route.pinned);
        if (!applied) return sendPatchNotFound(reply);
        return sendWire(reply, Pinned, { ok: true, pinned: route.pinned });
      }
    );
  }

  app.delete("/api/patches/:patchId", { onRequest: protectedApi() }, async (request, reply) => {
    const auth = authenticatedRequest(request);

    const draftId = (request.params as { patchId: string }).patchId;
    const deleted = await options.db.deleteDraft(draftId, auth.accountId, {
      canModerateAnyPrincipal: Tokens.hasScope(auth, "admin")
    });
    if (!deleted) return sendPatchNotFound(reply);

    track(options.runtime, {
      name: "draft.deleted",
      principalId: auth.accountId,
      properties: { draftId, admin: Tokens.hasScope(auth, "admin") }
    });
    return sendWire(reply, Ok, { ok: true });
  });

  app.get("/d/:draftId", async (request, reply) => {
    const draftId = (request.params as { draftId: string }).draftId;
    return renderDraft(options, draftId, undefined, reply);
  });

  app.get("/d/:draftId/v/:versionNumber", async (request, reply) => {
    const params = request.params as { draftId: string; versionNumber: string };
    return renderDraft(options, params.draftId, Number(params.versionNumber), reply);
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).type("text/html").send(renderNotFound());
  });

  app.setErrorHandler((error, _request, reply) => {
    const typedError = error as Error & { statusCode?: number };
    const statusCode = typedError.statusCode || 500;
    const message = statusCode >= 500 ? "Internal server error." : typedError.message;
    if (statusCode >= 500) {
      app.log.error(error);
    }
    // Fastify's own refusals. The two the wire names go out through their
    // schemas; anything else keeps the same body at whatever status it carried.
    if (statusCode === 413) return sendWire(reply, PayloadTooLarge, { ok: false, error: message });
    if (statusCode === 400) return sendWire(reply, BadRequest, { ok: false, error: message });
    return reply.status(statusCode).send({ ok: false, error: message });
  });

  return app;
}

async function renderDraft(
  options: CreateAppOptions,
  draftId: string,
  versionNumber: number | undefined,
  reply: FastifyReply
): Promise<void> {
  reply.header("X-Robots-Tag", DRAFT_ROBOTS_TAG);
  reply.header("Referrer-Policy", NO_REFERRER_POLICY);

  const { draft, version } = await options.db.findDraftVersion(draftId, versionNumber);
  if (!draft || !version) {
    return reply.status(404).type("text/html").send(renderNotFound());
  }

  const html = await getObject(options.runtime, version.objectKey);
  // The page is real and already fetched, so this is a visit — the thing that
  // keeps a draft people still visit from ageing out. The database decides
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
  try {
    await options.db.recordDraftVisit(draft.id);
  } catch (error) {
    reply.log.warn({ err: error, draftId: draft.id }, "Draft visit top-up failed.");
  }
  reply.header("Content-Security-Policy", DRAFT_CONTENT_SECURITY_POLICY);
  reply.header("Cache-Control", servedDraftCacheControl(versionNumber));
  return reply.type("text/html").send(renderDraftWrapper({ draft, version, html }));
}

function protectedApiPrefixGuard(runtime: ServerRuntime, consumeLimit: ConsumeLimit) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const targetPolicy = classifyApiRequestTargetPolicy(request.url);
    if (!targetPolicy.protected) return;

    const protectedAttempt = await consumeLimit("protected-api", request.ip);
    if (!protectedAttempt.allowed) {
      sendRateLimited(reply, protectedAttempt);
      return;
    }

    const authState = await authenticateApiRequest(runtime, request);
    request.authState = authState;

    // No configuration admits a tokenless request: a missing credential and a
    // present-but-invalid one are indistinguishable from here on.
    if (authState.kind === "missing" || authState.kind === "invalid") {
      sendUnauthorized(reply);
      return;
    }

    request.auth = authState.auth;

    const routingErrorStatus = (request.raw as MarkedIncomingMessage)[preRoutingApiErrorStatus];
    if (routingErrorStatus) {
      sendPreRoutingApiError(reply, routingErrorStatus);
      return;
    }

    if (targetPolicy.requiredScope) {
      if (!Tokens.hasScope(authState.auth, targetPolicy.requiredScope)) {
        sendForbidden(reply);
        return;
      }
      markPreBodyAuthorizedScope(request, targetPolicy.requiredScope);
    }

    if (targetPolicy.uploadLimit) {
      const uploadAttempt = await consumeLimit("authenticated-upload", authState.auth.apiTokenId);
      request.preBodyUploadLimiterConsumed = true;
      if (!uploadAttempt.allowed) {
        sendRateLimited(reply, uploadAttempt);
        return;
      }
    }

    if (request.is404) {
      sendApiNotFound(reply);
      return;
    }
  };
}

function protectedApiRouteHook(
  requiredScope: string | undefined,
  options: ProtectedApiHookOptions,
  consumeLimit: ConsumeLimit
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = request.auth;
    if (!auth) {
      sendUnauthorized(reply);
      return;
    }

    const scopeAlreadyChecked =
      requiredScope && request.preBodyAuthorizedScopes?.has(requiredScope);
    if (requiredScope && !scopeAlreadyChecked && !Tokens.hasScope(auth, requiredScope)) {
      sendForbidden(reply);
      return;
    }

    if (options.uploadLimit && !request.preBodyUploadLimiterConsumed) {
      const uploadAttempt = await consumeLimit("authenticated-upload", auth.apiTokenId);
      request.preBodyUploadLimiterConsumed = true;
      if (!uploadAttempt.allowed) {
        sendRateLimited(reply, uploadAttempt);
        return;
      }
    }

    request.auth = auth;
  };
}

export function isProtectedApiPath(requestTarget: string): boolean {
  return classifyApiRequestTargetPolicy(requestTarget).protected;
}

function rawRequestTargetPath(requestTarget: string): string {
  const end = requestTarget.search(/[?#]/);
  const targetWithoutQuery = end === -1 ? requestTarget : requestTarget.slice(0, end);
  const absolutePrefix = /^https?:\/\//i.exec(targetWithoutQuery)?.[0];
  if (!absolutePrefix) return targetWithoutQuery;

  const pathStart = targetWithoutQuery.indexOf("/", absolutePrefix.length);
  return pathStart === -1 ? "/" : targetWithoutQuery.slice(pathStart);
}

function registeredApiParamRoutingErrorStatus(
  method: string | undefined,
  rawPath: string
): PreRoutingApiErrorStatus | undefined {
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return undefined;

  const [leading, rawApi, rawPatches, rawParameter, rawSuffix, ...extraSegments] =
    rawPath.split("/");
  if (
    leading !== "" ||
    rawApi === undefined ||
    rawPatches === undefined ||
    rawParameter === undefined ||
    decodeURI(rawApi) !== "api" ||
    decodeURI(rawPatches) !== "patches" ||
    decodeURIComponent(rawParameter).length <= FASTIFY_DEFAULT_MAX_PARAM_LENGTH
  ) {
    return undefined;
  }

  if (method === "POST") {
    const exactRegisteredRoute =
      rawSuffix !== undefined &&
      extraSegments.length === 0 &&
      REGISTERED_DRAFT_POST_SUFFIXES.has(decodeURI(rawSuffix));
    return exactRegisteredRoute ? 414 : 404;
  }

  // GET and DELETE both register the bare `/api/patches/:patchId` shape and
  // nothing under it, so an overlong parameter there is a too-long target and
  // anything deeper is a route that never existed.
  return rawSuffix === undefined ? 414 : 404;
}

function rewriteProtectedApiRoutingFailure(request: IncomingMessage): string {
  const requestTarget = request.url ?? "/";
  const rawPath = rawRequestTargetPath(requestTarget);
  const pathname = canonicalRequestTargetPath(requestTarget);
  const routeErrorStatus =
    pathname === null ? undefined : registeredApiParamRoutingErrorStatus(request.method, rawPath);
  let errorStatus: PreRoutingApiErrorStatus | undefined;

  if (pathname === null) {
    if (!hasLexicalProtectedApiPrefix(requestTarget)) return requestTarget;
    errorStatus = 400;
  } else if (isApiPolicyPath(pathname) && routeErrorStatus) {
    errorStatus = routeErrorStatus;
  }

  if (!errorStatus) return requestTarget;
  (request as MarkedIncomingMessage)[preRoutingApiErrorStatus] = errorStatus;
  return PRE_ROUTING_API_ERROR_TARGET;
}

function hasLexicalProtectedApiPrefix(requestTarget: string): boolean {
  const rawPath = rawRequestTargetPath(requestTarget);
  const asciiDecodedPath = rawPath.replace(/%([0-7][0-9a-f])/gi, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
  return isApiPolicyPath(normalizePolicyPath(asciiDecodedPath));
}

function isApiPolicyPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function canonicalRequestTargetPath(requestTarget: string): string | null {
  const rawPath = rawRequestTargetPath(requestTarget);
  const rawPathWithPolicySeparators = rawPath.replace(/%2f/gi, "/");

  try {
    return normalizePolicyPath(decodeURI(rawPathWithPolicySeparators));
  } catch {
    return null;
  }
}

function classifyApiRequestTargetPolicy(requestTarget: string): ApiRequestTargetPolicy {
  const pathname = canonicalRequestTargetPath(requestTarget);
  if (pathname === null) return { protected: true };
  if (pathname === "/api/uploads") {
    return {
      protected: true,
      requiredScope: "upload",
      uploadLimit: true
    };
  }
  // The one API route that admits a request with no credential at all. It is
  // how a caller gets its first token, so requiring one would be circular; the
  // mint's own guardrails — the enabled flag, the per-address rate limit, and
  // the per-address daily quota — are what stand in for authentication here.
  if (pathname === SELF_SERVICE_MINT_PATH) {
    return { protected: false };
  }
  if (pathname === "/api/tokens") {
    return { protected: true, requiredScope: "admin" };
  }
  return {
    protected: isApiPolicyPath(pathname)
  };
}

function normalizePolicyPath(pathname: string): string {
  const collapsed = pathname.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/g, "") : collapsed;
}

function markPreBodyAuthorizedScope(request: FastifyRequest, scope: string): void {
  request.preBodyAuthorizedScopes ??= new Set();
  request.preBodyAuthorizedScopes.add(scope);
}

function sendPreRoutingApiError(reply: FastifyReply, status: PreRoutingApiErrorStatus): void {
  if (status === 400) {
    sendWire(reply, BadRequest, { ok: false, error: "Malformed request target." });
  } else if (status === 404) {
    sendApiNotFound(reply);
  } else {
    sendWire(reply, RequestTargetTooLong, { ok: false, error: "Request target is too long." });
  }
}

function sendUnauthorized(reply: FastifyReply): void {
  sendWire(reply, Unauthorized, { ok: false, error: "Missing or invalid API token." });
}

function sendForbidden(reply: FastifyReply): void {
  sendWire(reply, Forbidden, { ok: false, error: "API token does not have the required scope." });
}

function sendMalformedBody(reply: FastifyReply): FastifyReply {
  return sendWire(reply, BadRequest, { ok: false, error: "Malformed request body." });
}

function sendPatchNotFound(reply: FastifyReply): FastifyReply {
  return sendWire(reply, NotFound, { ok: false, error: "Patch not found." });
}

/**
 * The upload contract's two refusals, in wire words: the store still says
 * "draft", the wire says "patch". An unavailable target — unknown, unowned,
 * disabled, deleted or expired — is one 404, so the answer never says which.
 */
function sendUploadTargetError(reply: FastifyReply, error: UploadTargetError): FastifyReply {
  return error.statusCode === 404
    ? sendPatchNotFound(reply)
    : sendWire(reply, Conflict, { ok: false, error: "Patch already exists." });
}

function sendRateLimited(reply: FastifyReply, decision: Limits.ConsumeResult): void {
  const { retryAfterSeconds } = decision;
  reply.header("Retry-After", String(retryAfterSeconds));
  sendWire(reply, RateLimited, {
    ok: false,
    error: "Rate limit exceeded.",
    code: "rate_limited",
    retryAfterSeconds
  });
}

// "Patch quota", not "patch limit": the glossary reserves limit-shaped wording
// for the per-minute create limit, which is a different rejection.
function sendLiveDraftQuotaExceeded(reply: FastifyReply, quota: number): FastifyReply {
  return sendWire(reply, PatchQuotaExceeded, {
    ok: false,
    error: `Patch quota reached: ${quota} live patches per token. Delete or let a patch expire before creating another.`,
    code: "live_patch_quota_exceeded",
    quota
  });
}

/**
 * A draft as the moderation surface reports it. Spelled out field by field on
 * purpose: the record grows over time, and an operator response is not the
 * place for whatever a future column happens to hold.
 *
 * "Principal" rather than "account" — the moderation loop is operator-facing,
 * and the glossary's word for the ownership row is what it should hear.
 */
function moderationPatchView(draft: ModeratedDraftRecord): (typeof ModeratedPatch)["Encoded"] {
  return {
    id: draft.id,
    principalId: draft.accountId,
    createdByApiTokenId: draft.createdByApiTokenId,
    title: draft.title,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    expiresAt: draft.expiresAt,
    // A pinned draft is exempt from expiry, so an operator deciding whether to
    // let a page age out needs to know the clock is not going to take it.
    pinnedAt: draft.pinnedAt,
    deletedAt: draft.deletedAt,
    disabledAt: draft.disabledAt,
    disabledReason: draft.disabledReason
  };
}

function sendApiNotFound(reply: FastifyReply): void {
  sendWire(reply, NotFound, { ok: false, error: "Not found." });
}

async function authenticateApiRequest(
  runtime: ServerRuntime,
  request: FastifyRequest
): Promise<ApiRequestAuthState> {
  const credential = Bearer.parse(request.headers.authorization);
  if (credential.kind === "missing") return { kind: "missing" };
  if (credential.kind === "invalid") return { kind: "invalid" };

  const auth = await authenticate(runtime, credential.token);
  return auth ? { kind: "authenticated", auth } : { kind: "invalid" };
}

function authenticatedRequest(request: FastifyRequest): Identity {
  if (!request.auth) {
    throw new Error("Authenticated request is missing API token auth state.");
  }
  return request.auth;
}

function normalizeMetadata(value: unknown): UploadMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    repoOrg: cleanText((value as Record<string, unknown>).repoOrg),
    repoName: cleanText((value as Record<string, unknown>).repoName),
    gitBranch: cleanText((value as Record<string, unknown>).gitBranch),
    gitCommitSha: cleanText((value as Record<string, unknown>).gitCommitSha),
    cliVersion: cleanText((value as Record<string, unknown>).cliVersion),
    fileSha256: cleanText((value as Record<string, unknown>).fileSha256)
  };
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}
