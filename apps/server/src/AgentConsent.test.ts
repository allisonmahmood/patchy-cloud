/**
 * A scripted client connects through the whole server booted as a dev instance boots it: dev
 * personas, a `<label>.localhost` origin and its token endpoint on `127.0.0.1`, with Claude
 * Code's metadata document served from a fixture. The person answers on the consent page, as
 * their browser would post it.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SqlClient from "effect/sql/SqlClient";
import { AgentConnections } from "@patchy/auth";
import { DEV_SEED } from "@patchy/auth/seed";
import { clientDocumentFixtures, layerClientDocumentNetwork } from "@patchy/auth/testing";
import { NodeCryptography } from "@patchy/core";
import { randomToken, sha256 } from "../../../test/crypto.js";
import { send, server } from "./test/server.js";

const BASE = "http://patchy-flow.localhost:29276";
const CLAUDE_CODE = clientDocumentFixtures.claudeCode;
const CALLBACK = "http://127.0.0.1:53682/callback";
const env = { PATCHY_PUBLIC_BASE_URL: BASE, PATCHY_DEV_PERSONAS_SECRET: "flow", NODE_ENV: "test" };
const documents = layerClientDocumentNetwork([CLAUDE_CODE]);

/** Agent connections on the server's database, to see who a token acts as. */
const services = Effect.provide(
  AgentConnections.layer.pipe(Layer.provideMerge(NodeCryptography.layer))
);

it.layer(
  server(env, documents).pipe(
    Layer.provideMerge(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
  )
)("connecting an agent to a dev instance", (it) => {
  it.effect("authorize, sign in, approve, exchange and refresh; a replayed code ends it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE companies SET agent_access_on = true WHERE id = ${DEV_SEED.companyId}`;
      const metadata = (yield* (yield* send(
        HttpClientRequest.get("/.well-known/oauth-authorization-server")
      )).json) as { issuer: string; authorization_endpoint: string; token_endpoint: string };
      assert.strictEqual(metadata.token_endpoint, "http://127.0.0.1:29276/oauth/token");

      const verifier = randomToken(32);
      const query = new URLSearchParams({
        response_type: "code",
        client_id: CLAUDE_CODE.url,
        redirect_uri: CALLBACK,
        code_challenge: Buffer.from(sha256(verifier), "hex").toString("base64url"),
        code_challenge_method: "S256",
        state: "client-state",
        resource: `${BASE}/mcp`,
        scope: "patches"
      });
      const authorize = `${new URL(metadata.authorization_endpoint).pathname}?${query}`;

      // Not signed in: only to sign in, and back here after.
      const door = yield* send(HttpClientRequest.get(authorize));
      assert.strictEqual(door.status, 401);
      assert.isUndefined(door.headers.location);
      const signIn = new URL(door.headers["x-patchy-sign-in-url"]!);
      assert.strictEqual(`${signIn.origin}${signIn.pathname}`, `${BASE}/dev/sign-in`);
      assert.strictEqual(signIn.searchParams.get("return"), authorize);

      const signedIn = yield* send(
        HttpClientRequest.get(
          `/dev/sign-in?as=${encodeURIComponent(DEV_SEED.email)}&return=${encodeURIComponent(authorize)}`
        )
      );
      assert.strictEqual(signedIn.headers.location, authorize);
      const cookie = Cookies.toCookieHeader(signedIn.cookies);
      const page = yield* send(
        HttpClientRequest.get(authorize).pipe(HttpClientRequest.setHeader("cookie", cookie))
      );
      assert.strictEqual(page.status, 200);
      const html = yield* page.text;
      assert.include(html, "Connect Claude Code to Patchy Dev?");
      assert.include(html, "Your answer goes to a program on this computer");

      const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)![1]!;
      const allowed = yield* send(
        HttpClientRequest.post(authorize).pipe(
          HttpClientRequest.setHeaders({ cookie, origin: BASE }),
          HttpClientRequest.bodyUrlParams({
            userId: field("userId"),
            client: field("client"),
            shown: field("shown"),
            action: "allow"
          })
        )
      );
      assert.strictEqual(allowed.status, 303);
      const answer = new URL(allowed.headers.location!);
      assert.strictEqual(`${answer.origin}${answer.pathname}`, CALLBACK);
      assert.strictEqual(answer.searchParams.get("state"), "client-state");
      assert.strictEqual(answer.searchParams.get("iss"), metadata.issuer);

      const tokenPath = new URL(metadata.token_endpoint).pathname;
      const post = (fields: Record<string, string>) =>
        send(
          // The test client reaches the server on 127.0.0.1, as the metadata says to.
          HttpClientRequest.post(tokenPath).pipe(HttpClientRequest.bodyUrlParams(fields))
        );
      const exchange = {
        grant_type: "authorization_code",
        code: answer.searchParams.get("code")!,
        code_verifier: verifier,
        client_id: CLAUDE_CODE.url,
        redirect_uri: CALLBACK,
        resource: `${BASE}/mcp`
      };
      const exchanged = yield* post(exchange);
      assert.strictEqual(exchanged.status, 200);
      const tokens = (yield* exchanged.json) as { access_token: string; refresh_token: string };
      const identity = (token: string) =>
        AgentConnections.AgentConnections.use((connections) =>
          connections.authenticate(token)
        ).pipe(services);
      const agent = yield* identity(tokens.access_token);
      assert.deepStrictEqual(
        [agent?.user.id, agent?.agentConnection.clientName],
        [DEV_SEED.userId, "Claude Code"]
      );
      // A `work` token never opens the CLI's API.
      const api = yield* send(
        HttpClientRequest.get("/api/me").pipe(HttpClientRequest.bearerToken(tokens.access_token))
      );
      assert.strictEqual(api.status, 401);

      const refreshed = yield* post({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: CLAUDE_CODE.url,
        resource: `${BASE}/mcp`
      });
      assert.strictEqual(refreshed.status, 200);
      const renewed = (yield* refreshed.json) as { access_token: string };
      assert.isNotNull(yield* identity(renewed.access_token));

      const replayed = yield* post(exchange);
      assert.strictEqual(replayed.status, 400);
      assert.strictEqual(((yield* replayed.json) as { error: string }).error, "invalid_grant");
      assert.isNull(yield* identity(renewed.access_token));
    })
  );
});
