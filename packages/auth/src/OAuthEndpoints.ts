/**
 * The authorization server's endpoints.
 *
 * `GET /oauth/authorize` is the person's: they sign in before anything else happens, so nobody
 * is sent anywhere first. Then the request is held to every rule (`Consents.check`), and a
 * refused one is explained on the page, never sent back to a redirect only a stranger's document
 * vouches for. A sound request gets the consent page, whose answer is the only thing that
 * returns to the client.
 *
 * `POST /oauth/token` is the client's: the code exchange and refresh, as form fields, answered
 * in OAuth's JSON and never cached. A failed attempt counts against its address, and a failure
 * past the minute's limit is answered 429, so an exchange or refresh that succeeds is never
 * refused, from a hosted client's shared address included. Rotations are limited per agent
 * connection; a retry within its minute is not a rotation. In production it answers CORS for any origin without credentials; a dev instance
 * answers none, and serves it on its `127.0.0.1` alias like every route.
 */
import * as ByteSize from "effect/ByteSize";
import type * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import type { Users } from "@patchy/companies";
import { escapeHtml } from "@patchy/core";
import { DeploymentConfig, Limits } from "@patchy/limits";
import * as AgentConnections from "./AgentConnections.js";
import * as Consents from "./Consents.js";
import * as OAuthMetadata from "./OAuthMetadata.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse, signOutForm } from "./page.js";

const MAX_BODY_BYTES = 8_192;
/** The token request's parameters, each allowed once. */
const TOKEN_PARAMS = [
  "grant_type",
  "code",
  "code_verifier",
  "client_id",
  "redirect_uri",
  "resource",
  "refresh_token",
  "scope"
] as const;

/** A token request refused before it reaches a code or a refresh token. */
class TokenRequestRefused extends Schema.TaggedError<TokenRequestRefused>()("TokenRequestRefused", {
  error: Schema.Literals([
    "invalid_request",
    "unsupported_grant_type",
    "invalid_grant",
    "invalid_target"
  ]),
  description: Schema.String,
  status: Schema.Literals([400, 413])
}) {
  override get message() {
    return this.description;
  }
}

/** The consent page for a sound request. */
const consentPage = (
  request: Consents.ConsentRequest,
  viewer: RequireSession.Viewer["Service"],
  session: Session.Session["Service"]
) =>
  pageResponse(
    {
      title: `Connect ${request.client.name} to ${viewer.company.name}?`,
      heading: `<p class="auth-kicker">Connect an agent</p><h1 class="page-heading">Connect ${escapeHtml(request.client.name)} to ${escapeHtml(viewer.company.name)}?</h1>`,
      body: `<p class="supporting-text">${escapeHtml(request.client.name)} (${escapeHtml(request.client.site)}) asks to act as ${escapeHtml(viewer.user.email)}.</p>`
    },
    session
  );

/** Why a request can't be answered, on the page; nothing goes back to the client. */
const unanswerable = (
  session: Session.Session["Service"],
  reason: string,
  status: number,
  headers: Readonly<Record<string, string>> = {}
) =>
  pageResponse(
    {
      title: "This agent can't connect",
      body: `<p>${escapeHtml(reason)}</p><p>Nothing was connected. Start connecting again from your agent.</p>`,
      status
    },
    session
  ).pipe(HttpServerResponse.setHeaders(headers));

const authorize = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* Session.Session;
  const viewer = yield* RequireSession.Viewer;
  const consents = yield* Consents.Consents;
  const params = new URL(request.url, session.publicBaseUrl).searchParams;
  return yield* consents.check(params).pipe(
    Effect.map((checked) => consentPage(checked, viewer, session)),
    Effect.catchTags({
      AuthorizeRequestRefused: (refused) =>
        Effect.succeed(unanswerable(session, refused.message, 400)),
      ClientDocumentRefused: (refused) =>
        Effect.succeed(unanswerable(session, refused.message, 400)),
      ClientDocumentUnavailable: (unavailable) =>
        Effect.succeed(unanswerable(session, unavailable.message, 502)),
      ClientDocumentsBusy: (busy) =>
        Effect.succeed(
          unanswerable(session, busy.message, 503, {
            "retry-after": String(busy.retryAfterSeconds)
          })
        )
    })
  );
});

/** Sign-in and database failures stay retryable pages. */
const pageErrors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    const reply = (title: string, status: number) =>
      Effect.succeed(
        pageResponse({ title, body: `<p>Please try again.</p>${signOutForm()}`, status }, session)
      );
    return yield* app.pipe(
      Effect.catchTags({
        SessionError: () => reply("Sign-in service unavailable", 502),
        SqlError: () => reply("Patchy is unavailable", 503)
      })
    );
  });

/** The token request's fields, each at most once, from a form body of at most 8 KiB. */
const tokenParams = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const refused = (description: string, status: 400 | 413 = 400) =>
    new TokenRequestRefused({ error: "invalid_request", description, status });
  if (!(request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded"))
    return yield* refused("Send the token request as application/x-www-form-urlencoded.");
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES)
    return yield* refused(`The token request is larger than ${MAX_BODY_BYTES} bytes.`, 413);
  const body = yield* request.urlParamsBody.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.mapError(() => refused("The token request's body couldn't be read."))
  );
  const params = new URLSearchParams(
    body.params.map(([name, value]): [string, string] => [name, value])
  );
  const twice = TOKEN_PARAMS.find((name) => params.getAll(name).length > 1);
  if (twice !== undefined) return yield* refused(`Send ${twice} only once.`);
  return params;
});

const tokenResponse = (body: unknown, status: number, headers: Record<string, string>) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", ...headers }
  });

