/**
 * PROTOTYPE for #119 — throwaway, delete with the branch. An offline Clerk
 * instance for tests: fake keys whose Frontend API host never resolves,
 * sessions signed by an RSA-2048 keypair made when this module loads and
 * verified through `CLERK_JWT_KEY`, and a fetch guard, installed on import,
 * that refuses and records every request that is not to this process's own
 * loopback server. Importing this module is what makes a suite offline;
 * nothing in it reaches Clerk. Pass `clerkEnv(...)` through the suite's
 * `ConfigProvider` and the real `ClerkSession.layer` does the rest.
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- a test fixture over Node globals; Clerk checks `exp` against the real clock.
import { generateKeyPairSync, sign } from "node:crypto";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DEV_ACCOUNT_ID } from "./PrototypeUsers.prototype.js";

// --- offline by construction --------------------------------------------------

/**
 * Every fetch that is not to this process's own server fails here, before DNS,
 * and is recorded as `<METHOD> <origin><path>`. `@clerk/backend` resolves the
 * bare `fetch` global at call time under `NODE_ENV=test`, so this catches the
 * SDK's JWKS, BAPI and telemetry calls whatever order the modules loaded in.
 */
export const outbound: Array<string> = [];

/** The fetch as it was before the guard, for a test client that must not be counted. */
export const realFetch = globalThis.fetch;

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  );
  if (url.hostname !== "127.0.0.1") {
    outbound.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    return Promise.reject(new Error(`Offline test: refused ${url.origin}`));
  }
  return realFetch(input, init);
}) as typeof fetch;

// --- the fake instance ----------------------------------------------------------

export const PUBLIC_BASE_URL = "https://patchy.example";

/** The Frontend API host inside the fake key; `.invalid` never resolves. */
export const FRONTEND_API = "clerk.patchy.invalid";

/** A publishable key is `pk_<test|live>_` + base64(`<frontend-api-host>$`) (`@clerk/shared/keys`). */
export const publishableKey = (instance: "test" | "live") =>
  `pk_${instance}_${Buffer.from(`${FRONTEND_API}$`).toString("base64").replace(/=+$/, "")}`;

/**
 * RSA-2048 with e=65537, exactly: `loadClerkJwkFromPem` strips a hard-coded
 * SPKI prefix and suffix that only that shape of key has.
 */
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 65537
});

export const jwtKey = publicKey.export({ type: "spki", format: "pem" }).toString();

/** The door's configuration for a development (`test`) or production (`live`) key. */
export const clerkEnv = (instance: "test" | "live") => ({
  PATCHY_PUBLIC_BASE_URL: PUBLIC_BASE_URL,
  CLERK_PUBLISHABLE_KEY: publishableKey(instance),
  CLERK_SECRET_KEY: `sk_${instance}_offline`,
  CLERK_JWT_KEY: jwtKey,
  CLERK_AUTHORIZED_PARTIES: PUBLIC_BASE_URL
});

// --- sessions ---------------------------------------------------------------------

const base64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/** A session JWT as Clerk would mint it, signed by the test keypair: RS256, `typ: JWT`, a `kid`, no `cat`. */
export const signSession = (claims: Record<string, unknown>) => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "door-test" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
};

export const nowSeconds = () => Math.floor(Date.now() / 1000);

export const sessionClaims = (iat: number, ttlSeconds: number) => ({
  sub: "user_test",
  sid: "sess_test",
  iat,
  nbf: iat,
  exp: iat + ttlSeconds,
  azp: PUBLIC_BASE_URL,
  email: "door@example.com",
  name: "Door Tester"
});

export const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

/**
 * What a signed-in browser carries into the server. A `__session` cookie alone
 * is not read: the SDK wants `__client_uat` (non-zero, not after `iat`) beside
 * it, and on a development key a `__clerk_db_jwt` dev-browser cookie first, or
 * it asks for a handshake instead.
 */
export const signedInCookies = (jwt: string, iat: number, options: { devBrowser?: boolean } = {}) =>
  cookieHeader({
    __session: jwt,
    __client_uat: String(iat),
    ...(options.devBrowser === false ? {} : { __clerk_db_jwt: "dev-browser" })
  });

/** A signed-in cookie header for a request made now; the session lasts a minute. */
export const signedInNow = (options: { devBrowser?: boolean } = {}) => {
  const iat = nowSeconds();
  return signedInCookies(signSession(sessionClaims(iat, 60)), iat, options);
};

// --- the company ---------------------------------------------------------------------

/**
 * The dev company the door's just-in-time user row joins. `Testing.layer`
 * creates an empty database and migrates it; it does not clone the seeded
 * template `test/postgres.ts` builds, so `acct_dev` has to be put here.
 */
export const seedDevAccount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO accounts (id, name) VALUES (${DEV_ACCOUNT_ID}, 'Patchy Dev')
    ON CONFLICT (id) DO NOTHING`;
  yield* sql`INSERT INTO api_tokens (id, account_id, name, token_hash, scopes)
    VALUES ('tok_dev', ${DEV_ACCOUNT_ID}, 'Dev Token', 'hash:tok_dev', '["upload"]'::jsonb)
    ON CONFLICT (id) DO NOTHING`;
});

// --- the handshake return leg ---------------------------------------------------------

/**
 * The directives FAPI's handshake payload carries back, in the shape the dev
 * instance returned on #119: the `__client_uat` it just set (host-scoped by a
 * `Domain`), the session token, an opaque refresh token under the suffixed
 * name, and — on a development instance — the dev-browser cookie.
 */
export const handshakeDirectives = (options: {
  readonly jwt: string;
  readonly iat: number;
  readonly suffix: string;
  readonly devBrowser?: boolean;
}) => {
  const expires = new Date((options.iat + 365 * 24 * 60 * 60) * 1000).toUTCString();
  const domain = new URL(PUBLIC_BASE_URL).hostname;
  return [
    `__client_uat=${options.iat}; Path=/; Domain=${domain}; Max-Age=315360000; Secure; SameSite=None`,
    `__session=${options.jwt}; Path=/; Expires=${expires}; Secure; SameSite=None`,
    `__refresh_${options.suffix}=${"r".repeat(48)}; Path=/; Expires=${expires}; HttpOnly; Secure; SameSite=None`,
    ...(options.devBrowser === true
      ? [`__clerk_db_jwt=dev-browser; Path=/; Expires=${expires}; Secure; SameSite=None`]
      : [])
  ];
};

/**
 * The handshake JWT FAPI hands back, signed by the test keypair. Its payload
 * is `{ handshake: [<Set-Cookie directive>, ...] }` and its header is a
 * session token's: `verifyHandshakeJwt` checks `typ`, `alg`, the absence of a
 * non-session `cat`, and the signature — nothing else, no `exp`, no `iss` —
 * so under `CLERK_JWT_KEY` resolving one costs no network at all
 * (`@clerk/backend@3.17.0/dist/index.js:7125-7154`, `:7157-7176`). The live
 * instance's own handshake tokens carry `cat: "cl_B7d4PD111AAA"`, the session
 * category, which that check also allows; omitting it is the same to the SDK.
 */
export const signHandshake = (directives: ReadonlyArray<string>) =>
  signSession({ handshake: directives });
