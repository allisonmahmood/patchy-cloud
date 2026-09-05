// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- offline Node fixtures; Clerk verifies timestamps against the real clock.
import { generateKeyPairSync, sign } from "node:crypto";

/** Denied fetches, without credentials, query strings or fragments. */
export const externalRequests: Array<string> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  let request = new Request(input, init);
  for (let redirects = 0; ; redirects++) {
    const url = new URL(request.url);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) {
      externalRequests.push(`${request.method} ${url.origin}${url.pathname}`);
      throw new Error(`Offline Clerk fixture refused ${url.origin}`);
    }
    // Native fetch follows redirects internally, bypassing the global guard.
    // Keep every hop here so even a loopback server cannot escape the fixture.
    const replay =
      request.redirect === "follow" && request.body !== null ? request.clone() : undefined;
    const response = await originalFetch(request, { redirect: "manual" });
    const location = response.headers.get("location");
    if (
      location === null ||
      ![301, 302, 303, 307, 308].includes(response.status) ||
      request.redirect === "manual"
    ) {
      return response;
    }
    await response.body?.cancel();
    if (request.redirect === "error" || redirects === 20)
      throw new TypeError("Offline fetch redirect refused");
    const target = new URL(location, url);
    const headers = new Headers(request.headers);
    if (target.origin !== url.origin) {
      headers.delete("authorization");
      headers.delete("proxy-authorization");
      headers.delete("cookie");
      headers.delete("host");
    }
    const toGet =
      ((response.status === 301 || response.status === 302) && request.method === "POST") ||
      (response.status === 303 && request.method !== "GET" && request.method !== "HEAD");
    if (toGet) {
      for (const name of [
        "content-type",
        "content-length",
        "content-encoding",
        "content-language",
        "content-location"
      ])
        headers.delete(name);
    }
    const next: RequestInit & { cache: Request["cache"]; duplex: "half" } = {
      method: toGet ? "GET" : request.method,
      headers,
      body: toGet ? null : (replay?.body ?? null),
      redirect: request.redirect,
      signal: request.signal,
      credentials: request.credentials,
      mode: request.mode,
      cache: request.cache,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive,
      duplex: "half"
    };
    request = new Request(target, next);
  }
}) as typeof fetch;

export const PUBLIC_BASE_URL = "http://127.0.0.1:3000";
export const FRONTEND_API_HOST = "clerk.patchy.invalid";
export const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 65537
});
export const jwtKey = publicKey.export({ type: "spki", format: "pem" }).toString();
export const publishableKey = (instance: "test" | "live" = "test") =>
  `pk_${instance}_${Buffer.from(`${FRONTEND_API_HOST}$`).toString("base64").replace(/=+$/, "")}`;

/** Only configuration differs from the production Session layer. */
export const clerkEnv = (): Record<string, string> => ({
  CLERK_PUBLISHABLE_KEY: publishableKey(),
  CLERK_SECRET_KEY: "sk_test_offline",
  CLERK_JWT_KEY: jwtKey,
  PATCHY_PUBLIC_BASE_URL: PUBLIC_BASE_URL
});

const signJwt = (claims: Record<string, unknown>): string => {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "patchy-offline" })
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${sign("sha256", Buffer.from(content), privateKey).toString("base64url")}`;
};

export const signSession = (
  claims: Partial<{
    sub: string;
    email: string;
    name: string;
    sid: string;
    iat: number;
    exp: number;
    nbf: number;
    iss: string;
    azp: string | null;
  }> = {}
): string => {
  const now = Math.floor(Date.now() / 1_000);
  return signJwt({
    sub: "user_dev",
    email: "dev@patchy.local",
    name: "Patchy Dev",
    sid: "sess_offline",
    iat: now,
    nbf: now,
    exp: now + 60,
    iss: `https://${FRONTEND_API_HOST}`,
    azp: PUBLIC_BASE_URL,
    ...claims
  });
};

/** SDK reads ClientUat alongside Session, and DevBrowser for development keys. */
export const signedInCookies = (jwt = signSession()): string => {
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as {
    iat: number;
  };
  return `__session=${jwt}; __client_uat=${claims.iat}; __clerk_db_jwt=offline-browser`;
};

/** The SDK verifies this signed handshake payload locally, without nonce/BAPI retrieval. */
export const signHandshake = (directives: ReadonlyArray<string>): string =>
  signJwt({ handshake: directives });
