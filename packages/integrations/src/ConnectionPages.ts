import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { type Companies, type Users } from "@patchy/companies";
import type * as ConnectionStore from "./ConnectionStore.js";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { pageResponse, RequireSession, Session, signOutForm } from "@patchy/auth";
import { escapeHtml } from "@patchy/core";
import * as ConnectionPage from "./ConnectionPage.js";

const page = Effect.fn("ConnectionPages.page")(function* (action: ConnectionPage.Action) {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const result = new URL(request.url, session.publicBaseUrl).searchParams.get("result");
  const content: ConnectionPage.Page = yield* ConnectionPage.handle(viewer, action, result).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        title: "Connection unavailable",
        body: `<div class="note note-warn" role="alert">${escapeHtml(error.message)}<br><code>${escapeHtml(error.code)}</code></div><p><a href="/company/connections">Return to connections</a> and try again.</p>`,
        status: error.status
      })
    )
  );
  return content.redirect
    ? HttpServerResponse.redirect(content.redirect, {
        status: 303,
        headers: { "cache-control": "private, no-store" }
      })
    : pageResponse(
        { ...content, styles: ConnectionPage.styles, body: `${content.body}${signOutForm()}` },
        session
      );
});

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
          )
      })
    );
  });

/** Integrations mounts its own pages; Auth remains independent of integrations. */
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
      | ConnectionStore.ConnectionStore
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "GET",
      "/company/connections",
      errors(RequireSession.withViewer(page({ kind: "list" })))
    );
    yield* router.add(
      "GET",
      "/company/connections/:id",
      errors(
        RequireSession.withViewer(
          Effect.flatMap(HttpRouter.params, (params) => page({ kind: "view", id: params.id ?? "" }))
        )
      )
    );
    yield* router.add(
      "POST",
      "/company/connections/connect",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(page({ kind: "connect" }))))
    );
    for (const kind of [
      "test",
      "rotate",
      "retarget",
      "refresh",
      "disconnect",
      "reconnect",
      "description",
      "delete"
    ] as const) {
      yield* router.add(
        "POST",
        `/company/connections/:id/${kind}`,
        errors(
          RequireSession.sameOrigin(
            RequireSession.withViewer(
              Effect.flatMap(HttpRouter.params, (params) => page({ kind, id: params.id ?? "" }))
            )
          )
        )
      );
    }
  })
);
