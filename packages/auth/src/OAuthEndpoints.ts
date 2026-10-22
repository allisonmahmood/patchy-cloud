/**
 * The authorization server's endpoints.
 *
 * `GET /oauth/authorize` is the person's: they sign in before anything else happens, so nobody
 * is sent anywhere first. Then the request is held to every rule (`Consents.check`), and a
 * refused one is explained on the page, never sent back to a redirect only a stranger's document
 * vouches for. A sound request gets the consent page, or says agent access is off. The page's
 * GET needs no same origin, because a CLI opens it through the operating system.
 *
 * `POST /oauth/authorize` is the page's answer, Allow or Deny, the only thing that returns to the
 * client. It needs the same origin, posts back the request's own query to be checked again, and
 * counts only as the account the page showed, for ten minutes after it was shown. Pages and
 * answers are limited per address once the person is signed in.
 *
 * `POST /oauth/token` is the client's: the code exchange and refresh, as form fields, answered
 * in OAuth's JSON and never cached. A failed attempt counts against its address, and a failure
 * past the minute's limit is answered 429, so an exchange or refresh that succeeds is never
 * refused, from a hosted client's shared address included. Rotations are limited per agent
 * connection; a retry within its minute is not a rotation. In production it answers CORS for any origin without credentials; a dev instance
 * answers none, and serves it on its `127.0.0.1` alias like every route.
 */
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
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
import { Companies, Users } from "@patchy/companies";
import { agentMark, avatar, escapeAttribute, escapeHtml, sentenceList } from "@patchy/core";
import { DeploymentConfig, Limits } from "@patchy/limits";
import * as AgentConnections from "./AgentConnections.js";
import * as ClientDocuments from "./ClientDocuments.js";
import * as Consents from "./Consents.js";
import * as OAuthMetadata from "./OAuthMetadata.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse, returnPath, signOutForm, type Page } from "./page.js";

const MAX_BODY_BYTES = 8_192;
/** How long a consent page's answer counts once shown: as long as a device login's code. */
const ANSWER_SECONDS = 10 * 60;
const MAX_ANSWER_BYTES = 4_096;
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

// The account the page showed, the client name it showed and when, in epoch seconds: an answer
// counts only as that account, for that name, and only while the page lasts.
const decodeAnswer = Schema.decodeUnknownEffect(
  Schema.Struct({
    userId: Schema.String,
    client: Schema.String,
    shown: Schema.FiniteFromString,
    action: Schema.Literals(["allow", "deny"])
  })
);

/** A sound request shown to the signed-in person: what every page of consent renders from. */
interface Shown {
  readonly request: Consents.ConsentRequest;
  /** The request's own query, which the answer posts back to be checked again. */
  readonly search: string;
  readonly viewer: RequireSession.Viewer["Service"];
  /** When the page was rendered, in epoch seconds. */
  readonly at: number;
}

/** What changed since the page was shown, so the person is asked again. */
type Changed = "account" | "client";

const changedNote = (changed: Changed | undefined) =>
  changed === undefined
    ? ""
    : `<div class="note note-warn" role="alert">${
        changed === "account"
          ? "You signed in as someone else while this page was open. Check who’s signed in, then answer again."
          : "The agent changed its name while this page was open. Check who’s asking, then answer again."
      }</div>`;

/**
 * Where an answer to `redirectUri` lands, as a CSP source: its origin, or only its scheme when
 * its host is one a source can't name exactly, such as `[::1]` or a name with other characters.
 */
const formActionSource = (redirectUri: string) => {
  const url = new URL(redirectUri);
  return /^[a-z\d-]+(?:\.[a-z\d-]+)*$/.test(url.hostname) ? url.origin : url.protocol;
};

/**
 * The answer's form, posting to the request's own address with the account, client name and time
 * the page was shown. Its redirect's site joins `form-action`, which browsers hold redirects to.
 */
const answerForm = (shown: Shown, buttons: string, className?: string) =>
  `<form${className === undefined ? "" : ` class="${className}"`} method="post" action="${escapeAttribute(`/oauth/authorize${shown.search}`)}"><input type="hidden" name="userId" value="${escapeAttribute(shown.viewer.user.id)}"><input type="hidden" name="client" value="${escapeAttribute(shown.request.client.name)}"><input type="hidden" name="shown" value="${shown.at}">${buttons}</form>`;

/** Use another account: signs out and signs in again back at this request. */
const anotherAccount = (shown: Shown) => signOutForm(true, `/oauth/authorize${shown.search}`);

const kicker = '<p class="auth-kicker">Connect an agent</p>';
const styles = `
    .consent-foot { margin-top: 18px; }
`;

/**
 * The consent page: who meets whom, what the client will and won't be able to do, and Allow or
 * Deny. The client's name and site come from a stranger's document; the name is already cleaned
 * and cut to 64 characters (`AgentConnections.clientName`) and the site is a host Patchy fetched
 * from, and both are escaped here like every other value.
 */
