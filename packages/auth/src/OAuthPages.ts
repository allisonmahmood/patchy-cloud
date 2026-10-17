/**
 * OAuth over HTTP for MCP clients. Discovery (RFC 9728 protected resource metadata, RFC 8414
 * server metadata), registration and the token exchange are for clients, so they answer JSON to
 * any origin and read no cookies. The authorization endpoint is a session page: a signed-in
 * person answers whether a client may connect as them, and the answer returns to the client's
 * registered redirect URI. A request that names no registered client and redirect URI is
 * answered on the page and never redirected.
 */
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { BodyTooLarge } from "@patchy/api";
import { Companies, type Users } from "@patchy/companies";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import * as AgentAuth from "./AgentAuth.js";
import type * as MachineTokens from "./MachineTokens.js";
import * as OAuth from "./OAuth.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse, type Page } from "./page.js";

const MAX_BODY_BYTES = 8_192;

const styles = `
    .oauth-foot { margin-top: 24px; }
`;

const clientHeaders = { "access-control-allow-origin": "*" };
const noStore = { "cache-control": "no-store", pragma: "no-cache" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { ...clientHeaders, ...headers } });

const refusal = (error: OAuth.OAuthRefusal) =>
  json({ error: error.code, error_description: error.description }, 400, noStore);

/** Browser clients send JSON and an MCP version header, so they ask first. */
const preflight = HttpServerResponse.empty({
  status: 204,
  headers: {
    ...clientHeaders,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    "access-control-max-age": "86400"
  }
});

const decodeTokenRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    grant_type: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    redirect_uri: Schema.optional(Schema.String),
    client_id: Schema.optional(Schema.String),
    code_verifier: Schema.optional(Schema.String)
  })
);

// userId is the account the consent was rendered for; an answer only counts as that account.
const decodeAnswer = Schema.decodeUnknownEffect(
  Schema.Struct({ userId: Schema.String, action: Schema.Literals(["allow", "deny"]) })
);

const protectedResource = Effect.gen(function* () {
  const base = (yield* Session.Session).publicBaseUrl;
  return json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: "Patchy"
  });
});

/**
 * Where clients exchange codes. Clients send credentials over plain http only to loopback
 * addresses, and Claude Code's exemption covers `127.0.0.1` but not a dev instance's
 * `<name>.localhost` host, so such an instance names the same port on `127.0.0.1`.
 */
const tokenEndpoint = (base: string) => {
  const url = new URL(`${base}/oauth/token`);
  if (url.protocol === "http:" && url.hostname.endsWith(".localhost")) url.hostname = "127.0.0.1";
  return url.href;
};

const authorizationServer = Effect.gen(function* () {
  const base = (yield* Session.Session).publicBaseUrl;
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: tokenEndpoint(base),
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["patches"],
    authorization_response_iss_parameter_supported: true
  });
});

/** A client's body: JSON when it says so, otherwise form fields. */
const clientBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    return yield* new BodyTooLarge({ maxBytes: MAX_BODY_BYTES });
  }
  const body = (request.headers["content-type"] ?? "").startsWith("application/json")
    ? request.json
    : Effect.map(request.urlParamsBody, (params): Schema.Json => Object.fromEntries(params));
  return yield* body.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    // An unreadable body is answered as one that says nothing.
    Effect.catchTags({ HttpServerError: () => Effect.succeed(null) })
  );
});

const register = Effect.gen(function* () {
  const client = yield* OAuth.register(yield* clientBody);
  return json(
    {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1_000)
    },
    201,
    noStore
  );
});

const token = Effect.gen(function* () {
  const fields = yield* decodeTokenRequest(yield* clientBody).pipe(
    Effect.catchTags({
      SchemaError: () =>
        Effect.fail(
          new OAuth.OAuthRefusal({
            code: "invalid_request",
            description: "Send the token request as form fields."
          })
        )
    })
  );
  if (fields.grant_type !== undefined && fields.grant_type !== "authorization_code")
    return yield* new OAuth.OAuthRefusal({
      code: "unsupported_grant_type",
      description: "Patchy exchanges authorization codes only."
    });
  const { grant_type, code, redirect_uri, client_id, code_verifier } = fields;
  if (!grant_type || !code || !redirect_uri || !client_id || !code_verifier)
    return yield* new OAuth.OAuthRefusal({
      code: "invalid_request",
      description: "Send grant_type, code, redirect_uri, client_id and code_verifier."
    });
  const issued = yield* OAuth.redeem({
    code,
    clientId: client_id,
    redirectUri: redirect_uri,
    codeVerifier: code_verifier
  });
  return json(
    {
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: issued.expiresInSeconds,
      scope: "patches"
    },
    200,
    noStore
  );
});

