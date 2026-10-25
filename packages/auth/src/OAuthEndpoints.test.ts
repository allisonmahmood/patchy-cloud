/**
 * The authorization server over HTTP: who `GET /oauth/authorize` sends where, the consent page
 * and its answer, and the token endpoint's wire, limits and CORS. The rules behind them are
 * `Consents.test.ts`'s.
 */
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as SqlClient from "effect/sql/SqlClient";
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
/** A client whose answer returns to a program on the person's computer. */
const LOCAL = "https://local.example/client.json";
/** A client whose document says things a page must never render as written. */
const HOSTILE = "https://hostile.example/client.json";
const HOSTILE_NAME = `<img src=x onerror=alert(1)>\u202e${"a".repeat(80)}`;
const limits = {
  "oauth.token.failures.perMinute": 3,
  "oauth.token.rotations.perMinute": 2,
  "oauth.consent.perMinute": 1_000
};
const env = {
  ...clerkEnv(),
  PATCHY_PUBLIC_BASE_URL: BASE,
  PATCHY_LIMITS_JSON: JSON.stringify(limits)
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
      },
      {
        url: LOCAL,
        body: JSON.stringify({
          client_id: LOCAL,
          client_name: "Local Agent",
          redirect_uris: ["http://127.0.0.1/callback", "http://[::1]/callback"],
          token_endpoint_auth_method: "none"
        })
      },
      {
        url: HOSTILE,
        body: JSON.stringify({
          client_id: HOSTILE,
          client_name: HOSTILE_NAME,
          redirect_uris: ["https://hostile.example/callback"],
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
  options: {
    readonly address?: string;
    readonly base?: string;
    readonly limits?: Readonly<Record<string, number>>;
  } = {}
) {
  const base = options.base ?? BASE;
  const app = yield* HttpRouter.toHttpEffect(routes).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...env,
          PATCHY_PUBLIC_BASE_URL: base,
          PATCHY_LIMITS_JSON: JSON.stringify({ ...limits, ...options.limits })
        })
      )
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

/** A fresh browser session for a person, signed now so a slow run never outlives it. */
const sessionOf = (sub: string = DEV_SEED.clerkUserId, email: string = DEV_SEED.email) =>
  signedInCookies(signSession({ sub, email, azp: BASE }));

const setAccess = (on: boolean) =>
  Effect.flatMap(Companies.Companies, (companies) =>
    companies.setAgentAccess({ companyId: DEV_SEED.companyId, on, by: DEV_SEED.userId })
  );

const text = (response: Response) => Effect.promise(() => response.text());

/** The consent page for `query`, as `cookie`'s person sees it. */
const consentPage = (query: URLSearchParams, cookie = sessionOf(), address?: string) =>
  send(
    `/oauth/authorize?${query}`,
    { headers: { cookie } },
    address === undefined ? {} : { address }
  );

const unescaped = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** A page's answer form: where it posts, and the account, client name and time it was shown. */
const formOf = (html: string) => ({
  action: unescaped(/<form(?: class="actions")? method="post" action="([^"]*)"/.exec(html)![1]!),
  userId: unescaped(/name="userId" value="([^"]*)"/.exec(html)![1]!),
  client: unescaped(/name="client" value="([^"]*)"/.exec(html)![1]!),
  shown: /name="shown" value="([^"]*)"/.exec(html)![1]!
});

/** The person's answer to a shown page, from this instance's own origin unless `headers` replaces it. */
const answer = (
  form: ReturnType<typeof formOf>,
  action: "allow" | "deny",
  options: {
    readonly cookie?: string | undefined;
    readonly headers?: Readonly<Record<string, string>>;
    readonly fields?: Readonly<Record<string, string>>;
  } = {}
) =>
  send(form.action, {
    method: "POST",
    headers: {
      ...(options.headers ?? { origin: BASE }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie })
    },
    body: new URLSearchParams({
      userId: form.userId,
      client: form.client,
      shown: form.shown,
      action,
      ...options.fields
    })
  });

const consentRows = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ count: number }>`SELECT count(*)::int AS count FROM agent_consents`
).pipe(Effect.map((rows) => rows[0]!.count));

