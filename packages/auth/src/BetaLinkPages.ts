/**
 * A beta link's page, `/join/<secret>`, for whoever the link was forwarded to. GET only reads;
 * the form posts back to the same address, same-origin, and its answer is a redirect to it, so
 * the page always shows the link's current state. Nothing here reads the browser's session: the
 * link admits by its secret alone, and Clerk's own sign-up proves the address it reserved.
 */
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as UrlParams from "effect/http/UrlParams";
import type * as SqlClient from "effect/sql/SqlClient";
import type { InviteMail } from "@patchy/companies";
import { type Cryptography, escapeAttribute, escapeHtml } from "@patchy/core";
import * as BetaLinks from "./BetaLinks.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse } from "./page.js";

/** An email and an action, with room to spare; anything bigger is no form of this page's. */
const MAX_FORM_BYTES = 4_096;

const kicker = '<p class="auth-kicker">Private beta</p>';

/** The reserved address as the page shows it, since anyone holding the link can open it. */
const masked = (email: string) => {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
};

/** The open link's form; after a refused submit it keeps what was typed and says why. */
const openPage = (
  link: BetaLinks.BetaLink,
  refused?: { readonly status: number; readonly message: string; readonly email: string }
) => {
  const title = `A Patchy Cloud spot for ${link.label}`;
  const field = refused
    ? ` value="${escapeAttribute(refused.email)}" aria-describedby="beta-email-error" aria-invalid="true" autofocus`
    : "";
  const callout = refused
    ? `<div class="note note-refused field-callout" id="beta-email-error" role="alert"><strong class="note-title">${escapeHtml(refused.message)}</strong></div>`
    : "";
  return pageResponse({
    title,
    heading: `${kicker}<h1 class="page-heading">${escapeHtml(title)}</h1>`,
    // No action: the form posts to the page's own address, which the markup never repeats.
    body: `<p>Start with your work email. You'll set up ${escapeHtml(link.label)}'s company next.</p><form method="post" novalidate><input type="hidden" name="action" value="claim"><label class="field-label" for="beta-email">Work email</label><input class="field" id="beta-email" name="email" type="email" required maxlength="254" autocomplete="email" autocapitalize="none" spellcheck="false"${field}>${callout}<div class="actions"><button class="btn btn-primary" type="submit">Continue</button></div></form>`,
    status: refused?.status
  });
};

const statePage = (
  link: BetaLinks.BetaLink,
  state: Exclude<BetaLinks.State, "open">,
  session: Session.Session["Service"]
) => {
  const email = `<span class="auth-email">${escapeHtml(masked(link.email ?? ""))}</span>`;
  switch (state) {
    case "sent":
      return pageResponse({
        title: "Check your email",
        heading: `${kicker}<h1 class="page-heading">Check your email</h1>`,
        body: `<p>Your invitation went to ${email}. It can land in spam.</p>`
      });
    case "failed":
      return pageResponse({
        title: "We couldn't send your invitation",
        heading: `${kicker}<h1 class="page-heading">We couldn't send your invitation</h1>`,
        body: BetaLinks.canRetry(link)
          ? `<p>It's for ${email}.</p><form method="post"><input type="hidden" name="action" value="retry"><div class="actions"><button class="btn btn-primary" type="submit">Try again</button></div></form>`
          : `<p>It's for ${email}. Ask the person who sent you this link.</p>`
      });
    case "used":
      return pageResponse({
        title: "This link has been used",
        body: `<p>If that was you, sign in to continue.</p><div class="actions"><a class="btn btn-primary" href="${escapeAttribute(session.signInUrl("/"))}">Sign in</a></div>`
      });
    case "ended":
      return pageResponse({
        title: "This link no longer works",
        body: "<p>Ask the person who sent it for a new one.</p>",
        status: 410
      });
  }
};

const show = Effect.fn("BetaLinkPages.show")(function* (link: BetaLinks.BetaLink) {
  const state = BetaLinks.state(link, yield* Clock.currentTimeMillis);
  return state === "open" ? openPage(link) : statePage(link, state, yield* Session.Session);
});

/** `/join/:secret`; `notFound` answers a secret no link has. */
export const routes = (
  notFound: HttpServerResponse.HttpServerResponse
): Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      Session.Session | SqlClient.SqlClient | InviteMail.InviteMail | Cryptography.Cryptography
    >
> =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const view = Effect.gen(function* () {
        const { secret = "" } = yield* HttpRouter.params;
        const link = yield* BetaLinks.find(secret);
        return Option.isNone(link) ? notFound : yield* show(link.value);
      });
      const submit = Effect.gen(function* () {
        const { secret = "" } = yield* HttpRouter.params;
        const link = yield* BetaLinks.find(secret);
        if (Option.isNone(link)) return notFound;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const form = yield* request.urlParamsBody.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_FORM_BYTES))
        );
        const email = Option.getOrElse(UrlParams.getFirst(form, "email"), () => "");
        const refuse = (status: number) => (error: { readonly message: string }) =>
          Effect.succeed(openPage(link.value, { status, message: error.message, email }));
        return yield* (
          Option.getOrNull(UrlParams.getFirst(form, "action")) === "retry"
            ? BetaLinks.retry(secret)
            : BetaLinks.claim(secret, email)
        ).pipe(
          Effect.as(
            HttpServerResponse.redirect(`/join/${encodeURIComponent(secret)}`, {
              status: 303,
              headers: { "cache-control": "no-store" }
            })
          ),
          Effect.catchTags({
            BetaLinkNotFound: () => Effect.succeed(notFound),
            InvalidEmail: refuse(422),
            EmailAlreadyReserved: refuse(409)
          })
        );
      });
      const errors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        app.pipe(
          Effect.catchTags({
            SqlError: () =>
              Effect.succeed(
                pageResponse({
                  title: "Patchy is unavailable",
                  body: "<p>Please try again.</p>",
                  status: 503
                })
              ),
            HttpServerError: () =>
              Effect.succeed(
                pageResponse({
                  title: "Invalid form",
                  body: "<p>Go back and submit the form again.</p>",
                  status: 400
                })
              )
          })
        );
      yield* router.add("GET", "/join/:secret", errors(view));
      yield* router.add("POST", "/join/:secret", errors(RequireSession.sameOrigin(submit)));
    })
  );
