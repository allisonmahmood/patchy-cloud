import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiTest from "effect/http-api/HttpApiTest";
import { Analytics } from "@patchy/analytics";
import { Authorization as AuthorizationTag, PatchyApi } from "@patchy/api";
import { Companies, InviteMail, Users } from "@patchy/companies";
import { randomToken, sha256 } from "@patchy/core";
import { Limits } from "@patchy/limits";
import * as Testing from "@patchy/sql/testing";
import * as AgentAuth from "./AgentAuth.js";
import * as AuthApi from "./AuthApi.js";
import * as AuthPages from "./AuthPages.js";
import * as Authorization from "./Authorization.js";
import * as DeviceLogins from "./DeviceLogins.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Session from "./Session.js";
import { clerkEnv, signedInCookies, signSession } from "./testing.js";

const env = clerkEnv();
const base = env.PATCHY_PUBLIC_BASE_URL!;
const redirectUri = "http://127.0.0.1:4567/callback";
const services = Layer.mergeAll(AuthApi.layer, HttpServer.layerServices, AgentAuth.layer).pipe(
  Layer.provideMerge(Authorization.layer),
  Layer.provideMerge(
    Layer.mergeAll(Session.layer, Companies.layer, Users.layer, InviteMail.layerRecording)
  ),
  Layer.provideMerge(DeviceLogins.layer),
  Layer.provideMerge(MachineTokens.layer),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provide(Limits.layer),
  Layer.provideMerge(Testing.layer()),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
);

const send = Effect.fn(function* (path: string, options: RequestInit = {}) {
  const app = yield* HttpRouter.toHttpEffect(AuthPages.layer);
  const response = yield* app.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(new URL(path, base), options))
    )
  );
  return HttpServerResponse.toWeb(response);
});
const body = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);
const text = (response: Response) => Effect.promise(() => response.text());

/** `GET /api/me` with a bearer, as the CLI asks it. */
const me = Effect.fn(function* (token: string) {
  const client = yield* HttpApiTest.groups(PatchyApi, ["auth"]).pipe(
    Effect.provide(
      HttpApiMiddleware.layerClient(AuthorizationTag, ({ next, request }) =>
        next(HttpClientRequest.bearerToken(request, token))
      )
    )
  );
  return yield* client.me({ responseMode: "response-only" });
});

/** A company's admin, signed in, with agent access as given. */
const account = Effect.fn(function* (label: string, agentsEnabled = true) {
  const companies = yield* Companies.Companies;
  const created = yield* companies.create({
    handle: `oauth-${label}`,
    name: `Company <${label}>`,
    clerkUserId: `user_oauth_${label}`,
    email: `oauth-${label}@example.com`,
    userName: `Admin ${label}`
  });
  if (agentsEnabled)
    yield* companies.setAgentsEnabled({ companyId: created.company.id, enabled: true });
  return {
    ...created,
    cookie: signedInCookies(
      signSession({
        sub: created.user.clerkUserId,
        email: created.user.email,
        name: created.user.name
      })
    )
  };
});

/** A registered client and the PKCE pair one connection uses. */
const connection = Effect.fn(function* (name = "Claude Code") {
  const registered = yield* send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: name })
  });
  assert.strictEqual(registered.status, 201);
  const client = yield* body<{ client_id: string; client_name: string }>(registered);
  const verifier = randomToken(32);
  const challenge = Buffer.from(sha256(verifier), "hex").toString("base64url");
  const authorize = `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    resource: `${base}/mcp`
  })}`;
  return { clientId: client.client_id, verifier, authorize };
});

/** What the rendered consent form would submit besides the person's answer. */
const hiddenFields = (html: string): Record<string, string> =>
  Object.fromEntries(
    Array.from(
      html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g),
      ([, name, value]) => [name, value!.replaceAll("&amp;", "&")]
    )
  );

