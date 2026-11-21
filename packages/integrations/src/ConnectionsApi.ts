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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ConnectionStore from "./ConnectionStore.js";
import * as GithubSource from "./github/Source.js";

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

/**
 * Active members read safe metadata; administration remains browser-only. Only the integrations
 * the store reads are answered and offered: a model provider never is, nor a role while Models is
 * off, as an older release answers integrations it doesn't know.
 */
export const layer = HttpApiBuilder.group(PatchyApi, "connections", (handlers) =>
  Effect.gen(function* () {
    const connections = yield* ConnectionStore.ConnectionStore;
    // GitHub is offered only while its App is configured.
    const github = Option.isSome((yield* GithubSource.Source).app);
    const detail = (integration: string, handle: string) =>
      Effect.gen(function* () {
        const identity = yield* CurrentIdentity;
        // An integration it doesn't serve answers like an unknown handle, before any lookup.
        const known = connections.integrations.find((name) => name === integration);
        if (known === undefined)
          return yield* new ConnectionStore.ConnectionNotFound({
            companyId: identity.company.id,
            lookup: { integration, handle }
          });
        const found = yield* connections.detail(
          identity.company.id,
          known,
          handle,
          identity.user.id
        );
        return HttpServerResponse.jsonUnsafe(encodeDetail(found), noStore);
      }).pipe(
        Effect.catchTags({
          ConnectionStorageFailed: unavailable,
          ConnectionNotFound: (error) =>
            Effect.succeed(refuse(NotFound, { ok: false, error: error.message }, noStore.headers))
        })
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
          const shown = connections.integrations.filter(
            (integration) => asked.includes(integration) && (integration !== "github" || github)
          );
          const rows = (yield* connections.list(identity.company.id, identity.user.id)).filter(
            (row) => shown.includes(row.integration)
          );
          return HttpServerResponse.jsonUnsafe(
            encodeConnections({
              connections: rows.map((row) => {
                // A role whose provider is paused, or of an integration this release doesn't know,
                // reaches nothing, so it reads as paused with its own way out.
                const stopped =
                  row.integration === "models" &&
                  row.status === "connected" &&
                  !ConnectionStore.serving(row)
                    ? {
                        status: "disconnected" as const,
                        reason: "not_connected" as const,
                        hint:
                          row.role.provider === null
                            ? "Its model provider isn't available on this server. Ask an administrator at /settings/integrations."
                            : "Its model provider is paused. Ask an administrator to resume it at /settings/integrations."
                      }
                    : undefined;
                // An IMAP login its mail server refused fails every call until an admin fixes it, so it says so.
                const paused = row.integration === "imap" && row.display.paused !== undefined;
                // A GitHub account that suspended the App refuses every call until it's unsuspended there.
                const suspended =
                  row.integration === "github" &&
                  row.status === "connected" &&
                  row.suspendedAt !== null;
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
                  ...(suspended ? { suspended: true as const } : {}),
                  ...(stopped !== undefined
                    ? stopped
                    : row.status !== "connected"
                      ? {
                          reason: "not_connected" as const,
                          hint: "It's paused. Ask an administrator to resume it at /settings/integrations."
                        }
                      : paused
                        ? {
                            hint: "Its mail server refused the password, so every call fails auth_failed. Ask an administrator to replace the password or test it at /settings/integrations."
                          }
                        : suspended
                          ? {
                              hint: `The account suspended Patchy Cloud on GitHub, so every call fails source_unavailable until it's unsuspended there. patchy add ${row.integration}/${row.handle} still declares it.`
                            }
                          : { hint: `patchy add ${row.integration}/${row.handle}` })
                };
              }),
              ...(query.all
                ? {
                    offered: shown.map((integration) => ({
                      integration,
                      connected: rows.some(
                        (row) => row.integration === integration && ConnectionStore.serving(row)
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
