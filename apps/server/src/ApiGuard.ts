/**
 * The API guard, ahead of the router.
 *
 * The API's own bearer middleware authenticates every protected route the
 * router matches, before a body is read. Release discovery and the two POST
 * device-login routes are anonymous. Publish has its own limits after its
 * authenticated replay lookup; the guard must not throttle a recovery attempt.
 * Runtime has its own browser admission and per-viewer/patch limit.
 * Other `/api/*` requests spend the per-address protected-API limit, then need
 * a token. Malformed targets and missing routes disclose their shape only
 * after authentication.
 * The portal owns its name bound through GET /patches/*.
 *
 * Two pieces: `make`, the middleware that spends the limit and answers the
 * shapes the router never sees; and `notFound`, the `/api/*` catch-all route
 * that authenticates and then says so for everything else.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  BadRequest,
  NotFound,
  PatchyApi,
  rateLimited,
  refuse,
  RequestTargetTooLong
} from "@patchy/api";
import { Authorization, MachineTokens } from "@patchy/auth";
import { Limits } from "@patchy/limits";

/** Protected-API attempts admitted per source address per minute, in memory. */
export const protectedApiRateLimitPerMinute = Config.int(
  "PATCHY_PROTECTED_API_RATE_LIMIT_PER_MINUTE"
).pipe(Config.withDefault(60));

/** Device-login starts admitted per source address per minute, in memory. */
export const deviceLoginRateLimitPerMinute = Config.int(
  "PATCHY_DEVICE_LOGIN_RATE_LIMIT_PER_MINUTE"
).pipe(Config.withDefault(5));

/**
 * Concrete patch routes that may exceed the router's 100-character parameter
 * limit. Route owners supply the shapes so adding a route cannot leave its
 * too-long target behind.
 */
const PATCH_ROUTES: ReadonlyArray<{
  readonly kind: "api";
  readonly prefix: readonly string[];
  readonly routes: ReadonlyArray<{ method: string; suffix: readonly string[] }>;
}> = [
  {
    kind: "api",
    prefix: ["api", "patches"],
    routes: Object.values(PatchyApi.groups)
      .flatMap((group) => Object.values(group.endpoints))
      .filter((endpoint) => /^\/api\/patches\/:(patchId|patchRef)(\/|$)/.test(endpoint.path))
      .map((endpoint) => ({
        method: endpoint.method,
        suffix: endpoint.path.split("/").slice(4)
      }))
  }
];

/**
 * What the guard makes of a request target: not the API's business at all,
 * the API's to route, or a shape the router never sees, answered after the
 * token check with the status the wire names for it.
 */
export type Target =
  | { readonly kind: "public" }
  | { readonly kind: "route" }
  | { readonly kind: "publish" }
  | { readonly kind: "runtime" }
  | { readonly kind: "device-login"; readonly action: "start" | "poll" }
  | { readonly kind: "refused"; readonly status: 400 | 404 | 414 };

export function classify(method: string, requestTarget: string): Target {
  const pathname = canonicalPath(requestTarget);
  if (pathname === null) {
    return hasLexicalApiPrefix(requestTarget)
      ? { kind: "refused", status: 400 }
      : { kind: "public" };
  }
  if (method === "GET" && pathname === "/api/release") return { kind: "public" };
  if (method === "POST" && pathname === "/api/publish") return { kind: "publish" };
  // Browser runtime admission owns its session, audience and per-viewer limit.
  if (
    (method === "POST" && pathname === "/api/runtime/call") ||
    ((method === "PUT" || method === "GET") &&
      /^\/api\/runtime\/files\/[^/]+\/[^/]+\/[^/]+\/.+$/.test(pathname))
  )
    return { kind: "runtime" };
  if (method === "POST") {
    if (pathname === "/api/login/device") return { kind: "device-login", action: "start" };
    if (pathname === "/api/login/device/token") return { kind: "device-login", action: "poll" };
  }
  if (pathname.startsWith("/api/patches/")) {
    const target = overlongParamTarget(method, rawPath(requestTarget));
    if (target !== undefined) return target;
  }
  if (!isApiPath(pathname)) {
    // An encoded slash is one segment to the router, so `/api%2Fpublish` can
    // never route; it still reads as a probe of the API, and answers as one.
    return isApiPath(normalize(pathname.replace(/%2f/gi, "/")))
      ? { kind: "refused", status: 404 }
      : { kind: "public" };
  }
  return { kind: "route" };
}

const notFoundBody = refuse(NotFound, { ok: false, error: "Not found." });