const consentPage = (shown: Shown, changed: Changed | undefined): Page => {
  const { request, viewer } = shown;
  const agent = escapeHtml(request.client.name);
  const company = escapeHtml(viewer.company.name);
  const name = viewer.user.name.trim();
  const person = name === "" ? viewer.user.email : name;
  const host = escapeHtml(new URL(request.redirectUri).host);
  const strip = `<div class="consent-strip"><div class="consent-strip-party">${agentMark}<div><strong>${agent}</strong><br><span class="supporting-text">${escapeHtml(request.client.site)}</span></div></div><span class="consent-strip-ask">wants to act as</span><div class="consent-strip-party">${avatar(viewer.user.id, person)}<div><strong>${escapeHtml(person)}</strong>${name === "" ? "" : `<br><span class="supporting-text">${escapeHtml(viewer.user.email)}</span>`}</div></div></div>`;
  const local = ClientDocuments.returnsToThisComputer(request.redirectUri)
    ? `<div class="note note-warn"><strong class="note-title">Your answer goes to a program on this computer</strong><p><code>${host}</code>. Allow only if you just started connecting it.</p></div>`
    : "";
  return {
    title: `Connect ${request.client.name} to ${viewer.company.name}?`,
    heading: `${kicker}${changedNote(changed)}${strip}<h1 class="page-heading">Connect ${agent} to ${company}?</h1>`,
    body: `<p class="can-head">${agent} will be able to</p><ul class="list list-compact can-list can-list-yes"><li class="list-row">Find ${company}’s patches you can open</li><li class="list-row">Use the agent tools their builders added, as you</li></ul><p class="can-head">${agent} won’t be able to</p><ul class="list list-compact can-list can-list-no"><li class="list-row">Do anything you can’t</li><li class="list-row">Publish</li></ul><p>Every change it makes is logged as ${escapeHtml(person)} via ${agent}.</p>${local}${answerForm(shown, '<div class="actions"><button class="btn btn-primary" type="submit" name="action" value="allow">Allow</button><button class="btn" type="submit" name="action" value="deny">Deny</button></div>')}<p class="supporting-text consent-foot">Your answer goes back to <strong>${host}</strong>. Disconnect it any time on <a href="/machines">Your machines</a>.</p>${anotherAccount(shown)}`,
    styles,
    status: changed === undefined ? 200 : 409,
    formActions: [formActionSource(request.redirectUri)]
  };
};

/**
 * Agent access is off at the person's company: who can turn it on, and Back to the client, which
 * denies. An admin gets the way to turn it on and connects again from their agent.
 */
const accessOffPage = (
  shown: Shown,
  admins: ReadonlyArray<string>,
  options: { readonly changed: Changed | undefined; readonly status: number }
): Page => {
  const { request, viewer } = shown;
  const agent = escapeHtml(request.client.name);
  const company = escapeHtml(viewer.company.name);
  const admin = viewer.role === "admin";
  return {
    title: `Agent access is off at ${viewer.company.name}`,
    heading: `${kicker}${changedNote(options.changed)}<h1 class="page-heading">Agent access is off at ${company}</h1>`,
    body: `<p>${agent} can’t connect until an admin turns it on. ${admin ? `You’re an admin: turn it on, then connect again from ${agent}.` : `At ${company} that’s ${sentenceList(admins)}.`}</p>${answerForm(shown, `${admin ? '<a class="btn btn-primary" href="/company#agent-access">Turn it on at Company</a>' : ""}<button class="btn" type="submit" name="action" value="deny">Back to ${agent}</button>`, "actions")}<p class="supporting-text consent-foot">Signed in as <span class="auth-email">${escapeHtml(viewer.user.email)}</span>. Back to ${agent} tells it no.</p>${anotherAccount(shown)}`,
    styles,
    status: options.status,
    formActions: [formActionSource(request.redirectUri)]
  };
};

/** The page was answered after it ran out: nothing was connected or sent back. */
const ranOutPage = (shown: Shown): Page => ({
  title: "This request has run out",
  heading: `${kicker}<h1 class="page-heading">This request has run out</h1>`,
  body: `<p>Nothing was connected. Start connecting again from ${escapeHtml(shown.request.client.name)}.</p><p class="supporting-text">Signed in as <span class="auth-email">${escapeHtml(shown.viewer.user.email)}</span></p>`,
  status: 410
});

/** The answer goes back to the client; the redirect sends no referrer with it. */
const answered = (location: string) =>
  HttpServerResponse.redirect(location, {
    status: 303,
    headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" }
  });

/** The company's active admins by name, as the off page names them. */
const adminNames = Effect.fn("OAuthEndpoints.adminNames")(function* (companyId: string) {
  const users = yield* (yield* Users.Users).list(companyId);
  return users
    .filter((user) => user.role === "admin" && user.deactivatedAt === null)
    .map((user) => user.name.trim() || user.email)
    .sort((a, b) => a.localeCompare(b));
});

/**
 * What a sound request asks the person: the consent page, or that agent access is off. `changed`
 * says why an answer is being asked again.
 */
