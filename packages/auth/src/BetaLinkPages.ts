/**
 * A beta link's page, `/join/<secret>`, for whoever the link was forwarded to. GET only reads;
 * the form posts back to the same address, same-origin, and its answer is a redirect to it, so
 * the page always shows the link's current state. Nothing here reads the browser's session: the
 * link admits by its secret alone, and Clerk's own sign-up proves the address it reserved.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as UrlParams from "effect/http/UrlParams";
import type * as SqlClient from "effect/sql/SqlClient";
import { capBody } from "@patchy/api";
import type { InviteMail } from "@patchy/companies";
import { button, type Cryptography, escapeHtml, field, input, linkButton } from "@patchy/core";
import * as BetaLinks from "./BetaLinks.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { doorResponse, unavailableDoor } from "./page.js";

/** An email and an action, with room to spare; anything bigger is no form of this page's. */
const MAX_FORM_BYTES = 4_096;

const kicker = "Private beta";

/** The reserved address as the page shows it, since anyone holding the link can open it. */
const masked = (email: string) => {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
};

/** The open link's form; after a refused submit it keeps what was typed and says why. */
const openPage = (
  link: BetaLinks.BetaLink,
  refused?: { readonly status: number; readonly message: string; readonly email: string }
) =>
  doorResponse({
    kicker,
    title: `A Patchy Cloud spot for ${link.label}`,
    // No action: the form posts to the page's own address, which the markup never repeats.
    body: `<p>Start with your work email. You’ll set up ${escapeHtml(link.label)}’s company next.</p><form id="beta-claim" method="post" novalidate><input type="hidden" name="action" value="claim">${field(
      {
        id: "beta-email",
        label: "Work email",
        ...(refused === undefined ? {} : { error: refused.message }),
        control: (aria) =>
          input(aria, {
            name: "email",
            type: "email",
            value: refused?.email,
            required: true,
            maxlength: 254,
            autocomplete: "email",
            inputmode: "email",
            autofocus: refused !== undefined
          })
      }
    )}</form>`,
    actions: button("Continue", { kind: "primary", block: true, form: "beta-claim" }),
    status: refused?.status
  });

const statePage = (
  link: BetaLinks.BetaLink,
  state: Exclude<BetaLinks.State, "open">,
  session: Session.Session["Service"]
) => {
  const email = `<span class="strong">${escapeHtml(masked(link.email ?? ""))}</span>`;
  switch (state) {
    case "sent":
      return doorResponse({
        kicker,
        title: "Check your email",
        body: `<p>Your invitation went to ${email}. It can land in spam.</p>`
      });
    case "failed":
      return BetaLinks.canRetry(link)
        ? doorResponse({
            kicker,
            title: "We couldn’t send your invitation",
            body: `<p>It’s for ${email}.</p><form id="beta-retry" method="post"><input type="hidden" name="action" value="retry"></form>`,
            actions: button("Try again", { kind: "primary", block: true, form: "beta-retry" })
          })
        : doorResponse({
            kicker,
            title: "We couldn’t send your invitation",
            body: `<p>It’s for ${email}. Ask the person who sent you this link.</p>`
          });
    case "used":
      return doorResponse({
        kicker,
        title: "This link has been used",
        body: "<p>If that was you, sign in to continue.</p>",
        actions: linkButton("Sign in", session.signInUrl("/"), { kind: "primary", block: true })
      });
    case "ended":
      return doorResponse({
        kicker,
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
        const form = yield* request.urlParamsBody.pipe(capBody(MAX_FORM_BYTES));
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
            SqlError: () => Effect.succeed(unavailableDoor("patchy")),
            HttpServerError: () =>
              Effect.succeed(
                doorResponse({
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
