// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- offline Node fixtures; Clerk verifies timestamps against the real clock.
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ClientDocumentNetwork from "./ClientDocumentNetwork.js";

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
    name: string | null;
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

/**
 * The four clients' metadata documents, byte for byte with the headers that matter, as fetched
 * on 2026-10-22; #834 found production's egress gets the same bytes and headers.
 */
export const clientDocumentFixtures = {
  claude: {
    url: "https://claude.ai/oauth/mcp-oauth-client-metadata",
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    body: '{"client_id":"https://claude.ai/oauth/mcp-oauth-client-metadata","client_name":"Claude","client_uri":"https://claude.ai","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"grant_types":["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"],"response_types":["code"],"token_endpoint_auth_method":"none"}'
  },
  claudeCode: {
    url: "https://claude.ai/oauth/claude-code-client-metadata",
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    body: '{"client_id":"https://claude.ai/oauth/claude-code-client-metadata","client_name":"Claude Code","client_uri":"https://claude.ai","redirect_uris":["http://localhost/callback","http://127.0.0.1/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}'
  },
  chatgpt: {
    url: "https://chatgpt.com/oauth/client.json",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300"
    },
    body: '{"client_id":"https://chatgpt.com/oauth/client.json","client_uri":"https://chatgpt.com/","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_methods_supported":["none","private_key_jwt"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"ChatGPT","logo_uri":"https://persistent.oaistatic.com/sonic/misc/openai-logo.png","token_endpoint_auth_signing_alg":"RS256","jwks_uri":"https://chatgpt.com/oauth/jwks.json"}'
  },
  codex: {
    url: "https://chatgpt.com/oauth/codex/client.json",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300"
    },
    body: '{"client_id":"https://chatgpt.com/oauth/codex/client.json","client_uri":"https://chatgpt.com/codex","application_type":"native","redirect_uris":["http://127.0.0.1/callback","http://localhost/callback"],"token_endpoint_auth_method":"none","token_endpoint_auth_methods_supported":["none"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"client_name":"Codex","logo_uri":"https://persistent.oaistatic.com/sonic/misc/openai-logo.png"}'
  }
} as const;

/** A document an offline client host serves: its URL, body and response headers. */
export interface ServedDocument {
  readonly url: string;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Answers each request with the document at its `https://<host><path>`, or a 404. */
export const serveDocuments =
  (documents: ReadonlyArray<ServedDocument>) =>
  (request: IncomingMessage, response: ServerResponse) => {
    const served = documents.find(
      ({ url }) => url === `https://${request.headers.host}${request.url}`
    );
    if (served === undefined) response.writeHead(404).end();
    else response.writeHead(200, { ...served.headers }).end(served.body);
  };

/** What an offline client host saw: lookups, each connection's addresses, and requests. */
export interface ClientHostSeen {
  readonly lookups: Array<string>;
  readonly connections: Array<ReadonlyArray<string>>;
  readonly requests: Array<string>;
}

/**
 * The client document network offline. Every host resolves to `resolve`'s answer, a public
 * address unless a test says otherwise, and every connection reaches `handler` over plain HTTP
 * on loopback, so ClientDocuments' rules, limits and cache run as in production without TLS or
 * the network. The server closes with the scope.
 */
export const clientDocumentHost = Effect.fn("testing.clientDocumentHost")(function* (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  options: {
    readonly resolve?: (host: string) => ReadonlyArray<ClientDocumentNetwork.Address>;
  } = {}
) {
  const seen: ClientHostSeen = { lookups: [], connections: [], requests: [] };
  const server = createServer((request, response) => {
    seen.requests.push(`${request.method} https://${request.headers.host}${request.url}`);
    handler(request, response);
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      server.listen(0, "127.0.0.1", () =>
        resume(Effect.succeed((server.address() as AddressInfo).port))
      );
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      })
  );
  const resolve = options.resolve ?? (() => [{ address: "8.8.8.8", family: 4 }]);
  const network = ClientDocumentNetwork.ClientDocumentNetwork.of({
    resolve: (host) =>
      Effect.sync(() => {
        seen.lookups.push(host);
        return resolve(host);
      }),
    connect: ({ addresses }) =>
      Effect.sync(() => {
        seen.connections.push(addresses.map(({ address }) => address));
        return netConnect(port, "127.0.0.1");
      })
  });
  return { network, seen };
});

/** ClientDocumentNetwork serving `documents` offline, for suites that only need them answered. */
export const layerClientDocumentNetwork = (documents: ReadonlyArray<ServedDocument>) =>
  Layer.effect(
    ClientDocumentNetwork.ClientDocumentNetwork,
    Effect.map(clientDocumentHost(serveDocuments(documents)), ({ network }) => network)
  );
