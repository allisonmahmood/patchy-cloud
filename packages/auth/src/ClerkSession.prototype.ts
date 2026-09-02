/**
 * PROTOTYPE for #119 — throwaway, delete with the branch. The login door's
 * seam to Clerk: one service over `@clerk/backend` that hands an Effect
 * request to `authenticateRequest` and answers with a tagged verdict, revokes
 * a session on sign-out, and knows the Account Portal's sign-in URL. The
 * layer builds without keys so the server still boots; the door then fails
 * closed on the `not-configured` verdict. Every outbound `fetch` the server
 * makes while this layer is alive is logged as `[clerk-net]`, and each verdict
 * carries how long it took and how many network calls it cost, because "what
 * does the door cost per page load" is the question the prototype answers.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off -- prototype instrumentation over Node globals.
import { createHash } from "node:crypto";
import type { ClerkClient } from "@clerk/backend";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

export class ClerkNotConfigured extends Schema.TaggedError<ClerkNotConfigured>()(
  "ClerkNotConfigured",
  { missing: Schema.Array(Schema.String) }
) {
  override get message() {
    return `Clerk is not configured: set ${this.missing.join(", ")}.`;
  }
}

export class ClerkRevokeFailed extends Schema.TaggedError<ClerkRevokeFailed>()(
  "ClerkRevokeFailed",
  { sessionId: Schema.String, cause: Schema.Defect() }
) {
  override get message() {
    return `Clerk refused to revoke session ${this.sessionId}.`;
  }
}

/** What Clerk made of the request. `headers` are the ones its contract says to copy onto the response. */
export type Outcome =
  | {
      readonly _tag: "signed-in";
      readonly userId: string;
      readonly sessionId: string;
      readonly email: string | null;
      readonly name: string | null;
      readonly claims: Record<string, unknown>;
      readonly headers: Headers;
    }
  | { readonly _tag: "signed-out"; readonly reason: string; readonly headers: Headers }
  | {
      readonly _tag: "handshake";
      readonly reason: string;
      readonly location: string;
      readonly headers: Headers;
    }
  | { readonly _tag: "not-configured"; readonly missing: ReadonlyArray<string> };

export interface Verdict {
  readonly outcome: Outcome;
  /** Wall-clock milliseconds `authenticateRequest` took. */
  readonly authMs: number;
  /** Outbound fetches made while it ran (process-wide counter; concurrent requests share it). */
  readonly netCalls: number;
}

export class ClerkSession extends Context.Service<
  ClerkSession,
  {
    readonly configured: boolean;
    /** The `<name>_<suffix>` cookie suffix Clerk derives from the publishable key. */
    readonly cookieSuffix: string;
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
      publicUrl: string
    ) => Effect.Effect<Verdict>;
    readonly revoke: (
      sessionId: string
    ) => Effect.Effect<void, ClerkRevokeFailed | ClerkNotConfigured>;
    /** The Account Portal's sign-in page, returning to `redirectTo` afterwards. */
    readonly signInUrl: (redirectTo: string) => string;
  }
>()("@patchy/auth/ClerkSession.prototype/ClerkSession") {}

const config = Config.all({
  publishableKey: Config.option(Config.string("CLERK_PUBLISHABLE_KEY")),
  secretKey: Config.option(Config.redacted("CLERK_SECRET_KEY")),
  jwtKey: Config.option(Config.string("CLERK_JWT_KEY")),
  authorizedParties: Config.option(Config.string("CLERK_AUTHORIZED_PARTIES")),
  /** Overrides the portal derived from the publishable key. */
  accountPortalUrl: Config.option(Config.string("CLERK_ACCOUNT_PORTAL_URL"))
});

// --- instrumentation -------------------------------------------------------

let netCalls = 0;
let fetchWrapped = false;

/** Logs one `[clerk-net]` line per outbound fetch, process-wide, installed once. */
function wrapFetch(): void {
  if (fetchWrapped) return;
  fetchWrapped = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    );
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const started = Date.now();
    netCalls += 1;
    try {
      const response = await original(input, init);
      console.log(
        `[clerk-net] ${method} ${url.origin}${url.pathname} -> ${response.status} ${Date.now() - started}ms`
      );
      return response;
    } catch (error) {
      console.log(
        `[clerk-net] ${method} ${url.origin}${url.pathname} -> error ${Date.now() - started}ms`
      );
      throw error;
    }
  }) as typeof fetch;
}

// --- key arithmetic ----------------------------------------------------------

/** The Frontend API host encoded in the publishable key (`pk_test_<base64(host$)>`). */
export function frontendApiOf(publishableKey: string): string {
  const encoded = publishableKey.replace(/^pk_(test|live)_/, "");
  return Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
}

/** The Account Portal host for a Frontend API host: `<slug>.accounts.dev` in dev, `accounts.<root>` in production. */
export function accountPortalOf(frontendApi: string): string {
  const dev = /^([^.]+)\.clerk\.accounts\.dev$/.exec(frontendApi);
  if (dev) return `https://${dev[1]}.accounts.dev`;
  return `https://${frontendApi.replace(/^clerk\./, "accounts.")}`;
}

