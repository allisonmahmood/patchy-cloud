import {
  ConnectionDetail,
  Connections,
  ConnectionUnavailable,
  CurrentIdentity,
  Integration,
  integrations,
  NotFound,
  PatchyApi,
  refuse
} from "@patchy/api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ConnectionStore from "./ConnectionStore.js";

const encodeConnections = Schema.encodeSync(Connections);
const isIntegration = Schema.is(Integration);
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
    const detail = (integration: string, handle: string) =>
      Effect.gen(function* () {
        const identity = yield* CurrentIdentity;
        // An unknown integration answers like an unknown handle.
        if (!isIntegration(integration))
          return yield* new ConnectionStore.ConnectionNotFound({
            companyId: identity.company.id,
            lookup: { integration, handle }
          });
        const row = (yield* connections.list(identity.company.id)).find(
          (row) => row.integration === integration && row.handle === handle
        );
        if (
          !row ||
          !(yield* connections.canUse(identity.company.id, row.id, {
            userId: identity.user.id,
            guest: false
          }))
        )
          return yield* new ConnectionStore.ConnectionNotFound({
            companyId: identity.company.id,
            lookup: { integration, handle }
          });
        const found = yield* connections.detail(identity.company.id, integration, handle);
        return HttpServerResponse.jsonUnsafe(encodeDetail(found), noStore);
      }).pipe(
        Effect.catchTags({
          ConnectionStorageFailed: unavailable,
          ConnectionNotFound: (error) =>
            Effect.succeed(refuse(NotFound, { ok: false, error: error.message }, noStore.headers))
        }),
        Effect.orDie
      );
    return handlers
      .handle("listConnections", ({ query }) =>
        Effect.gen(function* () {
          const identity = yield* CurrentIdentity;
          // A caller names the integrations it decodes. CLIs from before PostHog decode Postgres
          // only: they send nothing, or release 10's `all`.
          const asked =
            query.integrations === undefined || query.integrations === "all"
              ? ["postgres"]
              : query.integrations.split(",");
          const shown: ReadonlyArray<Integration> = integrations.filter((integration) =>
            asked.includes(integration)
          );
          const rows = (yield* Effect.filter(yield* connections.list(identity.company.id), (row) =>
            connections.canUse(identity.company.id, row.id, {
              userId: identity.user.id,
              guest: false
            })
          )).filter((row) => shown.includes(row.integration));
          return HttpServerResponse.jsonUnsafe(
            encodeConnections({
              connections: rows.map((row) => {
                // A paused IMAP login fails every call until an admin fixes it, so it says so.
                const paused = row.integration === "imap" && row.display.paused !== undefined;
                return {
                  id: row.id,
                  handle: row.handle,
                  integration: row.integration,
                  description: row.description,
                  status: row.status,
                  ...(row.integration === "pidgeon" && row.display.test
                    ? { test: true as const }
                    : {}),
                  ...(paused ? { paused: true as const } : {}),
                  ...(row.status !== "connected"
                    ? {
                        reason: "not_connected" as const,
                        hint: "Ask an administrator to reconnect it at /company/connections."
                      }
                    : paused
                      ? {
                          hint: "Paused: its mail server refused the password, so every call fails auth_failed. Ask an administrator to Test it or replace the password at /company/connections."
                        }
                      : { hint: `patchy add ${row.integration}/${row.handle}` })
                };
              }),
              ...(query.all
                ? {
                    offered: shown.map((integration) => ({
                      integration,
                      connected: rows.some(
                        (row) => row.integration === integration && row.status === "connected"
                      )
                    }))
                  }
                : {})
            }),
            noStore
          );
        }).pipe(Effect.catchTags({ ConnectionStorageFailed: unavailable }), Effect.orDie)
      )
      .handle("getConnection", ({ params }) => detail("postgres", params.handle))
      .handle("getIntegrationConnection", ({ params }) =>
        detail(params.integration, params.handle)
      );
  })
);