const ask = Effect.fn("OAuthEndpoints.ask")(function* (shown: Shown, changed?: Changed) {
  const session = yield* Session.Session;
  const access = yield* (yield* Companies.Companies)
    .agentAccess(shown.viewer.company.id)
    .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
  if (access.on) return pageResponse(consentPage(shown, changed), session);
  const admins = yield* adminNames(shown.viewer.company.id);
  return pageResponse(
    accessOffPage(shown, admins, { changed, status: changed === undefined ? 200 : 409 }),
    session
  );
});

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
      | Companies.Companies
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

    const consentsPerMinute = deployment.get("oauth.consent.perMinute");

    const limited = (retryAfterSeconds: number, description: string) =>
      tokenResponse({ error: "rate_limited", error_description: description }, 429, {
        ...cors,
        "retry-after": String(retryAfterSeconds)
      });

    /**
     * `respond` to a sound request from the signed-in person, within their address's minute of
     * consent pages; a request that breaks a rule is explained on the page instead.
     */
    const sound = <E, R>(
      respond: (shown: Shown) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
    ) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* Session.Session;
        const admitted = yield* (yield* Limits.Limits).consume({
          key: `oauth-consent:${Option.getOrElse(request.remoteAddress, () => "")}`,
          limit: consentsPerMinute,
          window: Duration.minutes(1)
        });
        if (!admitted.allowed) {
          yield* WideEvents.enrich({ limitId: "oauth.consent.perMinute" });
          return pageResponse(
            {
              title: "Too many requests",
              body: `<p>This address asked to connect agents too often. Try again in ${admitted.retryAfterSeconds} seconds.</p>`,
              status: 429
            },
            session
          ).pipe(HttpServerResponse.setHeader("retry-after", String(admitted.retryAfterSeconds)));
        }
        const url = new URL(request.url, session.publicBaseUrl);
        const checked = yield* (yield* Consents.Consents).check(url.searchParams).pipe(
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
        if (HttpServerResponse.isHttpServerResponse(checked)) return checked;
        return yield* respond({
          request: checked,
          search: url.search,
          viewer: yield* RequireSession.Viewer,
          at: Math.floor((yield* Clock.currentTimeMillis) / 1_000)
        });
      });

    const authorize = sound((shown) => ask(shown));

    /**
     * Allow or Deny, as the account the page showed and while the page lasts. An answer from a
     * page left open across an account switch asks again as whoever is signed in now, and an
     * Allow whose client has renamed itself since asks again with the name it would record.
     */
    const answer = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const session = yield* Session.Session;
      const unread = pageResponse(
        {
          title: "This answer couldn't be read",
          body: "<p>Nothing was connected. Start connecting again from your agent.</p>",
          status: 400
        },
        session
      );
      if (Number(request.headers["content-length"]) > MAX_ANSWER_BYTES) return unread;
      const form = yield* request.urlParamsBody.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_ANSWER_BYTES)),
        Effect.flatMap((params) => decodeAnswer(Object.fromEntries(params))),
        Effect.option
      );
      if (Option.isNone(form)) return unread;
      const { userId, client, shown: shownAt, action } = form.value;
      // Signed out since: back to the page once signed in, never an answer.
      const returnTo = returnPath(request.url, session.publicBaseUrl) ?? "/";
      return yield* RequireSession.withViewer(
        sound((shown) =>
          Effect.gen(function* () {
            if (shown.at - shownAt > ANSWER_SECONDS) {
              yield* WideEvents.enrich({ code: "consent_ran_out" });
              return pageResponse(ranOutPage(shown), session);
            }
            if (userId !== shown.viewer.user.id) {
              yield* WideEvents.enrich({ code: "consent_account_changed" });
              return yield* ask(shown, "account");
            }
            const consents = yield* Consents.Consents;
            if (action === "deny") {
              yield* WideEvents.enrich({ code: "consent_denied" });
              return answered(consents.deny(shown.request));
            }
            // The document is fetched again for the answer; its connection keeps this name.
            if (client !== shown.request.client.name) {
              yield* WideEvents.enrich({ code: "consent_client_changed" });
              return yield* ask(shown, "client");
            }
            return yield* consents
              .approve({
                request: shown.request,
                userId: shown.viewer.user.id,
                companyId: shown.viewer.company.id
              })
              .pipe(
                Effect.tap(() => WideEvents.enrich({ code: "consent_allowed" })),
                Effect.map(answered),
                Effect.catchTags({
                  AgentAccessOff: () =>
                    Effect.map(adminNames(shown.viewer.company.id), (admins) =>
                      pageResponse(
                        accessOffPage(shown, admins, { changed: undefined, status: 409 }),
                        session
                      )
                    ),
                  UserUnavailable: () =>
                    Effect.succeed(
                      unanswerable(session, "Your account changed before that went through.", 409)
                    )
                })
              );
          })
        ),
        returnTo
      );
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
    yield* router.add("POST", "/oauth/authorize", pageErrors(RequireSession.sameOrigin(answer)));
    yield* router.add("POST", "/oauth/token", token);
    if (!dev) yield* router.add("OPTIONS", "/oauth/token", Effect.succeed(OAuthMetadata.preflight));
  })
);
