import type { RequireSession } from "@patchy/auth";
import { newInternalId } from "@patchy/core";
import * as Companies from "@patchy/companies/Companies";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Nango from "./Nango.js";
import * as Store from "./ConnectionStore.js";

const decodeSession = Schema.decodeUnknownEffect(
  Schema.Struct({ data: Schema.Struct({ connect_link: Schema.String }) })
);
const decodeConnections = Schema.decodeUnknownEffect(
  Schema.Struct({
    connections: Schema.Array(
      Schema.Struct({
        connection_id: Schema.String,
        provider_config_key: Schema.String,
        provider: Schema.String,
        tags: Schema.NullOr(Schema.Record(Schema.String, Schema.String))
      })
    )
  })
);
const Attempt = Schema.Struct({
  id: Schema.String,
  integration: Schema.Literals(Object.keys(Nango.providers) as Array<keyof typeof Nango.providers>),
  handle: Schema.String,
  description: Schema.String,
  connectionId: Schema.NullOr(Schema.String),
  action: Schema.String
});
const decodeAttempt = Schema.decodeUnknownEffect(Schema.Array(Attempt));
const safe = {
  SqlError: (cause: unknown) =>
    Effect.fail(
      new Store.ConnectionStorageFailed({ operation: "connect", cause: Redacted.make(cause) })
    ),
  SchemaError: (cause: unknown) =>
    Effect.fail(
      new Store.ConnectionStorageFailed({ operation: "connect", cause: Redacted.make(cause) })
    )
};
const isDescription = Schema.is(Store.Description);
const invalid = () => new Nango.Failed({ stage: "authorization" });
/** Only this server creates sessions; the opaque attempt binds Nango's result to this admin. */
export const begin = Effect.fn("NangoConnect.begin")(
  function* (
    viewer: RequireSession.Viewer["Service"],
    input: {
      readonly integration: keyof typeof Nango.providers;
      readonly handle: string;
      readonly description: string;
      readonly connectionId?: string;
      readonly action?: string;
    }
  ) {
    if (viewer.role !== "admin") return yield* invalid();
    if (!Companies.isHandle(input.handle)) return yield* new Store.InvalidConnectionHandle({});
    if (!isDescription(input.description)) return yield* new Store.InvalidConnectionDescription({});
    const sql = yield* SqlClient.SqlClient;
    const id = newInternalId("oauth");
    const provider = Nango.providers[input.integration];
    const result = yield* Nango.request("POST", "/connect/sessions", {
      allowed_integrations: [provider.configKey],
      end_user: { id: viewer.user.id },
      organization: { id: viewer.company.id },
      tags: { patchy_attempt: id, patchy_company: viewer.company.id, patchy_user: viewer.user.id }
    }).pipe(
      Effect.flatMap(decodeSession),
      Effect.mapError(
        (cause) => new Nango.Failed({ stage: "authorization", cause: Redacted.make(cause) })
      )
    );
    yield* sql`DELETE FROM connector_attempts WHERE expires_at < now()`;
    yield* sql`INSERT INTO connector_attempts (id, company_id, user_id, integration, handle, description, connection_id, action, expires_at) VALUES (${id}, ${viewer.company.id}, ${viewer.user.id}, ${input.integration}, ${input.handle}, ${input.description}, ${input.connectionId ?? null}, ${input.action ?? "connect"}, now() + interval '10 minutes')`;
    return { id, link: result.data.connect_link };
  },
  Effect.catchTags({ SqlError: safe.SqlError })
);
/** The browser supplies an attempt id only, never an upstream connection selector. */
export const finish = Effect.fn("NangoConnect.finish")(function* (
  viewer: RequireSession.Viewer["Service"],
  id: string
) {
  if (viewer.role !== "admin") return yield* invalid();
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Store.ConnectionStore;
  let previous: Nango.Mapping | undefined;
  const connection = yield* sql.withTransaction(
    Effect.gen(function* () {
      const attempts =
        yield* sql`SELECT id, integration, handle, description, connection_id AS "connectionId", action FROM connector_attempts WHERE id = ${id} AND company_id = ${viewer.company.id} AND user_id = ${viewer.user.id} AND expires_at > now() FOR UPDATE`.pipe(
          Effect.flatMap(decodeAttempt)
        );
      const attempt = attempts[0];
      if (attempt === undefined) return yield* invalid();
      const provider = Nango.providers[attempt.integration];
      const query = new URLSearchParams({
        integrationId: provider.configKey,
        "tags[patchy_attempt]": attempt.id,
        limit: "2"
      });
      const result = yield* Nango.request("GET", `/connections?${query}`).pipe(
        Effect.flatMap(decodeConnections),
        Effect.mapError(
          (cause) => new Nango.Failed({ stage: "authorization", cause: Redacted.make(cause) })
        )
      );
      const upstream = result.connections[0];
      if (
        result.connections.length !== 1 ||
        upstream === undefined ||
        upstream.provider_config_key !== provider.configKey ||
        upstream.provider !== provider.provider ||
        upstream.tags?.patchy_attempt !== attempt.id ||
        upstream.tags.patchy_company !== viewer.company.id ||
        upstream.tags.patchy_user !== viewer.user.id
      )
        return yield* invalid();
      const credentials = Nango.credentials({
        providerConfigKey: upstream.provider_config_key,
        connectionId: upstream.connection_id
      });
      const identity = { companyId: viewer.company.id, userId: viewer.user.id };
      let connection: Store.Connection;
      if (attempt.connectionId === null)
        connection = yield* store.connect({
          ...identity,
          integration: attempt.integration,
          handle: attempt.handle,
          description: attempt.description,
          credentials
        });
      else {
        const current = yield* store.get(identity.companyId, attempt.connectionId);
        if (current.integration !== attempt.integration) return yield* invalid();
        if (current.status === "connected")
          previous = yield* store
            .poolCredentials(
              identity.companyId,
              {
                kind: current.integration,
                id: current.id,
                handle: current.handle,
                revision: current.metadataRevision
              },
              current.credentialRevision
            )
            .pipe(Effect.flatMap(Nango.parseCredentials));
        const target = { ...identity, id: current.id, credentials };
        yield* attempt.action === "retarget" ? store.retarget(target) : store.rotate(target);
        connection = yield* store.reconnect(target);
      }
      yield* sql`DELETE FROM connector_attempts WHERE id = ${id}`;
      return connection;
    })
  );
  if (previous !== undefined) yield* Nango.remove(previous);
  return connection;
}, Effect.catchTags(safe));