const answer = Effect.fn(function* (cookie: string, fields: Record<string, string>) {
  return yield* send("/oauth/authorize", {
    method: "POST",
    headers: { cookie, origin: base },
    body: new URLSearchParams(fields)
  });
});

const exchange = (fields: Record<string, string>) =>
  send("/oauth/token", { method: "POST", body: new URLSearchParams(fields) });

it.layer(services)("OAuth for MCP clients", (it) => {
  it.effect("publishes the discovery documents MCP clients read", () =>
    Effect.gen(function* () {
      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp"
      ]) {
        assert.deepStrictEqual(yield* body(yield* send(path)), {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          bearer_methods_supported: ["header"],
          resource_name: "Patchy"
        });
      }
      const server = yield* send("/.well-known/oauth-authorization-server");
      assert.strictEqual(server.headers.get("access-control-allow-origin"), "*");
      const metadata = yield* body<Record<string, unknown>>(server);
      assert.strictEqual(metadata.issuer, base);
      assert.strictEqual(metadata.token_endpoint, `${base}/oauth/token`);
      assert.deepStrictEqual(metadata.code_challenge_methods_supported, ["S256"]);
      assert.strictEqual(
        AgentAuth.wwwAuthenticate(base),
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
      );
    })
  );

  it.effect(
    "connects a client as the signed-in person with a use token only the MCP door accepts",
    () =>
      Effect.gen(function* () {
        const owner = yield* account("happy");
        const { clientId, verifier, authorize } = yield* connection();
        const page = yield* send(authorize, { headers: { cookie: owner.cookie } });
        assert.strictEqual(page.status, 200);
        // Chrome checks a form POST's redirect against form-action too.
        assert.include(
          page.headers.get("content-security-policy")!,
          "form-action 'self' http://127.0.0.1:4567"
        );
        const html = yield* text(page);
        assert.include(html, "Connect Claude Code to Patchy?");
        assert.include(html, "Company &lt;happy&gt;");
        assert.include(html, owner.user.email);
        const allowed = yield* answer(owner.cookie, { ...hiddenFields(html), action: "allow" });
        assert.strictEqual(allowed.status, 303);
        const location = new URL(allowed.headers.get("location")!);
        assert.strictEqual(`${location.origin}${location.pathname}`, redirectUri);
        assert.strictEqual(location.searchParams.get("state"), "state-1");
        assert.strictEqual(location.searchParams.get("iss"), base);
        const code = location.searchParams.get("code")!;

        const issued = yield* exchange({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier
        });
        assert.strictEqual(issued.status, 200);
        assert.strictEqual(issued.headers.get("cache-control"), "no-store");
        const grant = yield* body<{ access_token: string; token_type: string; scope: string }>(
          issued
        );
        assert.strictEqual(grant.token_type, "Bearer");
        assert.strictEqual(grant.scope, "patches");

        const agents = yield* AgentAuth.AgentAuth;
        const principal = yield* agents.authenticate(`Bearer ${grant.access_token}`);
        assert.strictEqual(principal.identity.user.id, owner.user.id);
        assert.strictEqual(principal.identity.company.id, owner.company.id);
        assert.strictEqual(principal.identity.machine.name, "Claude Code");
        // The CLI's doors refuse it, and the MCP door refuses a CLI token.
        assert.strictEqual((yield* me(grant.access_token)).status, 401);
        const build = yield* (yield* MachineTokens.MachineTokens).mint({
          userId: owner.user.id,
          name: "Laptop"
        });
        assert.strictEqual((yield* me(build.token)).status, 200);
        const refused = yield* agents.authenticate(`Bearer ${build.token}`).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "AgentUnauthorized");

        // The code is single-use.
        const again = yield* exchange({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier
        });
        assert.strictEqual(again.status, 400);
        assert.strictEqual((yield* body<{ error: string }>(again)).error, "invalid_grant");

        // Your machines lists the connection as an agent, disconnected like any machine.
        const machines = yield* text(
          yield* send("/machines", { headers: { cookie: owner.cookie } })
        );
        assert.include(machines, 'Claude Code<span class="tag">Agent</span>');
        assert.include(machines, 'aria-label="Disconnect Claude Code"');
      })
  );

  it.effect("refuses a wrong verifier without spending the code", () =>
    Effect.gen(function* () {
      const owner = yield* account("verifier");
      const { clientId, verifier, authorize } = yield* connection();
      const html = yield* text(yield* send(authorize, { headers: { cookie: owner.cookie } }));
      const allowed = yield* answer(owner.cookie, { ...hiddenFields(html), action: "allow" });
      const code = new URL(allowed.headers.get("location")!).searchParams.get("code")!;
      const request = {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId
      };
      const wrong = yield* exchange({ ...request, code_verifier: randomToken(32) });
      assert.strictEqual(wrong.status, 400);
      assert.strictEqual((yield* body<{ error: string }>(wrong)).error, "invalid_grant");
      assert.strictEqual((yield* exchange({ ...request, code_verifier: verifier })).status, 200);
    })
  );

  it.effect("answers an unregistered redirect URI on the page, never at the URI", () =>
    Effect.gen(function* () {
      const owner = yield* account("redirect");
      const { authorize } = yield* connection();
      const url = new URL(authorize, base);
      url.searchParams.set("redirect_uri", "http://127.0.0.1:9999/elsewhere");
      const page = yield* send(`${url.pathname}${url.search}`, {
        headers: { cookie: owner.cookie }
      });
      assert.strictEqual(page.status, 400);
      assert.isNull(page.headers.get("location"));
      assert.include(yield* text(page), "did not register");
      const rejected = yield* send("/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://evil.example/callback"] })
      });
      assert.strictEqual(rejected.status, 400);
      assert.strictEqual((yield* body<{ error: string }>(rejected)).error, "invalid_redirect_uri");
    })
  );

  it.effect("keeps agents out while agent access is off and lets them back when it is on", () =>
    Effect.gen(function* () {
      const owner = yield* account("off");
      const companies = yield* Companies.Companies;
      const { clientId, verifier, authorize } = yield* connection();
      const html = yield* text(yield* send(authorize, { headers: { cookie: owner.cookie } }));
      const allowed = yield* answer(owner.cookie, { ...hiddenFields(html), action: "allow" });
      const code = new URL(allowed.headers.get("location")!).searchParams.get("code")!;
      const request = {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier
      };

      yield* companies.setAgentsEnabled({ companyId: owner.company.id, enabled: false });
      const page = yield* send(authorize, { headers: { cookie: owner.cookie } });
      assert.strictEqual(page.status, 403);
      assert.include(yield* text(page), "Agent access is off at <strong>Company &lt;off&gt;");
      const refused = yield* exchange(request);
      assert.strictEqual((yield* body<{ error: string }>(refused)).error, "invalid_grant");

      yield* companies.setAgentsEnabled({ companyId: owner.company.id, enabled: true });
      const grant = yield* body<{ access_token: string }>(yield* exchange(request));
      const agents = yield* AgentAuth.AgentAuth;
      yield* companies.setAgentsEnabled({ companyId: owner.company.id, enabled: false });
      const disabled = yield* agents.authenticate(`Bearer ${grant.access_token}`).pipe(Effect.flip);
      assert.strictEqual(disabled._tag, "AgentsDisabled");
      if (disabled._tag === "AgentsDisabled")
        assert.deepStrictEqual(disabled.admins, [
          { name: owner.user.name, email: owner.user.email }
        ]);
      yield* companies.setAgentsEnabled({ companyId: owner.company.id, enabled: true });
      const restored = yield* agents.authenticate(`Bearer ${grant.access_token}`);
      assert.strictEqual(restored.identity.user.id, owner.user.id);
    })
  );
});
