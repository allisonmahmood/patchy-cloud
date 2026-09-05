import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { CompanyPage, Join, type Companies, type InviteMail, type Users } from "@patchy/companies";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse, returnPath, signOutForm, withCookies } from "./page.js";

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
  const page: Join.JoinPage = yield* Join.handle(
    {
      clerkUserId: claims.sub,
      email: claims.email,
      name: claims.name
    },
    membership,
    target
  );
  return page.redirect
    ? HttpServerResponse.redirect(page.redirect, { status: 303 })
    : pageResponse(
        { ...page, styles: Join.styles, body: `${page.body}${signOutForm(true)}` },
        session
      );
});

const company = Effect.fn("AuthPages.company")(function* (action: CompanyPage.Action) {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const page: CompanyPage.Page = yield* CompanyPage.handle(viewer, action);
  return page.redirect
    ? HttpServerResponse.redirect(page.redirect, {
        status: 303,
        headers: { "cache-control": "private, no-store" }
      })
    : pageResponse({ ...page, styles: CompanyPage.styles }, session);
});

const logout = Effect.gen(function* () {
  const claims = yield* RequireSession.SignedIn;
  const session = yield* Session.Session;
  yield* session.revoke(claims.sid);
  return withCookies(
    HttpServerResponse.redirect("/login", {
      status: 303,
      headers: { "cache-control": "private, no-store" }
    }),
    session.signOutCookies()
  );
});

/** Typed infrastructure failures remain retryable pages, never a fake successful sign-out. */
const errors = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    return yield* app.pipe(
      Effect.catchTags({
        SessionError: () =>
          Effect.succeed(
            pageResponse(
              {
                title: "Sign-in service unavailable",
                body: `<p>Please try again.</p>${signOutForm()}`,
                status: 502
              },
              session
            )
          ),
        SqlError: () =>
          Effect.succeed(
            pageResponse(
              {
                title: "Company service unavailable",
                body: `<p>Please try again.</p>${signOutForm()}`,
                status: 503
              },
              session
            )
          ),
        HttpServerError: () =>
          Effect.succeed(
            pageResponse(
              {
                title: "Invalid form",
                body: `<p>Return to <a href="/join">create-or-join</a> and submit the form again.</p>${signOutForm()}`,
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
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      "/login",
      Effect.gen(function* () {
        const session = yield* Session.Session;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, session.publicBaseUrl);
        const path =
          returnPath(url.searchParams.get("return"), session.publicBaseUrl) ?? "/company";
        return RequireSession.door(session, path, false, 200);
      })
    );
    yield* router.add(
      "GET",
      "/auth/session.js",
      HttpServerResponse.text(
        "void window.Clerk.load({ standardBrowser: true, telemetry: { disabled: true } });\n",
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
      "GET",
      "/company",
      errors(RequireSession.withViewer(company({ kind: "view" })))
    );
    yield* router.add(
      "POST",
      "/company/invites",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(company({ kind: "invite" }))))
    );
    for (const [path, kind] of [
      ["/company/invites/:id/revoke", "revoke"],
      ["/company/invites/:id/resend", "resend"],
      ["/company/users/:id/role", "role"],
      ["/company/users/:id/deactivate", "deactivate"],
      ["/company/users/:id/reactivate", "reactivate"]
    ] as const) {
      yield* router.add(
        "POST",
        path,
        errors(
          RequireSession.sameOrigin(
            RequireSession.withViewer(
              Effect.flatMap(HttpRouter.params, (params) => company({ kind, id: params.id ?? "" }))
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
);
