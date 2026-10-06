import type * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Companies, Users } from "@patchy/companies";
import type { ContentStore } from "@patchy/content-store";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { pageResponse, RequireSession, Session } from "@patchy/auth";
import { errors } from "./PortalPages.js";
import * as updates from "./updates.js";
import { updatesScript } from "./updatesScript.js";

const page = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const result = yield* Effect.result(updates.read);
  return pageResponse(
    {
      title: "What’s new in Patchy",
      heading: result._tag === "Failure" ? undefined : "",
      app: { viewer, section: "updates" },
      status: result._tag === "Failure" ? 503 : 200,
      body:
        result._tag === "Failure"
          ? '<p class="note note-warn" role="alert">Updates are unavailable. Please try again.</p>'
          : updates.render(result.success)
    },
    session
  );
});

const latest = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const result = yield* Effect.result(updates.read);
  return HttpServerResponse.jsonUnsafe(
    result._tag === "Failure"
      ? { error: "Updates unavailable" }
      : { viewerId: viewer.user.id, latest: result.success[0] ?? null },
    {
      status: result._tag === "Failure" ? 503 : 200,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" }
    }
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
      | ContentStore.ContentStore
      | SqlClient.SqlClient
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/updates", errors(RequireSession.withViewer(page)));
    yield* router.add("GET", "/updates/latest", errors(RequireSession.withViewer(latest)));
    yield* router.add(
      "GET",
      "/updates/client.js",
      HttpServerResponse.text(updatesScript, {
        contentType: "application/javascript",
        headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" }
      })
    );
  })
);
