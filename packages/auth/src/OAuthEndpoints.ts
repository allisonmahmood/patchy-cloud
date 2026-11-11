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
import {
  agentMark,
  answerPair,
  avatar,
  button,
  canList,
  escapeAttribute,
  escapeHtml,
  linkButton,
  meet,
  notice,
  refusal,
  sentenceList
} from "@patchy/core";
import { DeploymentConfig, Limits } from "@patchy/limits";
import * as AgentConnections from "./AgentConnections.js";
import * as ClientDocuments from "./ClientDocuments.js";
import * as Consents from "./Consents.js";
import * as OAuthMetadata from "./OAuthMetadata.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { accountFoot, doorResponse, returnPath, unavailableDoor, type DoorSpec } from "./page.js";

const MAX_BODY_BYTES = 8_192;
/** How long a consent page's answer counts once shown: as long as a device login's code. */
const ANSWER_SECONDS = 10 * 60;
/**
 * The longest authorization request answered, in characters of its query; clients' real ones are
 * well under 1 KiB. Sign-in and Use another account carry the request's address in their own,
 * encoded again at each hop (up to three times as long), and a browser also sends the page it
 * came from as `Referer`. A hop holds at most two such copies, about 12 KiB, which leaves room
 * for the browser's other headers inside Node's 16 KiB.
 */
const MAX_REQUEST_CHARS = 2_048;
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

/** Why the person is asked again, as a notice's title and body. */
const changedCopy = (changed: Changed) =>
  changed === "account"
    ? {
        title: "You signed in as someone else while this page was open.",
        body: "<p>Check who’s signed in, then answer again.</p>"
      }
    : {
        title: "The agent changed its name while this page was open.",
        body: "<p>Check who’s asking, then answer again.</p>"
      };

/** The answer that wasn't taken, as the refusal the page's focus starts on; `extra` joins its body. */
const changedNote = (changed: Changed | undefined, extra = "") => {
  if (changed === undefined) return "";
  const copy = changedCopy(changed);
  return refusal(notice({ tone: "warning", title: copy.title, body: `${copy.body}${extra}` }));
};

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
 * the page was shown, and carrying no controls of its own: the door's buttons name it with `form`.
 * Its redirect's site joins `form-action`, which browsers hold redirects to.
 */
const answerForm = (shown: Shown) =>
  `<form id="answer" method="post" action="${escapeAttribute(`/oauth/authorize${shown.search}`)}"><input type="hidden" name="userId" value="${escapeAttribute(shown.viewer.user.id)}"><input type="hidden" name="client" value="${escapeAttribute(shown.request.client.name)}"><input type="hidden" name="shown" value="${shown.at}"></form>`;

const answer = (label: string, action: "allow" | "deny", primary = false) =>
  button(label, {
    ...(primary ? { kind: "primary" as const } : {}),
    name: "action",
    value: action,
    form: "answer",
    block: true
  });

/** Who's signed in, and Use another account: signs out and signs in again back at this request. */
const signedIn = (shown: Shown) =>
  accountFoot(shown.viewer.user.email, {
    label: "Use another account",
    returnTo: `/oauth/authorize${shown.search}`
  });

const kicker = "Agent access";

/**
 * The consent page: who meets whom, what the client will and won't be able to do, and Deny or
 * Allow at equal weight. The client's name and site come from a stranger's document; the name is
 * already cleaned and cut to 64 characters (`AgentConnections.clientName`) and the site is a host
 * Patchy fetched from, and both are escaped here like every other value.
 */
