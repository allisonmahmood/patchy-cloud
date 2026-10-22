/**
 * The authorization server over HTTP: who `GET /oauth/authorize` sends where, and the token
 * endpoint's wire, limits and CORS. The rules behind both are `Consents.test.ts`'s.
 */
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Companies, Users } from "@patchy/companies";
import { randomToken, sha256 } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AgentConnections from "./AgentConnections.js";
import * as ClientDocuments from "./ClientDocuments.js";
import * as Consents from "./Consents.js";
import * as OAuthEndpoints from "./OAuthEndpoints.js";
import { DEV_SEED } from "./seed.js";
import * as Session from "./Session.js";
import { clerkEnv, layerClientDocumentNetwork, signedInCookies, signSession } from "./testing.js";

const BASE = "https://patchy.example";
const AGENT = "https://agent.example/client.json";
const CALLBACK = "https://agent.example/callback";
const env = {
  ...clerkEnv(),
  PATCHY_PUBLIC_BASE_URL: BASE,
  PATCHY_LIMITS_JSON: JSON.stringify({
    "oauth.token.failures.perMinute": 3,
    "oauth.token.rotations.perMinute": 2
  })
};
const signedIn = signedInCookies(
  signSession({ sub: DEV_SEED.clerkUserId, email: DEV_SEED.email, azp: BASE })
);

/** The client ids loaded, so a test can say nothing was fetched. */
const seen: Array<string> = [];
const loads = Layer.effect(
  ClientDocuments.ClientDocuments,
  Effect.gen(function* () {
    const loader = yield* ClientDocuments.make;
    return ClientDocuments.ClientDocuments.of({
      load: (clientId) =>
        Effect.sync(() => void seen.push(clientId)).pipe(Effect.andThen(loader.load(clientId)))
    });
  })
).pipe(
  Layer.provide(
    layerClientDocumentNetwork([
      {
        url: AGENT,
        body: JSON.stringify({
          client_id: AGENT,
          client_name: "Agent",
          redirect_uris: [CALLBACK],
          token_endpoint_auth_method: "none"
        })
      }
    ])
  )
);

const services = Consents.layer.pipe(
  Layer.provide(loads),
  Layer.provideMerge(Layer.mergeAll(AgentConnections.layer, Session.layer, Users.layer)),
  Layer.provideMerge(Companies.layer),
  Layer.provideMerge(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);

// The server's own fallback answers whatever these routes don't.
const routes = Layer.mergeAll(
  OAuthEndpoints.layer,
  HttpRouter.use((router) =>
    router.add("*", "/*", Effect.succeed(HttpServerResponse.empty({ status: 404 })))
  )
);

/** `path` as the endpoints answer it, from `address`, on an instance served at `base`. */
const send = Effect.fn(function* (
  path: string,
  init: RequestInit = {},
  options: { readonly address?: string; readonly base?: string } = {}
) {
  const base = options.base ?? BASE;
  const app = yield* HttpRouter.toHttpEffect(routes).pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ ...env, PATCHY_PUBLIC_BASE_URL: base }))
    )
  );
  const request = HttpServerRequest.fromWeb(new Request(new URL(path, base), init)).modify({
    remoteAddress: Option.fromNullishOr(options.address)
  });
  const response = yield* app.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request)
  );
  return HttpServerResponse.toWeb(response);
});

const json = (response: Response) =>
  Effect.promise(() => response.json() as Promise<Record<string, unknown>>);

const token = (fields: Record<string, string>, address = "198.51.100.1", base?: string) =>
  send(
    "/oauth/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields)
    },
    { address, ...(base === undefined ? {} : { base }) }
  );

const pkce = () => {
  const verifier = randomToken(32);
  return { verifier, challenge: Buffer.from(sha256(verifier), "hex").toString("base64url") };
};

const authorizeQuery = (challenge: string, fields: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: AGENT,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "opaque",
    resource: `${BASE}/mcp`,
    ...fields
  });

/** A code the dev person approved for AGENT, with its verifier. */
const approved = Effect.gen(function* () {
  const consents = yield* Consents.Consents;
  const companies = yield* Companies.Companies;
  yield* companies.setAgentAccess({ companyId: DEV_SEED.companyId, on: true, by: DEV_SEED.userId });
  const pair = pkce();
  const checked = yield* consents.check(authorizeQuery(pair.challenge));
  const answer = yield* consents.approve({
    request: checked,
    userId: DEV_SEED.userId,
    companyId: DEV_SEED.companyId
  });
  return { code: new URL(answer).searchParams.get("code")!, verifier: pair.verifier };
});

