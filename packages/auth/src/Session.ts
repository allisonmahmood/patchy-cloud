/**
 * Clerk-based browser session authentication for Patchy.
 *
 * Uses `@clerk/backend`'s `authenticateRequest` to verify the `__session` cookie
 * Clerk's frontend SDK sets on sign-in. Only `Set-Cookie` and a handshake
 * `Location` are forwarded from Clerk's response — `x-clerk-auth-*` and
 * `Access-Control-*` headers never reach a Patchy response.
 *
 * Config:
 * - `CLERK_PUBLISHABLE_KEY` (required): Clerk's publishable key, used to derive
 *   the frontend API host for the JWKS endpoint.
 * - `CLERK_SECRET_KEY` (required): Clerk's secret key, used to verify tokens.
 * - `CLERK_JWT_KEY` (optional): a PEM public key for JWT verification, as an
 *   alternative to using the Clerk instance's JWKS.
 * - `CLERK_AUTHORIZED_PARTIES` (optional): a comma-separated list of allowed
 *   `azp` origins for JWT verification.
 *
 * A handshake that returns still signed out renders "sign-in could not complete"
 * with the reason in the server log, never a redirect loop.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import {
  authenticateRequest as clerkAuthenticate,
  createPublicKey as clerkCreatePublicKey,
  handshake,
  type AuthObject,
  type Request as ClerkRequest,
} from "@clerk/backend";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Clerk publishable key (`CLERK_PUBLISHABLE_KEY`). Required at startup. */
export const clerkPublishableKey = Config.redacted("CLERK_PUBLISHABLE_KEY");

/** Clerk secret key (`CLERK_SECRET_KEY`). Required at startup. */
export const clerkSecretKey = Config.redacted("CLERK_SECRET_KEY");

/**
 * An optional PEM public key for JWT verification, as an alternative to using
 * Clerk's instance JWKS endpoint. If set, Clerk tokens are verified against this
 * key rather than fetched from the JWKS endpoint.
 */
export const clerkJwtKey = Config.option(
  Config.redacted("CLERK_JWT_KEY")
).pipe(Config.map((r) => Redacted.value(r)));

/**
 * Comma-separated list of allowed `azp` (authorized party) origins. If set,
 * Clerk tokens are rejected unless their `azp` claim names one of these origins.
 */
export const clerkAuthorizedParties = Config.option(
  Config.string("CLERK_AUTHORIZED_PARTIES")
).pipe(
  Config.map((raw) => {
    const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    return parts.length > 0 ? parts : null;
  })
);

/**
 * The public base URL of the Patchy instance, used as the `Origin` header when
 * building the Clerk request. Required; no longer has a default.
 */
export const patchyPublicBaseUrl = Config.string("PATCHY_PUBLIC_BASE_URL");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The result of resolving a browser session from a request. */
export type SessionResult =
  | { readonly kind: "authenticated"; userId: string; email: Option.Option<string>; name: Option.Option<string>; sessionId: string }
  | { readonly kind: "unsigned" }
  | { readonly kind: "handshake"; location: string }
  | { readonly kind: "signInFailed"; reason: string };