/** Client endpoints answer every refusal as OAuth JSON. */
const clientErrors = <R>(
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    OAuth.OAuthRefusal | BodyTooLarge | SqlError,
    R
  >
) =>
  app.pipe(
    Effect.catchTags({
      OAuthRefusal: (error) => Effect.succeed(refusal(error)),
      BodyTooLarge: () =>
        Effect.succeed(
          json(
            { error: "invalid_request", error_description: "The request body is too large." },
            413,
            noStore
          )
        ),
      SqlError: () =>
        Effect.succeed(
          json(
            { error: "temporarily_unavailable", error_description: "Try again shortly." },
            503,
            noStore
          )
        )
    })
  );

/** A request a person may answer: its client and redirect URI are registered together. */
interface Approval {
  readonly client: OAuth.Client;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | undefined;
  readonly resource: string | undefined;
}

/** The client's request as the consent form carries it, and as a refreshed sign-in returns to it. */
const requestFields = (approval: Approval) =>
  Object.fromEntries(
    Object.entries({
      response_type: "code",
      client_id: approval.client.id,
      redirect_uri: approval.redirectUri,
      code_challenge: approval.codeChallenge,
      code_challenge_method: "S256",
      state: approval.state,
      resource: approval.resource
    }).filter((field): field is [string, string] => field[1] !== undefined)
  );

/** Sends the browser back to the client with `params`, and with the issuer as RFC 9207 asks. */
const back = (redirectUri: string, params: Record<string, string | undefined>) =>
  Effect.gen(function* () {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries({
      ...params,
      iss: (yield* Session.Session).publicBaseUrl
    }))
      if (value !== undefined) url.searchParams.set(name, value);
    return HttpServerResponse.redirect(url.href, {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    });
  });

const unanswerable = (body: string): Page => ({
  title: "This connection can't continue",
  body: `<p>${body}</p><p>Start connecting again from your agent.</p>`,
  status: 400
});

/**
 * Checks a client's request in the order OAuth requires: the client and its exact redirect URI
 * first, answered on the page, then the rest, answered at the redirect URI.
 */
const check = Effect.fn("OAuthPages.check")(function* (
  fields: Readonly<Record<string, string | undefined>>
) {
  const session = yield* Session.Session;
  const client = yield* OAuth.findClient(fields.client_id ?? "");
  if (client === null)
    return pageResponse(unanswerable("The app asking to connect is not registered here."), session);
  const redirectUri = fields.redirect_uri ?? "";
  if (!client.redirectUris.includes(redirectUri))
    return pageResponse(
      unanswerable("The app asked to return somewhere it did not register."),
      session
    );
  const state = fields.state;
  const refuse = (error: string, description: string) =>
    back(redirectUri, { error, error_description: description, state });
  if (fields.response_type !== "code")
    return yield* refuse("unsupported_response_type", "Patchy answers response_type=code only.");
  const codeChallenge = fields.code_challenge ?? "";
  if (fields.code_challenge_method !== "S256" || !OAuth.isCodeChallenge(codeChallenge))
    return yield* refuse(
      "invalid_request",
      "Send a code_challenge with code_challenge_method=S256."
    );
  const resource = fields.resource;
  const mcp = `${session.publicBaseUrl}/mcp`;
  if (resource !== undefined && resource.replace(/\/$/, "") !== mcp)
    return yield* refuse("invalid_target", `Patchy's only resource is ${mcp}.`);
  return { client, redirectUri, codeChallenge, state, resource } satisfies Approval;
});

/** The question for the current viewer, or why their company can't answer it yet. */
const consent = Effect.fn("OAuthPages.consent")(function* (
  approval: Approval,
  accountChanged = false
) {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const company = yield* (yield* Companies.Companies).findById(viewer.company.id);
  const target = new URL(approval.redirectUri);
  const name = escapeHtml(approval.client.name);
  const companyName = escapeHtml(viewer.company.name);
  const hidden = Object.entries({ ...requestFields(approval), userId: viewer.user.id })
    .map(
      ([field, value]) => `<input type="hidden" name="${field}" value="${escapeAttribute(value)}">`
    )
    .join("");
  const form = (buttons: string) =>
    `<form method="post" action="/oauth/authorize">${hidden}<div class="actions">${buttons}</div></form>`;
  // The answer redirects to the client; CSP host sources cannot spell an IPv6 literal.
  const formTargets = [target.hostname.startsWith("[") ? target.protocol : target.origin];
  if (!company?.agentsEnabled) {
    const admins = yield* AgentAuth.companyAdmins(viewer.company.id);
    const named = admins
      .map((admin) => `${escapeHtml(admin.name)} (<code>${escapeHtml(admin.email)}</code>)`)
      .join(", ");
    return pageResponse(
      {
        title: "Agent access is off",
        status: 403,
        styles,
        formTargets,
        body: `<p>Agent access is off at <strong>${companyName}</strong>, so ${name} can't connect yet.</p>${
          viewer.role === "admin"
            ? '<p>You are an admin: turn it on from <a href="/company">your company</a>, then reload this page.</p>'
            : `<p>Ask an admin to turn it on: ${named}.</p>`
        }${form('<button class="btn" type="submit" name="action" value="deny">Cancel</button>')}`
      },
      session
    );
  }
  return pageResponse(
    {
      title: `Connect ${approval.client.name} to Patchy?`,
      heading: `<p class="auth-kicker">Connect an agent</p><h1 class="page-heading">Connect ${name} to Patchy?</h1>`,
      status: accountChanged ? 409 : 200,
      styles,
      formTargets,
      body: `${accountChanged ? '<div class="note note-warn" role="alert">The signed-in account changed since this page loaded. Check the account, then answer again.</div>' : ""}<p>${name} will be able to find <strong>${companyName}</strong>'s patches you can open and use the agent tools their builders added, as you (<code>${escapeHtml(viewer.user.email)}</code>). Everything it does is logged as you via ${name}. Disconnect it any time on <a href="/machines">Your machines</a>.</p>${form(
        '<button class="btn btn-primary" type="submit" name="action" value="allow">Allow</button><button class="btn" type="submit" name="action" value="deny">Deny</button>'
      )}<p class="supporting-text oauth-foot">Your answer goes back to <code>${escapeHtml(target.host)}</code>.</p>`
    },
    session
  );
});