const consentPage = (shown: Shown, changed: Changed | undefined): DoorSpec => {
  const { request, viewer } = shown;
  const agent = request.client.name;
  const company = viewer.company.name;
  const name = viewer.user.name.trim();
  const person = name === "" ? viewer.user.email : name;
  const host = escapeHtml(new URL(request.redirectUri).host);
  const local = ClientDocuments.returnsToThisComputer(request.redirectUri);
  const allowOnly = `<code>${host}</code>. Allow only if you just started connecting it.`;
  // One notice a page: asked again with a local answer, the warning joins the refusal.
  const localNote =
    !local || changed !== undefined
      ? ""
      : notice({
          tone: "warning",
          title: "Your answer goes to a program on this computer",
          body: `<p>${allowOnly}</p>`
        });
  return {
    kicker,
    title: `Let ${agent} use ${company}’s patches as you?`,
    body: `${changedNote(changed, local ? `<p>Your answer goes to a program on this computer: ${allowOnly}</p>` : "")}${meet(
      { mark: agentMark, name: agent, meta: request.client.site },
      "wants to act as",
      {
        mark: avatar(viewer.user.id, person),
        name: person,
        ...(name === "" ? {} : { meta: viewer.user.email })
      }
    )}${canList([
      {
        can: true,
        text: "It can find the patches you can open and use the agent tools their builders added, as you"
      },
      { can: true, text: `Every change it makes is logged as ${person} via ${agent}` },
      { can: false, text: "It can’t do anything you can’t, or publish" }
    ])}${localNote}${answerForm(shown)}`,
    actions: `${answerPair(answer("Deny", "deny"), answer("Allow", "allow", true))}<p class="meta">Your answer goes back to <strong>${host}</strong>. Disconnect it any time on <a href="/agents">Your agents</a>.</p>`,
    foot: signedIn(shown),
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
  options: {
    readonly changed: Changed | undefined;
    readonly status: number;
    /** An Allow that access turning off refused since the page was shown. */
    readonly refused?: boolean;
  }
): DoorSpec => {
  const { request, viewer } = shown;
  const agent = escapeHtml(request.client.name);
  const company = escapeHtml(viewer.company.name);
  const admin = viewer.role === "super_admin";
  return {
    kicker,
    title: `Agent access is off at ${viewer.company.name}`,
    body: `${
      options.refused === true && options.changed === undefined
        ? refusal(
            notice({
              tone: "warning",
              title: "Agent access was turned off before that went through.",
              body: "<p>Nothing was connected.</p>"
            })
          )
        : changedNote(options.changed)
    }<p>${agent} can’t connect until a super admin turns it on. ${admin ? `You’re a super admin: turn it on, then connect again from ${agent}.` : `At ${company} that’s ${sentenceList(admins)}.`}</p><p class="meta">Back to ${agent} tells it no.</p>${answerForm(shown)}`,
    actions: `${admin ? linkButton("Turn it on", "/settings/agent-access", { kind: "primary", block: true }) : ""}${answer(`Back to ${request.client.name}`, "deny")}`,
    foot: signedIn(shown),
    status: options.status,
    formActions: [formActionSource(request.redirectUri)]
  };
};

/** The page was answered after it ran out: nothing was connected or sent back. */
const ranOutPage = (shown: Shown): DoorSpec => ({
  kicker,
  title: "This request has run out",
  body: `<p>Nothing was connected. Start connecting again from ${escapeHtml(shown.request.client.name)}.</p>`,
  foot: signedIn(shown),
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
    .filter((user) => user.role === "super_admin" && user.deactivatedAt === null)
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
  if (access.on) return doorResponse(consentPage(shown, changed), session);
  const admins = yield* adminNames(shown.viewer.company.id);
  return doorResponse(
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
  doorResponse(
    {
      kicker,
      title: "This app can’t connect",
      body: `<p>${escapeHtml(reason)}</p><p>Nothing was connected. Start connecting again from the app.</p>`,
      status
    },
    session
  ).pipe(HttpServerResponse.setHeaders(headers));

/** A request too long to carry through sign-in is refused before it, on the page. */
const bounded = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* Session.Session;
    // `search` holds the query after its `?`.
    if (new URL(request.url, session.publicBaseUrl).search.length - 1 > MAX_REQUEST_CHARS)
      return unanswerable(
        session,
        `The agent's request is longer than ${MAX_REQUEST_CHARS} characters.`,
        414
      );
    return yield* app;
  });

/** Sign-in and database failures stay retryable pages. */
const pageErrors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    return yield* app.pipe(
      Effect.catchTags({
        SessionError: () => Effect.succeed(unavailableDoor("sign-in", { signOut: true }, session)),
        SqlError: () => Effect.succeed(unavailableDoor("patchy", { signOut: true }, session))
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
  const params = new URLSearchParams(
    yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.mapError(() => refused("The token request's body couldn't be read."))
    )
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
          return doorResponse(
            {
              kicker,
              title: "Too many requests",
              body: `<p>This address asked to connect apps too often. Try again in ${admitted.retryAfterSeconds} seconds.</p>`,
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
      const unread = doorResponse(
        {
          kicker,
          title: "This answer couldn’t be read",
          body: "<p>Nothing was connected. Start connecting again from the app.</p>",
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
              return doorResponse(ranOutPage(shown), session);
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
                      doorResponse(
                        accessOffPage(shown, admins, {
                          changed: undefined,
                          status: 409,
                          refused: true
                        }),
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

    yield* router.add(
      "GET",
      "/oauth/authorize",
      pageErrors(bounded(RequireSession.withViewer(authorize)))
    );
    yield* router.add(
      "POST",
      "/oauth/authorize",
      pageErrors(RequireSession.sameOrigin(bounded(answer)))
    );
    yield* router.add("POST", "/oauth/token", token);
    if (!dev) yield* router.add("OPTIONS", "/oauth/token", Effect.succeed(OAuthMetadata.preflight));
  })
);