export const layer: Layer.Layer<
  never,
  Config.ConfigError | DeploymentConfig.InvalidLimit,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      | Session.Session
      | Users.Users
      | Consents.Consents
      | AgentConnections.AgentConnections
      | Limits.Limits
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const publicUrl = yield* Session.publicUrlConfig;
    const dev = Session.isLoopback(publicUrl);
    const cors: Record<string, string> = dev ? {} : OAuthMetadata.cors;
    const deployment = yield* DeploymentConfig.load;
    const failuresPerMinute = deployment.get("oauth.token.failures.perMinute");
    const rotationsPerMinute = deployment.get("oauth.token.rotations.perMinute");

    const limited = (retryAfterSeconds: number, description: string) =>
      tokenResponse({ error: "rate_limited", error_description: description }, 429, {
        ...cors,
        "retry-after": String(retryAfterSeconds)
      });

    const grant = Effect.gen(function* () {
      const params = yield* tokenParams;
      const sent = (name: (typeof TOKEN_PARAMS)[number]) => params.get(name) ?? undefined;
      const required = (names: ReadonlyArray<(typeof TOKEN_PARAMS)[number]>) =>
        Effect.gen(function* () {
          const missing = names.filter((name) => (sent(name) ?? "") === "");
          if (missing.length > 0)
            return yield* new TokenRequestRefused({
              error: "invalid_request",
              description: `Send ${missing.join(", ")}.`,
              status: 400
            });
        });
      const grantType = sent("grant_type");
      if (grantType === "authorization_code") {
        yield* required(["code", "code_verifier", "client_id"]);
        const consents = yield* Consents.Consents;
        const connected = yield* consents.exchange({
          code: sent("code")!,
          codeVerifier: sent("code_verifier")!,
          clientId: sent("client_id")!,
          redirectUri: sent("redirect_uri"),
          resource: sent("resource")
        });
        return connected.tokens;
      }
      if (grantType === "refresh_token") {
        yield* required(["refresh_token"]);
        const consents = yield* Consents.Consents;
        const connections = yield* AgentConnections.AgentConnections;
        const refreshToken = sent("refresh_token")!;
        const resource = sent("resource");
        if (resource !== undefined && !consents.resourceAllowed(resource))
          return yield* new Consents.ResourceRefused();
        const chain = yield* connections.chainOf(refreshToken);
        const clientId = sent("client_id");
        if (chain === null || (clientId !== undefined && clientId !== chain.clientId))
          return yield* new AgentConnections.RefreshRefused({ reason: "unknown" });
        // Only a current token rotates; a retry within its minute or a reuse spends nothing.
        const admitted = chain.current
          ? yield* (yield* Limits.Limits).consume({
              key: `oauth-token-rotations:${chain.id}`,
              limit: rotationsPerMinute,
              window: Duration.minutes(1)
            })
          : { allowed: true as const };
        if (!admitted.allowed) {
          yield* WideEvents.enrich({ limitId: "oauth.token.rotations.perMinute" });
          return limited(
            admitted.retryAfterSeconds,
            `This agent connection refreshed too often; try again in ${admitted.retryAfterSeconds} seconds.`
          );
        }
        return yield* connections.refresh(refreshToken);
      }
      return yield* new TokenRequestRefused(
        grantType === undefined
          ? { error: "invalid_request", description: "Send grant_type.", status: 400 }
          : {
              error: "unsupported_grant_type",
              description: "Patchy's token endpoint takes authorization_code and refresh_token.",
              status: 400
            }
      );
    });

    // A failure is answered as itself until its address has spent the minute's failures.
    const failed = (error: string, description: string, status: number) =>
      Effect.gen(function* () {
        yield* WideEvents.enrich({ code: error });
        const request = yield* HttpServerRequest.HttpServerRequest;
        const counted = yield* (yield* Limits.Limits).consume({
          key: `oauth-token-failures:${Option.getOrElse(request.remoteAddress, () => "")}`,
          limit: failuresPerMinute,
          window: Duration.minutes(1)
        });
        if (!counted.allowed) {
          yield* WideEvents.enrich({ limitId: "oauth.token.failures.perMinute" });
          return limited(
            counted.retryAfterSeconds,
            `Too many failed token requests from this address; try again in ${counted.retryAfterSeconds} seconds.`
          );
        }
        return tokenResponse({ error, error_description: description }, status, cors);
      });

    const token = grant.pipe(
      Effect.map((answer) =>
        HttpServerResponse.isHttpServerResponse(answer)
          ? answer
          : tokenResponse(
              {
                access_token: answer.accessToken,
                token_type: "Bearer",
                expires_in: answer.expiresIn,
                refresh_token: answer.refreshToken,
                scope: OAuthMetadata.SCOPE
              },
              200,
              cors
            )
      ),
      Effect.catchTags({
        TokenRequestRefused: (refused) =>
          failed(refused.error, refused.description, refused.status),
        CodeRefused: (refused) => failed("invalid_grant", refused.message, 400),
        ResourceRefused: (refused) => failed("invalid_target", refused.message, 400),
        RefreshRefused: (refused) => failed("invalid_grant", refused.message, 400),
        SqlError: () =>
          Effect.succeed(
            tokenResponse(
              { error: "temporarily_unavailable", error_description: "Try again shortly." },
              503,
              cors
            )
          )
      })
    );

    yield* router.add("GET", "/oauth/authorize", pageErrors(RequireSession.withViewer(authorize)));
    yield* router.add("POST", "/oauth/token", token);
    if (!dev) yield* router.add("OPTIONS", "/oauth/token", Effect.succeed(OAuthMetadata.preflight));
  })
);
