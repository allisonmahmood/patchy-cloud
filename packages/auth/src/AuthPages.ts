import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as UrlParams from "effect/http/UrlParams";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Analytics } from "@patchy/analytics";
import * as WideEvents from "@patchy/analytics/wide-events";
import type { AppShell } from "@patchy/core";
import {
  CompanyPage,
  Join,
  Terms,
  Users,
  type Companies,
  type InviteMail
} from "@patchy/companies";
import { linkButton } from "@patchy/core";
import type * as AgentConnections from "./AgentConnections.js";
import * as BetaLinks from "./BetaLinks.js";
import * as DevicePages from "./DevicePages.js";
import type * as DeviceLogins from "./DeviceLogins.js";
import * as MachinesPage from "./MachinesPage.js";
import type * as MachineTokens from "./MachineTokens.js";
import * as Receipt from "./Receipt.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import * as TermsPrompt from "./TermsPrompt.js";
import {
  accountFoot,
  doorResponse,
  pageResponse,
  returnPath,
  unavailableDoor,
  withCookies
} from "./page.js";

const join = Effect.gen(function* () {
  const claims = yield* RequireSession.SignedIn;
  const membership = yield* RequireSession.Enrollment;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, session.publicBaseUrl);
  const requestedReturn = returnPath(url.searchParams.get("return"), session.publicBaseUrl);
  // Returning to enrollment itself must not bounce an existing member forever.
  const target =
    requestedReturn && new URL(requestedReturn, session.publicBaseUrl).pathname !== "/join"
      ? requestedReturn
      : null;
  // A person a beta link let in starts their company with the name the link was made for.
  const suggested =
    membership === null
      ? yield* BetaLinks.arrive({ clerkUserId: claims.sub, email: claims.email })
      : Option.none();
  const page: Join.JoinPage = yield* Join.handle(
    {
      clerkUserId: claims.sub,
      email: claims.email,
      name: claims.name
    },
    membership,
    { returnTo: target, publicBaseUrl: session.publicBaseUrl, foot: accountFoot(claims.email) },
    Option.getOrUndefined(suggested)
  );
  return page.redirect
    ? HttpServerResponse.redirect(page.redirect, { status: 303 })
    : pageResponse(page, session);
});

/** People at `/settings/people` and Agent access at `/settings/agent-access`, with their forms. */
const company = Effect.fn("AuthPages.company")(function* (action: CompanyPage.Action) {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const page: CompanyPage.Page = yield* CompanyPage.handle(viewer, action);
  if (page.redirect) {
    const response = HttpServerResponse.redirect(page.redirect, {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    });
    return page.receipt === undefined
      ? response
      : Receipt.set(response, {
          userId: viewer.user.id,
          text: page.receipt,
          publicBaseUrl: session.publicBaseUrl
        });
  }
  const section: AppShell["section"] =
    action.kind === "view-agent-access" || action.kind === "agent-access"
      ? "agent-access"
      : "people";
  // A receipt waits under a dialog until a page shows it.
  const app =
    page.overlay === undefined
      ? { viewer, section }
      : { viewer: { ...viewer, receipt: undefined }, section, overlay: page.overlay };
  return pageResponse({ ...page, app }, session);
});

/**
 * Use another account carries a consent request's address, at most 2 KiB of query
 * (`OAuthEndpoints`), and up to three times that once encoded again as a form field.
 */
const MAX_LOGOUT_BYTES = 8_192;

/** Sign out, then to the sign-in door; Use another account names the page to sign in back to. */
const logout = Effect.gen(function* () {
  const claims = yield* RequireSession.SignedIn;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = yield* request.urlParamsBody.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_LOGOUT_BYTES))
  );
  const back = returnPath(
    Option.getOrNull(UrlParams.getFirst(form, "return")),
    session.publicBaseUrl
  );
  yield* session.revoke(claims.sid);
  return withCookies(
    HttpServerResponse.redirect(
      back === null ? "/login" : `/login?return=${encodeURIComponent(back)}`,
      {
        status: 303,
        headers: { "cache-control": "private, no-store" }
      }
    ),
    session.signOutCookies()
  );
});

/** The prompt's answer: four short fields, the return path at most a page address. */
const MAX_TERMS_BYTES = 8_192;

/**
 * Accept on the terms prompt (`TermsPrompt`): records the revisions it showed, as the account it
 * showed, then goes on to the page the prompt stood in for. An answer from a page left open
 * across an account switch or a new revision records nothing and asks again, unless whoever is
 * signed in has already accepted the current terms, who just goes on.
 */
