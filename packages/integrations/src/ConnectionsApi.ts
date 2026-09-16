import {
  ConnectionDetail,
  Connections,
  ConnectionUnavailable,
  CurrentIdentity,
  NotFound,
  PatchyApi,
  refuse
} from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as ConnectionStore from "./ConnectionStore.js";

const encodeConnections = Schema.encodeSync(Connections);
const encodeDetail = Schema.encodeSync(ConnectionDetail);
const noStore = { headers: { "cache-control": "private, no-store" } };
const unavailable = (error: ConnectionStore.ConnectionStorageFailed) =>
  Effect.succeed(
    refuse(
      ConnectionUnavailable,
      { ok: false, code: error.code, error: error.message },
      noStore.headers
    )
  );

/** Active members read safe metadata; administration remains browser-only. */
export const layer = HttpApiBuilder.group(PatchyApi, "connections", (handlers) =>
  Effect.gen(function* () {
    const connections = yield* ConnectionStore.ConnectionStore;
    return handlers
      .handle("listConnections", ({ query }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const rows = yield* connections.list(identity.company.id);
          return HttpServerResponse.jsonUnsafe(
            encodeConnections({
              connections: rows.map(({ id, handle, integration, description, status }) => ({
                id,
                handle,
                integration,
                description,
                status,
                ...(status === "connected"
                  ? { hint: `patchy add postgres/${handle}` }
                  : {
                      reason: "not_connected" as const,
                      hint: "Ask an administrator to reconnect it at /company/connections."
                    })
              })),
              ...(query.all
                ? {
                    offered: [
                      {
                        integration: "postgres",
                        connected: rows.some((row) => row.status === "connected")
                      }
                    ]
                  }
                : {})
            }),
            noStore
          );
        }).pipe(Effect.catchTags({ ConnectionStorageFailed: unavailable }), Effect.orDie)
      )
      .handle("getConnection", ({ params }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          const detail = yield* connections.detail(identity.company.id, params.handle);
          return HttpServerResponse.jsonUnsafe(encodeDetail(detail), noStore);
        }).pipe(
          Effect.catchTags({
            ConnectionStorageFailed: unavailable,
            ConnectionNotFound: (error) =>
              Effect.succeed(refuse(NotFound, { ok: false, error: error.message }, noStore.headers))
          })
        )
      );
  })
);
