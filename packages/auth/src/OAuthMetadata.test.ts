import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as OAuthMetadata from "./OAuthMetadata.js";

const RESOURCE = [
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource"
] as const;
const SERVER = "/.well-known/oauth-authorization-server";

// The server's own fallback answers whatever the metadata routes don't.
const routes = Layer.mergeAll(
  OAuthMetadata.layer,
  HttpRouter.use((router) =>
    router.add("*", "/*", Effect.succeed(HttpServerResponse.empty({ status: 404 })))
  )
);

/** `path` answered by the metadata routes of an instance served at `base`. */
const send = Effect.fn(
  function* (base: string, path: string, init: RequestInit = {}) {
    const app = yield* HttpRouter.toHttpEffect(routes);
    const response = yield* app.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(new URL(path, base), init))
      )
    );
    return HttpServerResponse.toWeb(response);
  },
  (effect, base) =>
    Effect.provide(
      effect,
      ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_PUBLIC_BASE_URL: base }))
    )
);

it.effect("tells clients where the door's authorization lives, cacheably, to any origin", () =>
  Effect.gen(function* () {
    const base = "https://cloud.example";
    for (const path of RESOURCE) {
      const response = yield* send(base, path, { headers: { origin: "https://claude.ai" } });
      assert.strictEqual(response.status, 200, path);
      assert.deepStrictEqual(yield* Effect.promise(() => response.json()), {
        resource: "https://cloud.example/mcp",
        authorization_servers: ["https://cloud.example"],
        scopes_supported: ["patches"],
        bearer_methods_supported: ["header"],
        resource_name: "Patchy"
      });
      assert.strictEqual(response.headers.get("cache-control"), "public, max-age=3600");
      assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
      assert.isNull(response.headers.get("access-control-allow-credentials"));
    }
  })
);

it.effect("advertises metadata documents, auth method none, PKCE S256, one scope and iss", () =>
  Effect.gen(function* () {
    const response = yield* send("https://cloud.example", SERVER);
    assert.strictEqual(response.status, 200);
    const metadata = yield* Effect.promise(() => response.json());
    assert.deepStrictEqual(metadata, {
      issuer: "https://cloud.example",
      authorization_endpoint: "https://cloud.example/oauth/authorize",
      token_endpoint: "https://cloud.example/oauth/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["patches"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    });
    // Clients name themselves only through metadata documents.
    assert.notProperty(metadata, "registration_endpoint");
    assert.strictEqual(response.headers.get("cache-control"), "public, max-age=3600");
    assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
  })
);

it.effect("answers a preflight without credentials or auth", () =>
  Effect.gen(function* () {
    for (const path of [...RESOURCE, SERVER]) {
      const response = yield* send("https://cloud.example", path, {
        method: "OPTIONS",
        headers: {
          origin: "https://claude.ai",
          "access-control-request-method": "GET",
          "access-control-request-headers": "mcp-protocol-version"
        }
      });
      assert.strictEqual(response.status, 204, path);
      assert.strictEqual(response.headers.get("access-control-allow-origin"), "*");
      assert.strictEqual(
        response.headers.get("access-control-allow-headers"),
        "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name"
      );
      assert.strictEqual(
        response.headers.get("access-control-expose-headers"),
        "WWW-Authenticate, Retry-After"
      );
      assert.isNull(response.headers.get("access-control-allow-credentials"));
    }
  })
);

it.effect("on a dev instance, has no CORS and sends tokens to 127.0.0.1", () =>
  Effect.gen(function* () {
    for (const [base, tokenEndpoint] of [
      ["http://patchy-abc.localhost:29276", "http://127.0.0.1:29276/oauth/token"],
      ["http://localhost:29276", "http://127.0.0.1:29276/oauth/token"],
      ["http://127.0.0.1:29276", "http://127.0.0.1:29276/oauth/token"],
      ["http://[::1]:29276", "http://127.0.0.1:29276/oauth/token"]
    ] as const) {
      const server = yield* send(base, SERVER, { headers: { origin: "https://claude.ai" } });
      const metadata = yield* Effect.promise(() => server.json());
      assert.strictEqual(metadata.issuer, base);
      assert.strictEqual(metadata.authorization_endpoint, `${base}/oauth/authorize`);
      assert.strictEqual(metadata.token_endpoint, tokenEndpoint);
      assert.isNull(server.headers.get("access-control-allow-origin"));
      const resource = yield* send(base, RESOURCE[0]);
      assert.isNull(resource.headers.get("access-control-allow-origin"));
      const preflight = yield* send(base, SERVER, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "GET" }
      });
      assert.isNull(preflight.headers.get("access-control-allow-origin"));
    }
  })
);