/** A member of the dev company, who isn't an admin. */
const member = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
    VALUES ('usr_consent_member', 'clerk_consent_member', ${DEV_SEED.companyId},
      'member@consent.test', 'Mia Member', 'member')
    ON CONFLICT (id) DO NOTHING`;
  return sessionOf("clerk_consent_member", "member@consent.test");
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
      yield* setAccess(true);
      const { challenge } = pkce();
      const page = (fields: Record<string, string>) =>
        send(`/oauth/authorize?${authorizeQuery(challenge, fields)}`, {
          headers: { cookie: signedIn }
        });
      for (const [fields, status, says] of [
        [{ redirect_uri: "https://evil.example/" }, 400, "check its redirect_uri"],
        [{ code_challenge_method: "plain" }, 400, "check its code_challenge_method"],
        [{ resource: "https://other.example/mcp" }, 400, "check its resource"],
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

  it.effect("limits rotations per agent connection, not retries or the address's failures", () =>
    Effect.gen(function* () {
      const address = "192.0.2.20";
      const refresh = (refreshToken: unknown) =>
        token({ grant_type: "refresh_token", refresh_token: String(refreshToken) }, address);
      const first = yield* json(yield* token(exchangeFields(yield* approved), address));
      const rotated = yield* refresh(first.refresh_token);
      assert.strictEqual(rotated.status, 200);
      const second = yield* json(rotated);
      // Retries within the minute get the same tokens and spend no rotation.
      for (let retry = 0; retry < 3; retry++) {
        const retried = yield* refresh(first.refresh_token);
        assert.strictEqual(retried.status, 200);
        assert.strictEqual((yield* json(retried)).refresh_token, second.refresh_token);
      }
      const again = yield* refresh(second.refresh_token);
      assert.strictEqual(again.status, 200);
      const third = yield* json(again);
      for (let attempt = 0; attempt < 4; attempt++) {
        const limited = yield* refresh(third.refresh_token);
        assert.strictEqual(limited.status, 429);
        assert.match(limited.headers.get("retry-after")!, /^\d+$/);
      }
      // Another connection rotates from the same address.
      const other = yield* json(yield* token(exchangeFields(yield* approved), address));
      assert.strictEqual((yield* refresh(other.refresh_token)).status, 200);
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
  it.effect("asks who meets whom, what the agent can and can't do, and where the answer goes", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const query = authorizeQuery(pkce().challenge);
      const page = yield* consentPage(query);
      assert.strictEqual(page.status, 200);
      const html = yield* text(page);
      for (const says of [
        "Connect an agent",
        '<strong>Agent</strong><br><span class="supporting-text">agent.example</span>',
        "wants to act as",
        '<strong>Patchy Dev</strong><br><span class="supporting-text">dev@patchy.local</span>',
        "Connect Agent to Patchy Dev?",
        "Agent will be able to",
        "Find Patchy Dev’s patches you can open",
        "Use the agent tools their builders added, as you",
        "Agent won’t be able to",
        "Do anything you can’t",
        "Every change it makes is logged as Patchy Dev via Agent.",
        "Your answer goes back to <strong>agent.example</strong>",
        '<a href="/machines">Your machines</a>',
        "Use another account"
      ])
        assert.include(html, says);
      assert.notInclude(html, "a program on this computer");
      const form = formOf(html);
      assert.deepStrictEqual(
        [form.action, form.userId],
        [`/oauth/authorize?${query}`, DEV_SEED.userId]
      );
      // The answer's redirect is the only other place a form may land, and nothing frames it.
      const csp = page.headers.get("content-security-policy")!;
      assert.include(csp, "form-action 'self' https://agent.example;");
      assert.include(csp, "frame-ancestors 'none'");
      assert.strictEqual(page.headers.get("cache-control"), "private, no-store");
    })
  );

  it.effect("warns when the answer goes to a program on this computer, naming its address", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const { challenge } = pkce();
      for (const [redirect, shown, source] of [
        ["http://127.0.0.1:33418/callback", "127.0.0.1:33418", "http://127.0.0.1:33418"],
        // CSP can't name an IPv6 host, so only the scheme is allowed.
        ["http://[::1]:33418/callback", "[::1]:33418", "http:"]
      ] as const) {
        const page = yield* consentPage(
          authorizeQuery(challenge, { client_id: LOCAL, redirect_uri: redirect })
        );
        const html = yield* text(page);
        assert.include(html, "Your answer goes to a program on this computer");
        assert.include(
          html,
          `<code>${shown}</code>. Allow only if you just started connecting it.`
        );
        assert.include(html, `Your answer goes back to <strong>${shown}</strong>`);
        assert.include(
          page.headers.get("content-security-policy")!,
          `form-action 'self' ${source};`
        );
      }
    })
  );

  it.effect("escapes and cuts what a stranger's document names its client", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const page = yield* consentPage(
        authorizeQuery(pkce().challenge, {
          client_id: HOSTILE,
          redirect_uri: "https://hostile.example/callback"
        })
      );
      const html = yield* text(page);
      assert.notInclude(html, "<img");
      assert.notInclude(html, "\u202e");
      assert.include(html, "&lt;img src=x onerror=alert(1)&gt;");
      // Cut to 64 characters, as the agent connection keeps it.
      assert.include(html, `&lt;img src=x onerror=alert(1)&gt;${"a".repeat(36)}</strong>`);
      assert.notInclude(html, "a".repeat(37));
    })
  );

  it.effect("Allow sends a code back with state and iss, which the client exchanges", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const pair = pkce();
      const form = formOf(yield* text(yield* consentPage(authorizeQuery(pair.challenge))));
      const allowed = yield* answer(form, "allow", { cookie: sessionOf() });
      assert.strictEqual(allowed.status, 303);
      assert.strictEqual(allowed.headers.get("referrer-policy"), "no-referrer");
      const location = new URL(allowed.headers.get("location")!);
      assert.strictEqual(`${location.origin}${location.pathname}`, CALLBACK);
      assert.deepStrictEqual(
        [location.searchParams.get("state"), location.searchParams.get("iss")],
        ["opaque", BASE]
      );
      const exchanged = yield* token({
        ...exchangeFields({ code: location.searchParams.get("code")!, verifier: pair.verifier }),
        redirect_uri: CALLBACK
      });
      assert.strictEqual(exchanged.status, 200);
    })
  );

  it.effect("Deny tells the client no and records nothing", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const form = formOf(yield* text(yield* consentPage(authorizeQuery(pkce().challenge))));
      const before = yield* consentRows;
      const denied = yield* answer(form, "deny", { cookie: sessionOf() });
      assert.strictEqual(denied.status, 303);
      const location = new URL(denied.headers.get("location")!);
      assert.deepStrictEqual(
        [
          location.searchParams.get("error"),
          location.searchParams.get("state"),
          location.searchParams.get("code")
        ],
        ["access_denied", "opaque", null]
      );
      assert.strictEqual(yield* consentRows, before);
    })
  );

  it.effect("refuses an answer another site sends, before anything is read or recorded", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const form = formOf(yield* text(yield* consentPage(authorizeQuery(pkce().challenge))));
      const before = yield* consentRows;
      const elsewhere: ReadonlyArray<Record<string, string>> = [
        { origin: "https://evil.example" },
        { origin: "null" },
        // No Origin at all: only the browser's own word that it came from here counts.
        { "sec-fetch-site": "cross-site" },
        {}
      ];
      for (const headers of elsewhere) {
        const refused = yield* answer(form, "allow", { cookie: sessionOf(), headers });
        assert.strictEqual(refused.status, 403);
        assert.isNull(refused.headers.get("location"));
      }
      assert.strictEqual(yield* consentRows, before);
    })
  );

  it.effect("asks again when the signed-in account changed while the page was open", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const form = formOf(yield* text(yield* consentPage(authorizeQuery(pkce().challenge))));
      const before = yield* consentRows;
      // The page was shown to someone else; the dev person is signed in now.
      const again = yield* answer({ ...form, userId: "usr_someone_else" }, "allow", {
        cookie: sessionOf()
      });
      assert.strictEqual(again.status, 409);
      assert.isNull(again.headers.get("location"));
      const html = yield* text(again);
      assert.include(html, "You signed in as someone else while this page was open.");
      assert.strictEqual(formOf(html).userId, DEV_SEED.userId);
      assert.strictEqual(yield* consentRows, before);
    })
  );

  it.effect("asks again when the client renamed itself since the page was shown", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const form = formOf(yield* text(yield* consentPage(authorizeQuery(pkce().challenge))));
      assert.strictEqual(form.client, "Agent");
      const before = yield* consentRows;
      // The page showed another name than the document gives now; the connection would keep this one.
      const again = yield* answer({ ...form, client: "Old Agent" }, "allow", {
        cookie: sessionOf()
      });
      assert.strictEqual(again.status, 409);
      assert.isNull(again.headers.get("location"));
      const html = yield* text(again);
      assert.include(html, "The agent changed its name while this page was open.");
      assert.strictEqual(formOf(html).client, "Agent");
      assert.strictEqual(yield* consentRows, before);
    })
  );

  it.effect("says a page answered after ten minutes ran out, sending nothing back", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const form = formOf(yield* text(yield* consentPage(authorizeQuery(pkce().challenge))));
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual((yield* answer(form, "deny", { cookie: sessionOf() })).status, 303);
      yield* TestClock.adjust("1 second");
      const late = yield* answer(form, "allow", { cookie: sessionOf() });
      assert.strictEqual(late.status, 410);
      assert.isNull(late.headers.get("location"));
      const html = yield* text(late);
      assert.include(html, "This request has run out");
      assert.include(html, "Nothing was connected. Start connecting again from Agent.");
    })
  );

  it.effect("with agent access off, names the admins, and Back to the agent tells it no", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const query = authorizeQuery(pkce().challenge);
      const shownWhileOn = formOf(yield* text(yield* consentPage(query)));
      yield* setAccess(false);

      const asMember = yield* consentPage(query, yield* member);
      assert.strictEqual(asMember.status, 200);
      const memberHtml = yield* text(asMember);
      assert.include(memberHtml, "Agent access is off at Patchy Dev");
      assert.include(
        memberHtml,
        "Agent can’t connect until an admin turns it on. At Patchy Dev that’s Patchy Dev."
      );
      assert.notInclude(memberHtml, "Turn it on at Company");
      assert.notInclude(memberHtml, 'value="allow"');

      const adminHtml = yield* text(yield* consentPage(query));
      assert.include(adminHtml, "You’re an admin: turn it on, then connect again from Agent.");
      assert.include(adminHtml, '<a class="btn btn-primary" href="/company/agent-access">');

      // Allow from a page shown while it was on is refused; Back to the agent denies.
      const allowed = yield* answer(shownWhileOn, "allow", { cookie: sessionOf() });
      assert.strictEqual(allowed.status, 409);
      assert.isNull(allowed.headers.get("location"));
      assert.include(yield* text(allowed), "Agent access is off at Patchy Dev");
      const back = yield* answer(formOf(adminHtml), "deny", { cookie: sessionOf() });
      assert.strictEqual(
        new URL(back.headers.get("location")!).searchParams.get("error"),
        "access_denied"
      );
    })
  );

  it.effect("an answer signed out since goes back to the page, answering nothing", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const form = formOf(yield* text(yield* consentPage(authorizeQuery(pkce().challenge))));
      const before = yield* consentRows;
      const signedOut = yield* answer(form, "allow");
      assert.strictEqual(signedOut.status, 303);
      assert.strictEqual(signedOut.headers.get("location"), form.action);
      assert.strictEqual(yield* consentRows, before);
    })
  );

  it.effect("an answer to a redirect the document doesn't list goes nowhere, Deny included", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const form = formOf(yield* text(yield* consentPage(authorizeQuery(pkce().challenge))));
      const action = form.action.replace(
        encodeURIComponent(CALLBACK),
        encodeURIComponent("https://evil.example/")
      );
      const denied = yield* answer({ ...form, action }, "deny", { cookie: sessionOf() });
      assert.strictEqual(denied.status, 400);
      assert.isNull(denied.headers.get("location"));
      assert.include(yield* text(denied), "check its redirect_uri");
    })
  );

  it.effect("refuses a request too long to carry through sign-in, before signing in", () =>
    Effect.gen(function* () {
      seen.length = 0;
      const query = authorizeQuery(pkce().challenge, { state: "s".repeat(2_048) });
      for (const cookie of [undefined, sessionOf()]) {
        const page = yield* send(
          `/oauth/authorize?${query}`,
          cookie === undefined ? {} : { headers: { cookie } }
        );
        assert.strictEqual(page.status, 414);
        assert.isNull(page.headers.get("location"));
        assert.isNull(page.headers.get("x-patchy-sign-in-url"));
        assert.include(yield* text(page), "longer than 2048 characters");
      }
      assert.deepStrictEqual(seen, []);
      // A query of exactly the bound is answered.
      const longest = authorizeQuery(pkce().challenge, { state: "" });
      longest.set("state", "s".repeat(2_048 - `${longest}`.length));
      assert.lengthOf(`${longest}`, 2_048);
      assert.strictEqual((yield* consentPage(longest)).status, 200);
    })
  );

  it.effect("limits consent pages per address once the person is signed in", () =>
    Effect.gen(function* () {
      yield* setAccess(true);
      const query = authorizeQuery(pkce().challenge);
      const load = (cookie: string | undefined, address: string) =>
        send(`/oauth/authorize?${query}`, cookie === undefined ? {} : { headers: { cookie } }, {
          address,
          limits: { "oauth.consent.perMinute": 2 }
        });
      // Signed-out loads only reach the sign-in door, and spend nothing.
      for (let attempt = 0; attempt < 3; attempt++)
        assert.strictEqual((yield* load(undefined, "198.51.100.40")).status, 401);
      for (let attempt = 0; attempt < 2; attempt++)
        assert.strictEqual((yield* load(sessionOf(), "198.51.100.40")).status, 200);
      const limited = yield* load(sessionOf(), "198.51.100.40");
      assert.strictEqual(limited.status, 429);
      assert.match(limited.headers.get("retry-after")!, /^\d+$/);
      assert.strictEqual((yield* load(sessionOf(), "198.51.100.41")).status, 200);
    })
  );
});
