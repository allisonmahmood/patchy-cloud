import type { IncomingMessage } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import type { ServerConfig } from "@patchy/config";
import type { Limits } from "@patchy/limits";
import {
  BadRequest,
  DisableRequest,
  Forbidden,
  hasScope,
  type Identity,
  NotFound,
  PayloadTooLarge,
  RateLimited,
  RequestTargetTooLong,
  Unauthorized,
  UploadRequest
} from "@patchy/api";
import { Bearer } from "@patchy/auth";
import {
  authenticate,
  consume,
  readPatch,
  recordVisit,
  serveApi,
  type ServerRuntime
} from "./runtime.js";
import { renderHome, renderNotFound, renderPatchWrapper } from "./render.js";
import {
  NO_REFERRER_POLICY,
  NO_STORE_CACHE_CONTROL,
  PATCH_CONTENT_SECURITY_POLICY,
  PATCH_ROBOTS_TAG,
  servedPatchCacheControl
} from "./serving-headers.js";
import { decodeBody, sendWire } from "./wire.js";

export interface CreateAppOptions {
  config: ServerConfig;
  /** The Effect side — analytics, the rate limiter, tokens, patches, the content store and the API — behind one runtime. */
  runtime: ServerRuntime;
}

/**
 * The per-minute limits the app enforces before a body is read. Only these
 * live in memory; the create limit and the patch quota are `@patchy/patches`'
 * and the mint limit `@patchy/auth`'s, spent inside their handlers. Every
 * limit shares one store, so each prefixes its keys with its own name.
 */
type RateLimitName = "protected-api" | "authenticated-upload";

type ConsumeLimit = (name: RateLimitName, key: string) => Promise<Limits.ConsumeResult>;

declare module "fastify" {
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
const REGISTERED_PATCH_POST_SUFFIXES = new Set(["disable", "pin", "unpin"]);
const PRE_ROUTING_API_ERROR_TARGET = "/api/__patchy_pre_routing_error__";
const preRoutingApiErrorStatus = Symbol("preRoutingApiErrorStatus");

type PreRoutingApiErrorStatus = 400 | 404 | 414;
type MarkedIncomingMessage = IncomingMessage & {
  [preRoutingApiErrorStatus]?: PreRoutingApiErrorStatus;
};

export function createApp(options: CreateAppOptions): FastifyInstance {
  const limitPerMinute: Record<RateLimitName, number> = {
    "protected-api": options.config.protectedApiRateLimitPerMinute,
    "authenticated-upload": options.config.authenticatedUploadRateLimitPerMinute
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
    // Served patches set their own cache policy; everything else stays uncached.
    if (!reply.hasHeader("Cache-Control")) {
      reply.header("Cache-Control", NO_STORE_CACHE_CONTROL);
    }
  });

  app.addHook("onRequest", protectedApiPrefixGuard(options.runtime, consumeLimit));

  const protectedApi = (requiredScope?: string, hookOptions: ProtectedApiHookOptions = {}) =>
    protectedApiRouteHook(requiredScope, hookOptions, consumeLimit);

  app.get("/", async (_request, reply) => {
    return reply
      .type("text/html")
      .send(renderHome({ publicBaseUrl: options.config.publicBaseUrl }));
  });

  app.get("/healthz", async () => ({ ok: true }));

  // Every `/api/*` route is answered by the capability packages' handlers
  // through the runtime seam. The guard above still runs first, so the
  // auth-before-body contract and the per-minute protected-API limit are
  // exactly what they are for every route; the handlers check the scope
  // again themselves.
  const api = (request: FastifyRequest, reply: FastifyReply) =>
    serveApi(options.runtime, request, reply);
  app.get("/api/me", { onRequest: protectedApi() }, api);
  app.post("/api/tokens", { onRequest: protectedApi("admin") }, api);
  app.post("/api/tokens/:apiTokenId/revoke", { onRequest: protectedApi("admin") }, api);

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

    mintScope.post(SELF_SERVICE_MINT_PATH, api);
  });

  app.get("/api/patches/:patchId", { onRequest: protectedApi("admin") }, api);
  app.get("/api/principals/:principalId/patches", { onRequest: protectedApi("admin") }, api);

  // The body is decoded here first, so a bad field keeps the answer it has
  // always had; the handler decodes the good one again through the same schema.
  app.post(
    "/api/uploads",
    {
      onRequest: protectedApi("upload", { uploadLimit: true })
    },
    async (request, reply) => {
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
      return api(request, reply);
    }
  );

  app.post(
    "/api/patches/:patchId/disable",
    { onRequest: protectedApi() },
    async (request, reply) => {
      if (!decodeBody(DisableRequest, request.body).ok) {
        return sendWire(reply, BadRequest, { ok: false, error: "Malformed request body." });
      }
      return api(request, reply);
    }
  );

  for (const suffix of ["pin", "unpin"]) {
    app.post(`/api/patches/:patchId/${suffix}`, { onRequest: protectedApi("admin") }, api);
  }

  app.delete("/api/patches/:patchId", { onRequest: protectedApi() }, api);

  app.get("/d/:patchId", async (request, reply) => {
    const patchId = (request.params as { patchId: string }).patchId;
    return renderPatch(options, patchId, undefined, reply);
  });

  app.get("/d/:patchId/v/:versionNumber", async (request, reply) => {
    const params = request.params as { patchId: string; versionNumber: string };
    return renderPatch(options, params.patchId, Number(params.versionNumber), reply);
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

async function renderPatch(
  options: CreateAppOptions,
  patchId: string,
  versionNumber: number | undefined,
  reply: FastifyReply
): Promise<void> {
  reply.header("X-Robots-Tag", PATCH_ROBOTS_TAG);
  reply.header("Referrer-Policy", NO_REFERRER_POLICY);

  const served = await readPatch(options.runtime, patchId, versionNumber);
  if (!served) {
    return reply.status(404).type("text/html").send(renderNotFound());
  }

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
  try {
    await recordVisit(options.runtime, served.patch.id);
  } catch (error) {
    reply.log.warn({ err: error, patchId: served.patch.id }, "Patch visit top-up failed.");
  }
  reply.header("Content-Security-Policy", PATCH_CONTENT_SECURITY_POLICY);
  reply.header("Cache-Control", servedPatchCacheControl(versionNumber));
  return reply.type("text/html").send(renderPatchWrapper(served));
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
      if (!hasScope(authState.auth, targetPolicy.requiredScope)) {
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
    if (requiredScope && !scopeAlreadyChecked && !hasScope(auth, requiredScope)) {
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
      REGISTERED_PATCH_POST_SUFFIXES.has(decodeURI(rawSuffix));
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
