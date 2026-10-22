/**
 * Patchy's authorization metadata, which MCP clients read to learn how to connect: the
 * protected resource metadata for the door at `/mcp` (RFC 9728), at its path's address and the
 * root one, and the authorization server's (RFC 8414). Both are the same for everyone and
 * cacheable for an hour. There is no registration endpoint: a client names itself only through
 * a metadata document, with the `none` auth method.
 *
 * In production the OAuth machine endpoints and the door answer CORS for any origin without
 * credentials, and a preflight needs no auth; a dev instance answers no CORS. A dev instance
 * advertises its token endpoint on `127.0.0.1`, because Claude Code sends credentials over
 * plain http only to `localhost` or `127.0.0.1`, not to a dev environment's `<label>.localhost`.
 */
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { isLoopback, publicUrlConfig } from "./Session.js";

/** The one scope: an agent connection uses its person's patches. */
export const SCOPE = "patches";

/** The CORS answer of the OAuth machine endpoints and the door, in production. */
export const cors = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "WWW-Authenticate, Retry-After"
} as const;

/** A preflight's answer on those endpoints, in production. */
export const preflight = HttpServerResponse.empty({
  status: 204,
  headers: {
    ...cors,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
    "access-control-max-age": "86400"
  }
});

/** The token endpoint clients are told: a dev environment's host becomes `127.0.0.1`. */
const tokenEndpoint = (publicUrl: URL) => {
  const url = new URL("/oauth/token", publicUrl);
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost"))
    url.hostname = "127.0.0.1";
  return url.href;
};

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const publicUrl = yield* publicUrlConfig;
    const base = publicUrl.origin;
    const dev = isLoopback(publicUrl);
    const headers = { "cache-control": "public, max-age=3600", ...(dev ? {} : cors) };
    const protectedResource = HttpServerResponse.jsonUnsafe(
      {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
        resource_name: "Patchy"
      },
      { headers }
    );
    const authorizationServer = HttpServerResponse.jsonUnsafe(
      {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: tokenEndpoint(publicUrl),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [SCOPE],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true
      },
      { headers }
    );
    for (const [path, response] of [
      ["/.well-known/oauth-protected-resource/mcp", protectedResource],
      ["/.well-known/oauth-protected-resource", protectedResource],
      ["/.well-known/oauth-authorization-server", authorizationServer]
    ] as const) {
      yield* router.add("GET", path, Effect.succeed(response));
      if (!dev) yield* router.add("OPTIONS", path, Effect.succeed(preflight));
    }
  })
);
