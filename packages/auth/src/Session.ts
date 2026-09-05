// @effect-diagnostics nodeBuiltinImport:off -- Clerk's PEM verifier requires Node key normalization; SHA-1 matches its cookie suffix algorithm.
import { createHash, createPublicKey } from "node:crypto";
import { isIP } from "node:net";
import { createClerkClient } from "@clerk/backend";
import { constants, createClerkRequest } from "@clerk/backend/internal";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", {
  operation: Schema.Literals(["configuration", "authenticate", "revoke"]),
  setting: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect())
}) {
  override get message() {
    return this.setting === undefined
      ? `Clerk session ${this.operation} failed.`
      : `Invalid ${this.setting} configuration.`;
  }
}

export const SessionClaims = Schema.Struct({
  sub: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
  // Email-only Clerk accounts have no display name; identity is still sub/email.
  name: Schema.NullOr(Schema.String).pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((name) => name ?? ""),
      encode: SchemaGetter.passthrough()
    })
  ),
  sid: Schema.NonEmptyString
});

export type SessionResult =
  | {
      readonly status: "signed-in";
      readonly claims: typeof SessionClaims.Type;
      readonly cookies: ReadonlyArray<string>;
    }
  | {
      readonly status: "signed-out";
      readonly reason: string | null;
      readonly handshakeFailed: boolean;
      readonly cookies: ReadonlyArray<string>;
    }
  | {
      readonly status: "handshake";
      readonly response: Response;
      /** A verified return must set its cookies even when the destination is public. */
      readonly completed: boolean;
    };

const decodeClaims = Schema.decodeUnknownOption(SessionClaims);
const FrontendHost = Schema.String.check(
  Schema.isPattern(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
  )
);
const decodeFrontendHost = Schema.decodeUnknownSync(FrontendHost);
const PublishableKey = Schema.String.check(
  Schema.isPattern(/^pk_(test|live)_[A-Za-z0-9+/]+={0,2}$/)
);
const SecretKey = Schema.String.check(Schema.isPattern(/^sk_(test|live)_[A-Za-z0-9]+$/));
const decodeSecretKey = Schema.decodeUnknownSync(SecretKey);
const Origin = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
  )
);
const SafeReason = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,127}$/));
const isSafeReason = Schema.is(SafeReason);

/** Auth owns these settings; the entrypoint checks them before acquiring Postgres. */
export const config = Config.all({
  publicUrl: Config.schema(Origin, "PATCHY_PUBLIC_BASE_URL"),
  publishableKey: Config.schema(PublishableKey, "CLERK_PUBLISHABLE_KEY"),
  secretKey: Config.redacted("CLERK_SECRET_KEY"),
  jwtKey: Config.option(Config.string("CLERK_JWT_KEY")),
  authorizedParty: Config.option(Config.schema(Origin, "CLERK_AUTHORIZED_PARTIES"))
});

export class Session extends Context.Service<
  Session,
  {
    readonly publicBaseUrl: string;
    readonly publishableKey: string;
    readonly frontendApiHost: string;
    readonly authenticate: (request: Request) => Effect.Effect<SessionResult, SessionError>;
    readonly revoke: (sid: string) => Effect.Effect<void, SessionError>;
    readonly signOutCookies: () => ReadonlyArray<string>;
  }
>()("@patchy/auth/Session") {}

