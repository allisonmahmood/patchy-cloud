/**
 * `RequireSession`: the middleware that gates every first-party browser page on a
 * valid Clerk session, and a `Viewer` type that carries the resolved identity
 * through the rest of the app.
 *
 * Behaviour:
 * - No session → 401 with the door page (the "Sign in" link).
 * - Session with no matching user row → 303 to `/join` with the `return` path.
 * - Deactivated user → 403 (no-store) with a *Sign out* control.
 * - Valid session → the `Viewer` is provided to the handler.
 *
 * Origin check: every first-party `POST` must have the correct `Origin` header,
 * and the Origin must not be foreign. Missing or foreign Origin on a `POST`
 * returns 403.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import type { ClerkUser } from "./Session.js";
import * as Session from "./Session.js";
import * as AuthConfig from "./AuthConfig.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Whether Clerk auth is enabled. When false, RequireSession is a no-op. */
export const clerkEnabled = AuthConfig.clerkEnabled;

/** The resolved Clerk secret key (redacted). */
export const clerkSecretKey: Effect.Effect<Redacted.Redacted> = Session.clerkSecretKey;

/** The resolved Clerk publishable key. */
export const clerkPublishableKey: Effect.Effect<string> = Effect.map(
  Session.clerkPublishableKey,
  (r) => Redacted.value(r)
);

/** The resolved optional JWT key. */
export const clerkJwtKey: Effect.Effect<Option.Option<string>> = Effect.map(
  Session.clerkJwtKey,
  (opt) => Option.map(opt, (r) => r)
);

/** The resolved authorized parties. */
export const clerkAuthorizedParties: Effect.Effect<Option.Option<readonly string[]>> = Effect.map(
  Session.clerkAuthorizedParties,
  (opt) => opt
);

/** The public base URL. */
export const patchyPublicBaseUrl: Effect.Effect<string> = Session.patchyPublicBaseUrl;

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

/**
 * The resolved identity for a browser session, as the rest of the app sees it.
 * The user row is looked up fresh per request so deactivation is immediate.
 */
export interface Viewer {
  readonly user: ClerkUser;
  readonly company: Option.Option<{
    readonly id: string;
    readonly role: string;
  }>;
}

/** The effect context tag for the current viewer. */
export const Viewer = Context.GenericTag<Viewer>("@patchy/auth/RequireSession#Viewer");

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

import * as Context from "effect/Context";

/** The context tag for the current Clerk user (resolved from session, without the company lookup). */
export const ClerkUser = Context.GenericTag<ClerkUser>("@patchy/auth/RequireSession#ClerkUser");

// ---------------------------------------------------------------------------
// requireSession
// ---------------------------------------------------------------------------

/**
 * The Effect that resolves a Clerk session on the current request, returning
 * a `Viewer` if the session is valid, or failing with a response if not.
 *
 * Fails with `SessionRequired` when there is no session.
 * Fails with an `HttpServerResponse.HttpServerResponse` when a redirect (to /join)
 * or an error page (deactivated, sign-in failed) must be returned.
 */
export function requireSession(): Effect.Effect<
  Viewer,
  SessionRequired | HttpServerResponse.HttpServerResponse,
  HttpServerRequest.HttpServerRequest | typeof ClerkUser
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const publicBaseUrl = yield* patchyPublicBaseUrl;
    const secretKey = yield* Effect.map(clerkSecretKey, (r) => Redacted.value(r));
    const publishableKey = yield* clerkPublishableKey;
    const jwtKey = yield* clerkJwtKey;
    const authorizedParties = yield* clerkAuthorizedParties;

    const method = request.method ?? "GET";
    const path = request.url ?? "/";

    // Build the Clerk request from the current HTTP request.
    const clerkRequest = Session.buildClerkRequest({
      method,
      path,
      publicBaseUrl,
      cookies: request.headers.cookie,
    });

    // Authenticate against Clerk.
    const result = await Session.authenticate(clerkRequest, {
      secretKey,
      publishableKey,
      jwtKey: Option.getOrUndefined(jwtKey),
      authorizedParties: Option.getOrUndefined(authorizedParties),
    });

    if (result.kind === "handshake") {
      // Clerk wants to redirect the browser — forward the Location header.
      const response = new Response(null, {
        status: 302,
        headers: { location: result.location },
      });
      return yield* HttpServerResponse.fromNodeStream(response.status, response.body, response.headers as Record<string, string>);
    }

    if (result.kind === "signInFailed") {
      // Sign-in could not complete. Return an error page rather than looping.
      const body = `<!doctype html><html><body>
<h1>Sign in could not complete</h1>
<p>${escapeHtml(result.reason)}</p>
<p><a href="/login">Try again</a></p>
</body></html>`;
      return yield* HttpServerResponse.html(body, { status: 401 });
    }

    if (result.kind === "unsigned") {
      // No session. Return the door page (401 with a Sign in link).
      const returnTo = encodeURIComponent(path);
      const body = `<!doctype html><html><body>
<h1>Sign in required</h1>
<p>You must be signed in to access this page.</p>
<p><a href="/login?return=${returnTo}">Sign in with Clerk</a></p>
</body></html>`;
      return yield* HttpServerResponse.html(body, { status: 401 });
    }

    // result.kind === "authenticated"
    const clerkUser: ClerkUser = {
      userId: result.userId,
      email: result.email,
      name: result.name,
      sessionId: result.sessionId,
    };

    // TODO(companies): look up the user row and company membership.
    // For now, return a Viewer without a company — the /join page will be
    // the entry point for creating or joining a company.
    const viewer: Viewer = {
      user: clerkUser,
      company: Option.none(),
    };

    return viewer;
  });
}

/**
 * Middleware that requires a valid Clerk session on every first-party route.
 *
 * For `GET` requests: returns the door page (401 with Sign in link).
 * For `POST` requests: enforces the Origin check (403 on a foreign or missing Origin).
 */
export function withRequireSession<R, E, A>(
  handler: (viewer: Viewer) => Effect.Effect<A, E | HttpServerResponse.HttpServerResponse, R>
): Effect.Effect<
  A,
  E | SessionRequired | HttpServerResponse.HttpServerResponse,
  R | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const viewer = yield* requireSession();
    return yield* handler(viewer);
  });
}

// ---------------------------------------------------------------------------
// Origin check
// ---------------------------------------------------------------------------

/**
 * The error returned when a POST request arrives without a valid Origin header.
 */
export class OriginCheckFailed extends Schema.TaggedError<OriginCheckFailed>()(
  "OriginCheckFailed",
  Schema.Struct({ origin: Schema.string }),
  { message: (self) => `POST request rejected: Origin "${self.origin}" is not allowed.` }
) {}

/**
 * Assert that a POST request carries a valid `Origin` matching the public base URL.
 * Returns the response and throws `OriginCheckFailed` if the check fails.
 */
export function assertPostOrigin(
  request: HttpServerRequest.HttpServerRequest,
  publicBaseUrl: string
): Effect.Effect<void, OriginCheckFailed> {
  if (request.method !== "POST") {
    return Effect.void;
  }

  const origin = request.headers.origin;
  if (!origin) {
    return Effect.fail(new OriginCheckFailed({ origin: "(missing)" }));
  }

  // Parse the allowed origin from the public base URL.
  let allowed: string;
  try {
    const url = new URL(publicBaseUrl);
    allowed = url.origin;
  } catch {
    return Effect.void;
  }

  if (origin !== allowed) {
    return Effect.fail(new OriginCheckFailed({ origin }));
  }

  return Effect.void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