const acceptTerms = Effect.gen(function* () {
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const form = yield* request.urlParamsBody.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_TERMS_BYTES))
  );
  const field = (name: string) => Option.getOrNull(UrlParams.getFirst(form, name));
  const returnTo = returnPath(field("return"), session.publicBaseUrl) ?? "/";
  return yield* RequireSession.forTerms(
    Effect.gen(function* () {
      const viewer = yield* RequireSession.Viewer;
      const users = yield* Users.Users;
      const onward = HttpServerResponse.redirect(returnTo, {
        status: 303,
        headers: { "cache-control": "private, no-store" }
      });
      const changed: TermsPrompt.Changed | undefined =
        field("userId") !== viewer.user.id
          ? "account"
          : field("terms") !== Terms.current.terms || field("privacy") !== Terms.current.privacy
            ? "terms"
            : undefined;
      if (changed === undefined) {
        yield* users.acceptTerms({ userId: viewer.user.id, revisions: Terms.current });
        yield* WideEvents.enrich({ code: "terms_accepted" });
        return onward;
      }
      if (yield* users.hasAcceptedTerms({ userId: viewer.user.id, revisions: Terms.current }))
        return onward;
      yield* WideEvents.enrich({ code: `terms_${changed}_changed` });
      return TermsPrompt.page(session, { user: viewer.user, returnTo }, changed);
    }),
    returnTo
  );
});

/** Typed infrastructure failures remain retryable pages, never a fake successful sign-out. */
const errors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    return yield* app.pipe(
      Effect.catchTags({
        SessionError: () => Effect.succeed(unavailableDoor("sign-in", { signOut: true }, session)),
        SqlError: () => Effect.succeed(unavailableDoor("patchy", { signOut: true }, session)),
        HttpServerError: () =>
          Effect.succeed(
            doorResponse(
              {
                title: "Invalid form",
                body: "<p>Go back and submit the form again.</p>",
                actions: linkButton("Back to People", "/settings/people", { block: true }),
                foot: accountFoot(undefined),
                status: 400
              },
              session
            )
          )
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
      | InviteMail.InviteMail
      | SqlClient.SqlClient
      | DeviceLogins.DeviceLogins
      | MachineTokens.MachineTokens
      | AgentConnections.AgentConnections
      | Analytics.Analytics
    >
> = Layer.mergeAll(
  DevicePages.layer,
  MachinesPage.layer,
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      yield* router.add(
        "GET",
        "/login",
        Effect.gen(function* () {
          const session = yield* Session.Session;
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, session.publicBaseUrl);
          const path =
            returnPath(url.searchParams.get("return"), session.publicBaseUrl) ?? "/agents";
          return RequireSession.door(session, path, false, 200);
        })
      );
      yield* router.add(
        "GET",
        "/auth/session.js",
        HttpServerResponse.text(
          `(() => {
  let loading;
  const load = () => {
    if (!window.Clerk) return Promise.reject(new Error("Clerk is unavailable."));
    if (!loading) loading = window.Clerk.load({
      standardBrowser: true,
      telemetry: { disabled: true }
    }).catch((error) => { loading = undefined; throw error; });
    return loading;
  };
  window.patchySession = {
    async refresh() {
      try {
        await load();
        const session = window.Clerk.session;
        if (!session) return "signed-out";
        const token = await session.getToken({ skipCache: true });
        return token === null ? "signed-out" : "refreshed";
      } catch {
        return "unavailable";
      }
    }
  };
  void load().catch(() => {});
})();\n`,
          {
            contentType: "text/javascript",
            headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }
          }
        )
      );
      yield* router.add("GET", "/join", errors(RequireSession.forEnrollment(join)));
      yield* router.add(
        "POST",
        "/join",
        errors(RequireSession.sameOrigin(RequireSession.forEnrollment(join)))
      );
      yield* router.add(
        "POST",
        TermsPrompt.ACCEPT_PATH,
        errors(RequireSession.sameOrigin(acceptTerms))
      );
      yield* router.add(
        "GET",
        "/settings/people",
        errors(RequireSession.withViewer(company({ kind: "view" })))
      );
      yield* router.add(
        "GET",
        "/settings/agent-access",
        errors(RequireSession.withViewer(company({ kind: "view-agent-access" })))
      );
      yield* router.add(
        "GET",
        "/settings/people/guests/:id/remove",
        errors(
          RequireSession.withViewer(
            Effect.flatMap(HttpRouter.params, (params) =>
              company({ kind: "view-guest-removal", id: params.id ?? "" })
            )
          )
        )
      );
      for (const [path, kind] of [
        ["/settings/people/invites", "invite"],
        ["/settings/agent-access", "agent-access"]
      ] as const) {
        yield* router.add(
          "POST",
          path,
          errors(RequireSession.sameOrigin(RequireSession.withViewer(company({ kind }))))
        );
      }
      for (const [path, kind] of [
        ["/settings/people/invites/:id/revoke", "revoke"],
        ["/settings/people/invites/:id/resend", "resend"],
        ["/settings/people/users/:id/role", "role"],
        ["/settings/people/guests/:id/remove", "remove-guest"]
      ] as const) {
        yield* router.add(
          "POST",
          path,
          errors(
            RequireSession.sameOrigin(
              RequireSession.withViewer(
                Effect.flatMap(HttpRouter.params, (params) =>
                  company({ kind, id: params.id ?? "" })
                )
              )
            )
          )
        );
      }
      yield* router.add(
        "POST",
        "/logout",
        errors(RequireSession.sameOrigin(RequireSession.withSession(logout)))
      );
    })
  )
);
