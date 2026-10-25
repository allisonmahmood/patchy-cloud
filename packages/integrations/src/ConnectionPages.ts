import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Analytics } from "@patchy/analytics";
import { type Companies, type Users } from "@patchy/companies";
import type * as ConnectionStore from "./ConnectionStore.js";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { pageResponse, RequireSession, Session, signOutForm } from "@patchy/auth";
import { escapeHtml } from "@patchy/core";
import type { RuntimeLog } from "@patchy/runtime";
import type { SqlError } from "effect/sql/SqlError";
import * as ConnectionPage from "./ConnectionPage.js";
import * as ConnectionsView from "./ConnectionsView.js";

type Params = Readonly<Record<string, string | undefined>>;

/**
 * Renders a page in the app shell or follows a change's redirect. A connection that cannot be
 * shown (missing, another company's, or a store that cannot answer) gets the card door.
 */
const serve = <R>(
  page: (
    viewer: RequireSession.Viewer["Service"],
    params: Params,
    query: URLSearchParams
  ) => Effect.Effect<ConnectionPage.Page, ConnectionStore.ConnectionError | SqlError, R>
) =>
  Effect.gen(function* () {
    const viewer = yield* RequireSession.Viewer;
    const session = yield* Session.Session;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const query = new URL(request.url, session.publicBaseUrl).searchParams;
    return yield* page(viewer, yield* HttpRouter.params, query).pipe(
      Effect.map((content) =>
        content.redirect
          ? HttpServerResponse.redirect(content.redirect, {
              status: 303,
              headers: { "cache-control": "private, no-store" }
            })
          : pageResponse(
              {
                ...content,
                heading: "",
                styles: ConnectionsView.styles,
                app: { viewer, section: "integrations" }
              },
              session
            )
      ),
      Effect.catch((error) =>
        error._tag === "SqlError"
          ? Effect.fail(error)
          : Effect.succeed(
              pageResponse(
                {
                  title: "Connection unavailable",
                  body: `<div class="note note-refused" role="alert">${escapeHtml(error.message)}<br><code>${escapeHtml(error.code)}</code></div><p><a href="/company/connections">Back to Integrations</a></p>${signOutForm()}`,
                  status: error.status
                },
                session
              )
            )
      )
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

const confirmations = ["rotate", "retarget", "description", "disconnect", "delete"] as const;

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
      | RuntimeLog.RuntimeLog
      | Analytics.Analytics
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const { indexPath, cataloguePath } = ConnectionsView;
    const get = (path: HttpRouter.PathInput, target: (params: Params) => ConnectionPage.Target) =>
      router.add(
        "GET",
        path,
        errors(
          RequireSession.withViewer(
            serve((viewer, params, query) => ConnectionPage.read(viewer, target(params), query))
          )
        )
      );
    const post = (path: HttpRouter.PathInput, change: (params: Params) => ConnectionPage.Change) =>
      router.add(
        "POST",
        path,
        errors(
          RequireSession.sameOrigin(
            RequireSession.withViewer(
              serve((viewer, params) => ConnectionPage.submit(viewer, change(params)))
            )
          )
        )
      );
    const integration = (params: Params) => ({
      kind: "connect" as const,
      integration: params.integration ?? ""
    });
    yield* get(indexPath, () => ({ kind: "index" }));
    yield* get(cataloguePath, () => ({ kind: "catalogue" }));
    yield* get(`${cataloguePath}/:integration`, integration);
    yield* post(`${cataloguePath}/:integration`, integration);
    yield* get(`${indexPath}/:id`, (params) => ({ kind: "view", id: params.id ?? "" }));
    for (const kind of ["test", "refresh", "reconnect"] as const)
      yield* post(`${indexPath}/:id/${kind}`, (params) => ({ kind, id: params.id ?? "" }));
    for (const action of confirmations) {
      yield* get(`${indexPath}/:id/${action}`, (params) => ({
        kind: "confirm",
        id: params.id ?? "",
        action
      }));
      yield* post(`${indexPath}/:id/${action}`, (params) => ({
        kind: action,
        id: params.id ?? ""
      }));
    }
  })
);
