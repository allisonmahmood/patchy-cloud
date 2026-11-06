/**
 * The terms prompt: once the terms or privacy notice move past what a signed-in person last
 * accepted, their next page in a browser is this card in its place, at the same address.
 * Accepting posts to `/auth/terms` (`AuthPages`), which records it and goes on to that page.
 *
 * Only a top-level page load is prompted, by what the browser says it is loading: never a
 * fetch, a frame, a stream or a form post, and never a client without a browser's fetch
 * metadata, so agents, machine tokens and the CLI pass. A form post goes through, and the page
 * it redirects to asks.
 */
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as WideEvents from "@patchy/analytics/wide-events";
import { Terms, Users } from "@patchy/companies";
import { escapeAttribute } from "@patchy/core";
import type * as Session from "./Session.js";
import { pageResponse, returnPath, signOutForm } from "./page.js";

/** Where the prompt's Accept posts. */
export const ACCEPT_PATH = "/auth/terms";

/** What the prompt showed, which its answer posts back so a switched account or revision asks again. */
export interface Shown {
  readonly userId: string;
  readonly returnTo: string;
}

/** Why an answer asked again instead of recording. */
export type Changed = "account" | "terms";

/** Navigations of the whole tab, by the fetch metadata every current browser sends. */
const isPageLoad = (request: HttpServerRequest.HttpServerRequest) =>
  request.method === "GET" &&
  request.headers["sec-fetch-mode"] === "navigate" &&
  request.headers["sec-fetch-dest"] === "document";

export const page = (
  session: Session.Session["Service"],
  shown: Shown,
  changed?: Changed
): HttpServerResponse.HttpServerResponse => {
  const { terms, privacy } = Terms.current;
  const note =
    changed === undefined
      ? ""
      : `<div class="note note-warn" role="alert">${
          changed === "account"
            ? "You signed in as someone else while this page was open."
            : "The terms changed while this page was open."
        }</div>`;
  const field = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeAttribute(value)}">`;
  return pageResponse(
    {
      title: "We’ve updated our terms",
      body: `${note}<p>Read the <a href="${escapeAttribute(Terms.url("terms", terms))}">Patchy Cloud terms</a> and <a href="${escapeAttribute(Terms.url("privacy", privacy))}">privacy notice</a>.</p><form class="actions" method="post" action="${ACCEPT_PATH}">${field("userId", shown.userId)}${field("terms", terms)}${field("privacy", privacy)}${field("return", shown.returnTo)}<button class="btn btn-primary" type="submit">Accept</button></form>${signOutForm()}`,
      status: changed === undefined ? 200 : 409
    },
    session
  );
};

/**
 * The prompt in place of this request's page, or null when it isn't a page load or the person
 * has accepted the current terms. The two page boundaries ask it: `RequireSession.withViewer`
 * and Serving's door. It is about the person alone, so a guest is asked for themselves.
 */
export const prompt = Effect.fn("TermsPrompt.prompt")(function* (
  session: Session.Session["Service"],
  userId: string
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!isPageLoad(request)) return null;
  const users = yield* Users.Users;
  if (yield* users.hasAcceptedTerms({ userId, revisions: Terms.current })) return null;
  yield* WideEvents.enrich({ code: "terms_prompted" });
  return page(session, {
    userId,
    returnTo: returnPath(request.url, session.publicBaseUrl) ?? "/"
  });
});