const refusal = (status: 400 | 404 | 414) =>
  status === 400
    ? refuse(BadRequest, { ok: false, error: "Malformed request target." })
    : status === 404
      ? notFoundBody
      : refuse(RequestTargetTooLong, { ok: false, error: "Request target is too long." });

/** The identity behind the request, or the 401 it gets instead. */
const authenticated = <E, R>(
  answer: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest | MachineTokens.MachineTokens
> =>
  Effect.flatMap(Authorization.identify, (identity) =>
    Option.isNone(identity) ? Effect.succeed(Authorization.unauthorized) : answer
  );

/** The middleware. Reads the API limits once and captures their services. */
export const make = Effect.gen(function* () {
  const limits = yield* Limits.Limits;
  const tokens = yield* MachineTokens.MachineTokens;
  const limit = yield* protectedApiRateLimitPerMinute;
  const deviceLimit = yield* deviceLoginRateLimitPerMinute;

  return HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const target = classify(request.method, request.url);
      if (target.kind === "public" || target.kind === "publish" || target.kind === "runtime")
        return yield* app;
      if (target.kind === "device-login" && target.action === "poll") return yield* app;

      // Keyed by source address — after the trusted-proxy walk, so a proxy in
      // front of the instance does not share one bucket with everyone behind it.
      const attempt = yield* limits.consume({
        key: `${target.kind === "device-login" ? "device-login" : "protected-api"}:${Option.getOrElse(request.remoteAddress, () => "")}`,
        limit: target.kind === "device-login" ? deviceLimit : limit,
        window: "1 minute"
      });
      if (!attempt.allowed) return rateLimited(attempt);

      if (target.kind === "route" || target.kind === "device-login") return yield* app;
      return yield* authenticated(Effect.succeed(refusal(target.status))).pipe(
        Effect.provideService(MachineTokens.MachineTokens, tokens)
      );
    })
  );
});

/**
 * The route for every `/api/*` target the router has no handler for, the
 * wrong method on a real route included: a token first, then `Not found.`
 * The router prefers any real route over this wildcard.
 */
export const notFound = HttpRouter.add("*", "/api/*", authenticated(Effect.succeed(notFoundBody)));

// --- request-target classification ----------------------------------------

/** The path of a request target, whether origin-form or absolute-form. */
function rawPath(requestTarget: string): string {
  const end = requestTarget.search(/[?#]/);
  const withoutQuery = end === -1 ? requestTarget : requestTarget.slice(0, end);
  const absolutePrefix = /^https?:\/\//i.exec(withoutQuery)?.[0];
  if (!absolutePrefix) return withoutQuery;
  const pathStart = withoutQuery.indexOf("/", absolutePrefix.length);
  return pathStart === -1 ? "/" : withoutQuery.slice(pathStart);
}

/**
 * The path as the router will see it — escapes decoded, runs of slashes
 * collapsed, the trailing one dropped — or `null` when it does not decode at
 * all. An encoded slash stays one segment, as it does for the router.
 */
function canonicalPath(requestTarget: string): string | null {
  try {
    return normalize(decodeURI(rawPath(requestTarget)));
  } catch {
    return null;
  }
}

/**
 * Whether a target that does not decode still spells `/api` once its ASCII
 * escapes are read: `/%61pi/%` is the API's malformed request, `/public/%`
 * is nobody's.
 */
function hasLexicalApiPrefix(requestTarget: string): boolean {
  const asciiDecoded = rawPath(requestTarget).replace(
    /%([0-7][0-9a-f])/gi,
    (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))
  );
  return isApiPath(normalize(asciiDecoded));
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function normalize(pathname: string): string {
  const collapsed = pathname.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/g, "") : collapsed;
}

/**
 * Only concrete API routes get a guard-generated 414. Unmatched API targets
 * require a token before their 404.
 */
function overlongParamTarget(method: string, path: string): Target | undefined {
  const segments = normalize(path).split("/");
  if (segments[0] !== "") return undefined;
  for (const group of PATCH_ROUTES) {
    if (!group.prefix.every((segment, index) => segment === decodeURI(segments[index + 1] ?? ""))) {
      continue;
    }
    const parameter = segments[group.prefix.length + 1];
    if (parameter === undefined || decodeURIComponent(parameter).length <= 100) return undefined;
    const suffix = segments.slice(group.prefix.length + 2);
    const exists = group.routes.some(
      (route) =>
        route.method === method &&
        route.suffix.length === suffix.length &&
        route.suffix.every((segment, index) =>
          segment.startsWith(":") ? suffix[index] !== "" : segment === decodeURI(suffix[index]!)
        )
    );
    return { kind: "refused", status: exists ? 414 : 404 };
  }
  return undefined;
}