const getAuthorize = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* Session.Session;
  const approval = yield* check(
    Object.fromEntries(new URL(request.url, session.publicBaseUrl).searchParams)
  );
  if (HttpServerResponse.isHttpServerResponse(approval)) return approval;
  return yield* RequireSession.withViewer(consent(approval));
});

const postAuthorize = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    return yield* new BodyTooLarge({ maxBytes: MAX_BODY_BYTES });
  }
  const fields = Object.fromEntries(
    yield* request.urlParamsBody.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES))
    )
  );
  const answer = yield* decodeAnswer(fields);
  // The form is the person's browser speaking for the client: check it all again.
  const approval = yield* check(fields);
  if (HttpServerResponse.isHttpServerResponse(approval)) return approval;
  // Only the question survives a session refresh; the answer is never replayed.
  const returnTo = `/oauth/authorize?${new URLSearchParams(requestFields(approval))}`;
  return yield* RequireSession.withViewer(
    Effect.gen(function* () {
      const viewer = yield* RequireSession.Viewer;
      // A page left open across an account switch must not answer as the new account.
      if (answer.userId !== viewer.user.id) return yield* consent(approval, true);
      if (answer.action === "deny")
        return yield* back(approval.redirectUri, {
          error: "access_denied",
          error_description: "The person declined to connect.",
          state: approval.state
        });
      const company = yield* (yield* Companies.Companies).findById(viewer.company.id);
      if (!company?.agentsEnabled) return yield* consent(approval);
      const code = yield* OAuth.issueCode({
        clientId: approval.client.id,
        userId: viewer.user.id,
        redirectUri: approval.redirectUri,
        codeChallenge: approval.codeChallenge,
        resource: approval.resource ?? null
      });
      return yield* back(approval.redirectUri, { code, state: approval.state });
    }),
    returnTo
  );
});

type PageError = Effect.Error<typeof getAuthorize | typeof postAuthorize>;

const pageErrors = <R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, PageError, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    const reply = (title: string, body: string, status: number) =>
      Effect.succeed(pageResponse({ title, body, status }, session));
    return yield* app.pipe(
      Effect.catchTags({
        BodyTooLarge: () => reply("Invalid form", "<p>The submitted form is too large.</p>", 413),
        SchemaError: () =>
          reply("Invalid form", "<p>Open the page again and answer again.</p>", 400),
        HttpServerError: () =>
          reply("Invalid form", "<p>Open the page again and answer again.</p>", 400),
        SqlError: () => reply("Patchy is unavailable", "<p>Please try again.</p>", 503),
        SessionError: () => reply("Sign-in service unavailable", "<p>Please try again.</p>", 502)
      })
    );
  });

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      | Session.Session
      | Companies.Companies
      | Users.Users
      | SqlClient.SqlClient
      | MachineTokens.MachineTokens
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp"
    ] as const) {
      yield* router.add("GET", path, protectedResource);
      yield* router.add("OPTIONS", path, preflight);
    }
    yield* router.add("GET", "/.well-known/oauth-authorization-server", authorizationServer);
    yield* router.add("OPTIONS", "/.well-known/oauth-authorization-server", preflight);
    yield* router.add("POST", "/oauth/register", clientErrors(register));
    yield* router.add("OPTIONS", "/oauth/register", preflight);
    yield* router.add("POST", "/oauth/token", clientErrors(token));
    yield* router.add("OPTIONS", "/oauth/token", preflight);
    yield* router.add("GET", "/oauth/authorize", pageErrors(getAuthorize));
    yield* router.add(
      "POST",
      "/oauth/authorize",
      pageErrors(RequireSession.sameOrigin(postAuthorize))
    );
  })
);