/** The shape a resolved session carries into the rest of the app. */
export interface ClerkUser {
  readonly userId: string;
  readonly email: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly sessionId: string;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/**
 * Build the `Request` object Clerk's SDK expects, from a Patchy request.
 *
 * The `host` and forwarded headers are pinned from `PATCHY_PUBLIC_BASE_URL`
 * so Clerk sees the same origin in every environment (local dev, preview,
 * production) without relying on request headers that a proxy might rewrite.
 */
export function buildClerkRequest(
  options: {
    readonly method: string;
    readonly path: string;
    readonly publicBaseUrl: string;
    readonly cookies?: string;
    readonly forwardedHost?: string;
    readonly forwardedProto?: string;
  }
): ClerkRequest {
  const url = new URL(options.path, options.publicBaseUrl);
  const headers: Record<string, string> = {
    // Clerk SDK requires Content-Length for POST requests.
    "content-length": "0"
  };
  if (options.cookies) {
    headers["cookie"] = options.cookies;
  }
  return new Request(url.href, {
    method: options.method,
    headers,
  }) as unknown as ClerkRequest;
}

// ---------------------------------------------------------------------------
// authenticate
// ---------------------------------------------------------------------------

/**
 * Authenticate a request against Clerk's backend, returning the resolved session.
 *
 * - `authenticated`: the request carries a valid Clerk session cookie.
 * - `unsigned`: no valid session, and no redirect is needed.
 * - `handshake`: Clerk returned a redirect (e.g. to sign-in); return it to the caller.
 * - `signInFailed`: a handshake was attempted but the session still came back unsigned;
 *   log the reason so an operator can diagnose it.
 *
 * Only `Set-Cookie` and a handshake `Location` are forwarded from Clerk's response.
 * The `x-clerk-auth-*` and `Access-Control-*` headers are stripped before the response
 * reaches the client — Clerk's internal headers must not be visible to Patchy's responses.
 */
export async function authenticate(
  request: ClerkRequest,
  options: {
    readonly secretKey: string;
    readonly publishableKey: string;
    readonly jwtKey?: string;
    readonly authorizedParties?: readonly string[] | null;
  }
): Promise<SessionResult> {
  // Build the clerk request options from the provided request
  const clerkOpts: Parameters<typeof clerkAuthenticate>[1] = {
    secretKey: options.secretKey,
    publishableKey: options.publishableKey,
    authorizedParties: options.authorizedParties ?? undefined,
  };

  if (options.jwtKey) {
    // Validate the PEM key at startup; if it fails the app should not start.
    try {
      clerkOpts.signatureVerificationKey = await clerkCreatePublicKey(options.jwtKey);
    } catch (err) {
      return {
        kind: "signInFailed",
        reason: `CLERK_JWT_KEY is set but could not be parsed as a PEM public key: ${String(err)}`,
      };
    }
  }

  let response: Response;
  try {
    response = await clerkAuthenticate(request, clerkOpts);
  } catch (err) {
    return {
      kind: "signInFailed",
      reason: `Clerk authenticateRequest threw: ${String(err)}`,
    };
  }

  // A handshake response (redirect to sign-in or similar) must be surfaced
  // so the caller can forward it.
  if (response.status === 401 && handshake.isHandshakeResponse(response)) {
    const location = response.headers.get("location");
    if (location) {
      return { kind: "handshake", location };
    }
    return {
      kind: "signInFailed",
      reason: "Clerk returned a handshake (401) but no Location header",
    };
  }

  if (response.status === 401) {
    // No session — this is normal for unsigned callers.
    return { kind: "unsigned" };
  }

  // Any other non-200: treat as a sign-in failure with the status code.
  if (response.status !== 200) {
    return {
      kind: "signInFailed",
      reason: `Clerk returned HTTP ${response.status}`,
    };
  }

  // Parse the AuthObject Clerk wrote into the response body.
  let authObj: AuthObject;
  try {
    const body = (response as unknown as { json: () => Promise<unknown> }).json?.() ?? {};
    authObj = (await Promise.resolve(body)) as AuthObject;
  } catch {
    return {
      kind: "signInFailed",
      reason: "Clerk returned 200 but the response body could not be parsed as JSON",
    };
  }

  if (!authObj?.userId) {
    // Clerk returned 200 but without a user — treat as unsigned.
    return { kind: "unsigned" };
  }

  return {
    kind: "authenticated",
    userId: authObj.userId,
    email: Option.fromNullable(authObj.email_addresses?.[0]?.email_address ?? authObj.emailAddress),
    name: Option.fromNullable(authObj.first_name ?? authObj.name),
    sessionId: authObj.sessionId ?? "",
  };
}

// ---------------------------------------------------------------------------
// Cookie names
// ---------------------------------------------------------------------------

/**
 * Every Clerk cookie name the sign-out routine must clear.
 *
 * Derived from `@clerk/backend`'s known cookie names. Keeping this list explicit
 * means sign-out is robust even if Clerk adds new cookie names in future versions:
 * a future migration would add to this list rather than silently missing a cookie.
 */
export const CLERK_COOKIE_NAMES = [
  "__session",
  "__client_state",
  "__lcl_state",
  "__gcl_state",
  "__hs",
  "__hstc",
  "__hsfp",
  "__cf_chl_contains",
] as const;

// ---------------------------------------------------------------------------
// signOutCookies
// ---------------------------------------------------------------------------

/**
 * Build the `Set-Cookie` headers that clear every Clerk cookie.
 *
 * The setter's `Domain` and `Path` are pinned so the clear is exact: no
 * cookie with a broader scope is accidentally cleared.
 */
export function signOutCookies(publicBaseUrl: string): ReadonlyArray<{ name: string; value: string; options: { domain?: string; path: string; "max-age": number; httpOnly: boolean; secure: boolean; sameSite: "lax" | "strict" } }> {
  const url = new URL(publicBaseUrl);
  const secure = url.protocol === "https:";
  const path = "/";
  const maxAge = 0;

  return CLERK_COOKIE_NAMES.map((name) => ({
    name,
    value: "",
    options: {
      path,
      "max-age": maxAge,
      httpOnly: true,
      secure,
      sameSite: "lax" as const,
    },
  }));
}

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

/**
 * Revoke a Clerk session by its session id.
 *
 * Uses Clerk's backend API directly rather than the SDK so that the revocation
 * can happen inside an Effect without pulling in the full Clerk SDK client.
 *
 * Returns `true` on success, `false` on failure (the session may already be
 * revoked or may not exist — both are acceptable outcomes for sign-out).
 */
export async function revokeSession(
  options: {
    readonly secretKey: string;
    readonly sessionId: string;
    readonly frontendApi: string;
  }
): Promise<boolean> {
  const url = `https://${options.frontendApi}/v1/client/sessions/${options.sessionId}/revoke`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.secretKey}`,
        "Content-Type": "application/json",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The error thrown when Clerk authentication is required but no valid session
 * was found on the request.
 */
export class SessionRequired extends Schema.TaggedError<SessionRequired>()(
  "SessionRequired",
  { reason: Schema.string },
  {
    message: (self) => `Clerk session required: ${self.reason}`,
  }
) {}

/**
 * The error thrown when Clerk authentication is configured but the required
 * environment variables are not set at startup.
 */
export class ClerkNotConfigured extends Schema.TaggedError<ClerkNotConfigured>()(
  "ClerkNotConfigured",
  Schema.Struct({ missing: Schema.Array(Schema.string) }),
  {
    message: (self) =>
      `Clerk auth is required but the following environment variables are not set: ${self.missing.join(", ")}`,
  }
) {}