export const make = Effect.gen(function* () {
  const settings = yield* config;
  const { publishableKey, publicUrl } = settings;
  // Clerk keys encode exactly `<frontend-api-host>$`, with optional base64 padding.
  const decoded = yield* Effect.try({
    try: () => atob(publishableKey.slice(8)),
    catch: (cause) =>
      new SessionError({ operation: "configuration", setting: "CLERK_PUBLISHABLE_KEY", cause })
  });
  if (!decoded.endsWith("$"))
    return yield* new SessionError({
      operation: "configuration",
      setting: "CLERK_PUBLISHABLE_KEY"
    });
  const frontendApiHost = yield* Effect.try({
    try: () => decodeFrontendHost(decoded.slice(0, -1)),
    catch: (cause) =>
      new SessionError({ operation: "configuration", setting: "CLERK_PUBLISHABLE_KEY", cause })
  });
  const secretKey = yield* Effect.try({
    try: () => decodeSecretKey(Redacted.value(settings.secretKey)),
    catch: (cause) =>
      new SessionError({ operation: "configuration", setting: "CLERK_SECRET_KEY", cause })
  });
  if (secretKey.slice(3, 7) !== publishableKey.slice(3, 7))
    return yield* new SessionError({ operation: "configuration", setting: "CLERK_SECRET_KEY" });
  let jwtKey: string | undefined;
  if (Option.isSome(settings.jwtKey)) {
    const pem = settings.jwtKey.value;
    if (!/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(pem.trim()))
      return yield* new SessionError({ operation: "configuration", setting: "CLERK_JWT_KEY" });
    const key = yield* Effect.try({
      try: () => createPublicKey(pem),
      catch: (cause) =>
        new SessionError({ operation: "configuration", setting: "CLERK_JWT_KEY", cause })
    });
    // backend@3.17.0 strips a fixed RSA-2048/SPKI prefix and assumes e=65537.
    // Normalize PKCS#1 too, and reject other valid-but-unsupported keys at boot.
    if (
      key.asymmetricKeyType !== "rsa" ||
      key.asymmetricKeyDetails?.modulusLength !== 2048 ||
      key.asymmetricKeyDetails.publicExponent !== 65537n
    )
      return yield* new SessionError({ operation: "configuration", setting: "CLERK_JWT_KEY" });
    jwtKey = key.export({ type: "spki", format: "pem" }).toString();
  }
  const authorizedParties = Option.match(settings.authorizedParty, {
    onNone: () => undefined,
    onSome: (url) => [url.origin]
  });
  const client = createClerkClient({
    publishableKey,
    secretKey,
    jwtKey,
    telemetry: { disabled: true }
  });
  const suffix = createHash("sha1").update(publishableKey).digest("base64url").slice(0, 8);
  const clearedCookies: Array<string> = [];
  const expire = (name: string, domain?: string, path = "/") => {
    clearedCookies.push(
      `${name}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${domain === undefined ? "" : `; Domain=${domain}`}; SameSite=Lax${publicUrl.protocol === "https:" ? "; Secure" : ""}`
    );
  };
  for (const name of Object.values(constants.Cookies)) {
    expire(name);
    expire(`${name}_${suffix}`);
  }
  // clerk-js@5's core/auth/cookies/activeContext.ts: host-only, shared cookie handler Path=/.
  expire("clerk_active_context");
  // Backend's RedirectCount omits Path: /login/device therefore sets it at /login.
  expire(constants.Cookies.RedirectCount, undefined, "/login");
  // Session/dev-browser/refresh directives are host-only, Path=/; ClientUat
  // and production Handshake/HandshakeNonce are eTLD+1-scoped (SDK request.ts,
  // clerk-js getCookieDomain, and #119's raw-header evidence), also Path=/.
  // getCookieDomain probes these suffixes (not simply the last two labels).
  // Expire each candidate: the browser rejects public suffixes, and the real
  // eTLD+1 is covered without guessing a public-suffix list on the server.
  const hostname = publicUrl.hostname;
  const labels = hostname.split(".");
  const domains =
    isIP(hostname) !== 0 || labels.length === 1 || hostname.startsWith("[")
      ? [hostname]
      : labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
  for (const domain of domains) {
    for (const name of [
      constants.Cookies.ClientUat,
      constants.Cookies.Handshake,
      constants.Cookies.HandshakeNonce
    ]) {
      expire(name, domain);
      expire(`${name}_${suffix}`, domain);
    }
  }

  const authenticate = Effect.fn("Session.authenticate")(function* (
    request: Request
  ): Effect.fn.Return<SessionResult, SessionError> {
    const incoming = new URL(request.url);
    const url = new URL(publicUrl);
    url.pathname = incoming.pathname;
    url.search = incoming.search;
    const headers = new Headers(request.headers);
    // Session is a browser-cookie boundary, never a second bearer entrypoint.
    headers.delete("authorization");
    headers.delete("forwarded");
    for (const name of [...headers.keys()]) {
      if (name.startsWith("x-forwarded-")) headers.delete(name);
    }
    headers.set("host", publicUrl.host);
    headers.set("x-forwarded-host", publicUrl.host);
    headers.set("x-forwarded-proto", publicUrl.protocol.slice(0, -1));
    headers.set(
      "x-forwarded-port",
      publicUrl.port || (publicUrl.protocol === "https:" ? "443" : "80")
    );
    headers.set("cloudfront-forwarded-proto", publicUrl.protocol.slice(0, -1));
    const canonical = createClerkRequest(new Request(url, { method: request.method, headers }));
    const returning = [constants.Cookies.Handshake, constants.Cookies.HandshakeNonce].some(
      (name) => url.searchParams.has(name) || canonical.cookies.has(name)
    );
    const result = yield* Effect.tryPromise({
      // Clerk 3.17 rejects null azp when authorizedParties is passed. Verify
      // first, then apply Patchy's null-or-matching-origin rule to signed claims.
      try: () => client.authenticateRequest(canonical, { acceptsToken: "session_token" }),
      catch: (cause) => new SessionError({ operation: "authenticate", cause })
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      if (!returning) return yield* result.failure;
      return {
        status: "signed-out",
        reason: "handshake-verification-failed",
        handshakeFailed: true,
        cookies: []
      };
    }
    const state = result.success;
    const cookies = state.headers.getSetCookie();
    const reason =
      state.reason === null
        ? null
        : isSafeReason(state.reason)
          ? state.reason
          : "clerk-authentication-failed";
    // In development a resolved handshake may be signed-out AND carry Location.
    // Never follow that location (or a second handshake) back into a loop.
    if (state.status !== "signed-in" && returning) {
      return { status: "signed-out", reason, handshakeFailed: true, cookies };
    }
    if (state.status === "signed-in" && authorizedParties !== undefined) {
      const azp = state.toAuth().sessionClaims?.azp;
      if (azp != null && (typeof azp !== "string" || !authorizedParties.includes(azp))) {
        return {
          status: "signed-out",
          reason: "token-invalid-authorized-parties",
          handshakeFailed: returning,
          cookies
        };
      }
    }
    const location = state.headers.get("location");
    if (
      state.status === "handshake" ||
      (state.status === "signed-in" && returning && location !== null)
    ) {
      if (location === null) {
        return {
          status: "signed-out",
          reason: "handshake-location-missing",
          handshakeFailed: true,
          cookies
        };
      }
      const responseHeaders = new Headers({ location });
      for (const cookie of cookies) responseHeaders.append("set-cookie", cookie);
      return {
        status: "handshake",
        response: new Response(null, { status: 307, headers: responseHeaders }),
        completed: state.status === "signed-in"
      };
    }
    if (state.status === "signed-out") {
      return { status: "signed-out", reason, handshakeFailed: false, cookies };
    }
    const auth = state.toAuth();
    const claims = decodeClaims(auth.sessionClaims);
    if (auth.userId === null || auth.sessionId === null || Option.isNone(claims)) {
      return {
        status: "signed-out",
        reason: "session-claims-invalid",
        handshakeFailed: returning,
        cookies
      };
    }
    return { status: "signed-in", claims: claims.value, cookies };
  });

  const revoke = Effect.fn("Session.revoke")(function* (sid: string) {
    yield* Effect.tryPromise({
      try: () => client.sessions.revokeSession(sid),
      catch: (cause) => new SessionError({ operation: "revoke", cause })
    });
  });
  return Session.of({
    publicBaseUrl: publicUrl.origin,
    publishableKey,
    frontendApiHost,
    authenticate,
    revoke,
    signOutCookies: () => clearedCookies
  });
});

export const layer = Layer.effect(Session, make);