/** Clerk's `getCookieSuffix`: the first eight base64url characters of sha1(publishableKey). */
export function cookieSuffixOf(publishableKey: string): string {
  return createHash("sha1").update(publishableKey).digest("base64url").slice(0, 8);
}

// --- the service ------------------------------------------------------------

const claimString = (claims: Record<string, unknown>, key: string): string | null => {
  const value = claims[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

export const make = Effect.gen(function* () {
  const settings = yield* config;
  wrapFetch();

  const missing = [
    ...(Option.isNone(settings.publishableKey) ? ["CLERK_PUBLISHABLE_KEY"] : []),
    ...(Option.isNone(settings.secretKey) ? ["CLERK_SECRET_KEY"] : [])
  ];

  if (Option.isNone(settings.publishableKey) || Option.isNone(settings.secretKey)) {
    console.log(`[clerk] not configured: missing ${missing.join(", ")}; the door fails closed`);
    return ClerkSession.of({
      configured: false,
      cookieSuffix: "",
      authenticate: () =>
        Effect.succeed<Verdict>({
          outcome: { _tag: "not-configured", missing },
          authMs: 0,
          netCalls: 0
        }),
      revoke: () => Effect.fail(new ClerkNotConfigured({ missing })),
      signInUrl: () => ""
    });
  }

  const publishableKey = settings.publishableKey.value;
  const secretKey = Redacted.value(settings.secretKey.value);
  const jwtKey = Option.getOrUndefined(settings.jwtKey);
  const authorizedParties = Option.map(settings.authorizedParties, (list) =>
    list
      .split(",")
      .map((party) => party.trim())
      .filter((party) => party.length > 0)
  ).pipe(Option.getOrUndefined);
  const frontendApi = frontendApiOf(publishableKey);
  const portal = Option.getOrElse(settings.accountPortalUrl, () => accountPortalOf(frontendApi));
  const cookieSuffix = cookieSuffixOf(publishableKey);

  // Imported after the fetch wrapper is in place, in case the SDK binds
  // `globalThis.fetch` when its module loads rather than per call.
  const { createClerkClient } = yield* Effect.promise(() => import("@clerk/backend"));
  const client: ClerkClient = createClerkClient({
    publishableKey,
    secretKey,
    ...(jwtKey === undefined ? {} : { jwtKey })
  });

  console.log(
    `[clerk] configured frontendApi=${frontendApi} portal=${portal} cookieSuffix=${cookieSuffix} ` +
      `jwtKey=${jwtKey === undefined ? "absent" : "present"} ` +
      `authorizedParties=${authorizedParties === undefined ? "-" : `[${authorizedParties.join(",")}]`}`
  );

  const authenticate = Effect.fn("ClerkSession.authenticate")(function* (
    request: HttpServerRequest.HttpServerRequest,
    publicUrl: string
  ) {
    // The URL is the public one on purpose: the SDK builds the handshake's
    // `redirect_url` from it, and `toURL` would answer with the socket's view.
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) headers.set(name, value);
    const web = new Request(publicUrl, { method: request.method, headers });

    const callsBefore = netCalls;
    const started = Date.now();
    const state = yield* Effect.tryPromise({
      try: () =>
        client.authenticateRequest(web, {
          ...(authorizedParties === undefined ? {} : { authorizedParties })
        }),
      catch: (cause) => cause
    }).pipe(Effect.option);
    const authMs = Date.now() - started;
    const calls = netCalls - callsBefore;

    if (Option.isNone(state)) {
      return {
        outcome: {
          _tag: "signed-out",
          reason: "authenticate-request-threw",
          headers: new Headers()
        },
        authMs,
        netCalls: calls
      } satisfies Verdict;
    }

    const value = state.value;
    let outcome: Outcome;
    if (value.status === "handshake") {
      const location = value.headers.get("location");
      outcome =
        location === null
          ? { _tag: "signed-out", reason: "handshake-without-location", headers: value.headers }
          : { _tag: "handshake", reason: value.reason ?? "-", location, headers: value.headers };
    } else if (value.status === "signed-in") {
      const auth = value.toAuth();
      if (auth.userId === null || auth.sessionId === null) {
        outcome = { _tag: "signed-out", reason: "session-pending", headers: value.headers };
      } else {
        const claims = auth.sessionClaims as Record<string, unknown>;
        outcome = {
          _tag: "signed-in",
          userId: auth.userId,
          sessionId: auth.sessionId,
          email: claimString(claims, "email"),
          name: claimString(claims, "name"),
          claims,
          headers: value.headers
        };
      }
    } else {
      outcome = { _tag: "signed-out", reason: value.reason ?? "-", headers: value.headers };
    }
    return { outcome, authMs, netCalls: calls } satisfies Verdict;
  });

  const revoke = Effect.fn("ClerkSession.revoke")(function* (sessionId: string) {
    yield* Effect.tryPromise({
      try: () => client.sessions.revokeSession(sessionId),
      catch: (cause) => new ClerkRevokeFailed({ sessionId, cause })
    });
  });

  const signInUrl = (redirectTo: string) =>
    `${portal}/sign-in?redirect_url=${encodeURIComponent(redirectTo)}`;

  return ClerkSession.of({ configured: true, cookieSuffix, authenticate, revoke, signInUrl });
});

export const layer = Layer.effect(ClerkSession, make);