const exchangeFields = (code: { readonly code: string; readonly verifier: string }) => ({
  grant_type: "authorization_code",
  code: code.code,
  code_verifier: code.verifier,
  client_id: AGENT
});

it.layer(services)("the authorization server's endpoints", (it) => {
  it.effect("sends someone not signed in only to sign in, fetching nothing", () =>
    Effect.gen(function* () {
      seen.length = 0;
      const { challenge } = pkce();
      // Even a request naming another site to return to: nothing is sent there.
      const query = authorizeQuery(challenge, { redirect_uri: "https://evil.example/" });
      const response = yield* send(`/oauth/authorize?${query}`);
      assert.strictEqual(response.status, 401);
      assert.isNull(response.headers.get("location"));
      const signIn = new URL(response.headers.get("x-patchy-sign-in-url")!);
      assert.notStrictEqual(signIn.host, "evil.example");
      assert.include(signIn.href, encodeURIComponent(`${BASE}/oauth/authorize?`));
      assert.deepStrictEqual(seen, []);
    })
  );

  it.effect("shows a signed-in person why a refused request can't connect, sending nowhere", () =>
    Effect.gen(function* () {
      const { challenge } = pkce();
      const page = (fields: Record<string, string>) =>
        send(`/oauth/authorize?${authorizeQuery(challenge, fields)}`, {
          headers: { cookie: signedIn }
        });
      for (const [fields, status, says] of [
        [{ redirect_uri: "https://evil.example/" }, 400, "doesn't list"],
        [{ code_challenge_method: "plain" }, 400, "PKCE"],
        [{ resource: "https://other.example/mcp" }, 400, "other than Patchy MCP"],
        [{ client_id: "https://agent.example/missing.json" }, 502, "could not be loaded"]
      ] as const) {
        const response = yield* page(fields);
        assert.strictEqual(response.status, status, says);
        assert.isNull(response.headers.get("location"));
        const body = yield* Effect.promise(() => response.text());
        assert.include(body, "This agent can't connect");
        assert.include(body, says);
        assert.include(body, "Nothing was connected.");
      }
      const consent = yield* page({});
      assert.strictEqual(consent.status, 200);
      assert.include(yield* Effect.promise(() => consent.text()), "Connect Agent to Patchy Dev?");
    })
  );

  it.effect("exchanges a code and refreshes, as OAuth's JSON, never cached, to any origin", () =>
    Effect.gen(function* () {
      const code = yield* approved;
      const exchanged = yield* token({
        ...exchangeFields(code),
        redirect_uri: CALLBACK,
        resource: `${BASE}/mcp`
      });
      assert.strictEqual(exchanged.status, 200);
      assert.strictEqual(exchanged.headers.get("cache-control"), "no-store");
      assert.strictEqual(exchanged.headers.get("access-control-allow-origin"), "*");
      assert.isNull(exchanged.headers.get("access-control-allow-credentials"));
      const tokens = yield* json(exchanged);
      assert.deepStrictEqual(Object.keys(tokens).sort(), [
        "access_token",
        "expires_in",
        "refresh_token",
        "scope",
        "token_type"
      ]);
      assert.deepStrictEqual(
        [tokens.token_type, tokens.expires_in, tokens.scope],
        ["Bearer", 3600, "patches"]
      );

      const refreshed = yield* token({
        grant_type: "refresh_token",
        refresh_token: String(tokens.refresh_token),
        client_id: AGENT,
        resource: `${BASE}/mcp`
      });
      assert.strictEqual(refreshed.status, 200);
      const renewed = yield* json(refreshed);
      assert.notStrictEqual(renewed.access_token, tokens.access_token);
      assert.notStrictEqual(renewed.refresh_token, tokens.refresh_token);

      // The replay ends the connection, so even the renewed tokens stop working.
      const replayed = yield* token(exchangeFields(code));
      assert.strictEqual(replayed.status, 400);
      assert.strictEqual((yield* json(replayed)).error, "invalid_grant");
      const connections = yield* AgentConnections.AgentConnections;
      assert.isNull(yield* connections.authenticate(String(renewed.access_token)));
    })
  );

  it.effect("refuses a malformed token request in OAuth's words", () =>
    Effect.gen(function* () {
      const code = yield* approved;
      const sent = yield* token(exchangeFields(code));
      const { refresh_token } = yield* json(sent);
      const errors = [] as Array<readonly [unknown, number]>;
      for (const [fields, address] of [
        [{}, "203.0.113.1"],
        [{ grant_type: "password" }, "203.0.113.2"],
        [{ grant_type: "authorization_code", code: code.code, client_id: AGENT }, "203.0.113.3"],
        [
          { grant_type: "refresh_token", refresh_token: String(refresh_token), resource: BASE },
          "203.0.113.4"
        ],
        [
          {
            grant_type: "refresh_token",
            refresh_token: String(refresh_token),
            client_id: "https://other.example/client.json"
          },
          "203.0.113.5"
        ]
      ] as const) {
        const response = yield* token(fields, address);
        errors.push([(yield* json(response)).error, response.status]);
      }
      assert.deepStrictEqual(errors, [
        ["invalid_request", 400],
        ["unsupported_grant_type", 400],
        ["invalid_request", 400],
        ["invalid_target", 400],
        ["invalid_grant", 400]
      ]);
      const twice = yield* send(
        "/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `grant_type=refresh_token&refresh_token=a&refresh_token=b`
        },
        { address: "203.0.113.6" }
      );
      assert.strictEqual((yield* json(twice)).error, "invalid_request");
      const asJson = yield* send(
        "/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(exchangeFields(code))
        },
        { address: "203.0.113.7" }
      );
      assert.strictEqual((yield* json(asJson)).error, "invalid_request");
    })
  );

  it.effect("answers 429 to an address's failures past the limit, never to its successes", () =>
    Effect.gen(function* () {
      const address = "192.0.2.10";
      const bad = { grant_type: "refresh_token", refresh_token: "pwr_unknown" };
      for (let attempt = 0; attempt < 3; attempt++)
        assert.strictEqual((yield* token(bad, address)).status, 400);
      const limited = yield* token(bad, address);
      assert.strictEqual(limited.status, 429);
      assert.match(limited.headers.get("retry-after")!, /^\d+$/);
      assert.strictEqual((yield* json(limited)).error, "rate_limited");
      // A good exchange from the same address still succeeds; another address isn't limited.
      assert.strictEqual((yield* token(exchangeFields(yield* approved), address)).status, 200);
      assert.strictEqual((yield* token(bad, "192.0.2.11")).status, 400);
    })
  );

  it.effect("limits refreshes per agent connection, without spending the address's failures", () =>
    Effect.gen(function* () {
      const address = "192.0.2.20";
      let tokens = yield* json(yield* token(exchangeFields(yield* approved), address));
      for (let rotation = 0; rotation < 2; rotation++) {
        const refreshed = yield* token(
          { grant_type: "refresh_token", refresh_token: String(tokens.refresh_token) },
          address
        );
        assert.strictEqual(refreshed.status, 200);
        tokens = yield* json(refreshed);
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const limited = yield* token(
          { grant_type: "refresh_token", refresh_token: String(tokens.refresh_token) },
          address
        );
        assert.strictEqual(limited.status, 429);
        assert.match(limited.headers.get("retry-after")!, /^\d+$/);
      }
      // Another connection refreshes from the same address.
      const other = yield* json(yield* token(exchangeFields(yield* approved), address));
      const refreshed = yield* token(
        { grant_type: "refresh_token", refresh_token: String(other.refresh_token) },
        address
      );
      assert.strictEqual(refreshed.status, 200);
    })
  );

  it.effect("answers a preflight in production, and no CORS on a dev instance", () =>
    Effect.gen(function* () {
      const preflight = yield* send("/oauth/token", {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "POST" }
      });
      assert.strictEqual(preflight.status, 204);
      assert.strictEqual(preflight.headers.get("access-control-allow-origin"), "*");

      const dev = "http://patchy-abc.localhost:29276";
      const refused = yield* token({}, "192.0.2.30", dev);
      assert.strictEqual(refused.status, 400);
      assert.isNull(refused.headers.get("access-control-allow-origin"));
      const devPreflight = yield* send(
        "/oauth/token",
        { method: "OPTIONS", headers: { origin: "https://claude.ai" } },
        { base: dev }
      );
      assert.strictEqual(devPreflight.status, 404);
    })
  );
});
