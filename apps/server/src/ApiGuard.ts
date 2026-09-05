/**
 * The guard on `/api/*`, ahead of the router.
 *
 * The API's own bearer middleware authenticates every route the router
 * matches, before a body is read. What it cannot cover is everything that
 * never reaches a handler, and the contract there is the same one: every
 * `/api/*` request spends one attempt of the per-address protected-API limit,
 * then needs a token. A request the router
 * would refuse for its shape — a malformed target, an overlong patch id — or
 * not find at all learns that only once it has authenticated, so a caller
 * with no token cannot map the API by its status codes, and a flood of them
 * runs into the limit like any other.
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

/** No API paths admit unauthenticated callers until device login lands. */
const UNAUTHENTICATED_PATHS: Readonly<Record<string, true>> = {};

/**
 * The longest path parameter a patch route takes. Longer is a too-long target
 * on a route that exists, and a route that never existed anywhere else.
 */
const MAX_PARAM_LENGTH = 100;

/**
 * The routes that take a patch id, read off the contract: `METHOD /api/patches/:patchId`
 * and `METHOD /api/patches/:patchId/<suffix>`. An overlong parameter on one of
 * these is a too-long target; on any other shape it is a route that never
 * existed. Derived, so a route added to the API answers 414 without a table
 * here to keep in step.
 */
const PATCH_ROUTES = new Set(
  Object.values(PatchyApi.groups)
    .flatMap((group) => Object.values(group.endpoints))
    .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    .filter((route) => route.includes(" /api/patches/:patchId"))
);

/**
 * What the guard makes of a request target: not the API's business at all,
 * the API's to route, or a shape the router never sees, answered after the
 * token check with the status the wire names for it.
 */
export type Target =
  | { readonly kind: "public" }
  | { readonly kind: "route" }
  | { readonly kind: "refused"; readonly status: 400 | 404 | 414 };

export function classify(method: string, requestTarget: string): Target {
  const pathname = canonicalPath(requestTarget);
  if (pathname === null) {
    return hasLexicalApiPrefix(requestTarget)
      ? { kind: "refused", status: 400 }
      : { kind: "public" };
  }
  if (Object.hasOwn(UNAUTHENTICATED_PATHS, pathname)) return { kind: "public" };
  if (!isApiPath(pathname)) {
    // An encoded slash is one segment to the router, so `/api%2Fuploads` can
    // never route; it still reads as a probe of the API, and answers as one.
    return isApiPath(normalize(pathname.replace(/%2f/gi, "/")))
      ? { kind: "refused", status: 404 }
      : { kind: "public" };
  }
  const status = overlongParamStatus(method, rawPath(requestTarget));
  return status === undefined ? { kind: "route" } : { kind: "refused", status };
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

/**
 * The middleware. Reads the limit once; the services it needs are captured
 * here so the request path asks the environment for nothing.
 */
export const make = Effect.gen(function* () {
  const limits = yield* Limits.Limits;
  const tokens = yield* MachineTokens.MachineTokens;
  const limit = yield* protectedApiRateLimitPerMinute;

  return HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const target = classify(request.method, request.url);
      if (target.kind === "public") return yield* app;

      // Keyed by source address — after the trusted-proxy walk, so a proxy in
      // front of the instance does not share one bucket with everyone behind it.
      const attempt = yield* limits.consume({
        key: `protected-api:${Option.getOrElse(request.remoteAddress, () => "")}`,
        limit,
        window: "1 minute"
      });
      if (!attempt.allowed) return rateLimited(attempt);

      if (target.kind === "route") return yield* app;
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
 * The answer to an overlong `:patchId`, when there is one: 414 on the shape
 * of a route that exists, 404 on one that never did, and nothing at all when
 * the parameter is a length the routes take.
 */
function overlongParamStatus(method: string, path: string): 404 | 414 | undefined {
  const [leading, api, patches, parameter, suffix, ...rest] = path.split("/");
  if (
    leading !== "" ||
    api === undefined ||
    patches === undefined ||
    parameter === undefined ||
    decodeURI(api) !== "api" ||
    decodeURI(patches) !== "patches" ||
    decodeURIComponent(parameter).length <= MAX_PARAM_LENGTH
  ) {
    return undefined;
  }

  const shape =
    suffix === undefined ? "/api/patches/:patchId" : `/api/patches/:patchId/${decodeURI(suffix)}`;
  return rest.length === 0 && PATCH_ROUTES.has(`${method} ${shape}`) ? 414 : 404;
}
