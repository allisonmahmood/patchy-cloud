/** Local-only module adapter over Patchy's existing encrypted connection table and call log. */
import { RequireSession } from "@patchy/auth";
import { newInternalId } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as CredentialKeys from "../src/CredentialKeys.js";
import * as Pieces from "./Pieces.js";
import { definition, type Key } from "./catalog.js";

export class Refused extends Schema.TaggedError<Refused>()("CommunityRefused", {
  code: Schema.Literals(["forbidden", "missing", "invalid", "conflict"])
}) {
  get status() {
    return { forbidden: 403, missing: 404, invalid: 422, conflict: 409 }[this.code];
  }
  override get message() {
    return {
      forbidden: "Only company admins can use this local prototype.",
      missing: "This connection is unavailable in your company.",
      invalid:
        "Check the required credentials or action inputs, selected action, and connection handle (3–32 lowercase letters, digits or hyphens).",
      conflict: "The connection changed or that handle is already in use. Reload and try again."
    }[this.code];
  }
}
export interface Connection {
  readonly id: string;
  readonly handle: string;
  readonly status: "connected" | "disconnected";
}
export type Failure = Refused | Pieces.PieceFailure | SqlError | CredentialKeys.CredentialError;
/** Authorization is intentionally resolved for each signed-in request.
 * @effect-expect-leaking Viewer
 */
export class CommunityConnections extends Context.Service<
  CommunityConnections,
  {
    readonly list: (
      key: Key
    ) => Effect.Effect<ReadonlyArray<Connection>, Refused | SqlError, RequireSession.Viewer>;
    readonly connect: (input: {
      readonly key: Key;
      readonly handle: string;
      readonly credentials: Redacted.Redacted<Pieces.Credentials>;
      readonly id?: string;
    }) => Effect.Effect<string, Failure, RequireSession.Viewer>;
    readonly run: (
      key: Key,
      id: string,
      action?: string,
      inputs?: Readonly<Record<string, string>>
    ) => Effect.Effect<unknown, Failure, RequireSession.Viewer>;
    readonly disconnect: (
      key: Key,
      id: string
    ) => Effect.Effect<void, Failure, RequireSession.Viewer>;
    readonly delete: (key: Key, id: string) => Effect.Effect<void, Failure, RequireSession.Viewer>;
  }
>()("prototype/activepieces/CommunityConnections") {}

const integration = (key: Key) => `activepieces:${key}`;
const Handle = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/));
const validHandle = Schema.is(Handle);
const ConnectionRow = Schema.Struct({
  id: Schema.String,
  handle: Handle,
  status: Schema.Literals(["connected", "disconnected"])
});
const StoredRow = Schema.Struct({
  ...ConnectionRow.fields,
  credentials: Schema.String,
  keyId: Schema.String,
  revision: Schema.Int,
  credentialFormat: Schema.NullOr(Schema.String)
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ConnectionRow));
const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredRow));
const admin = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  if (viewer.role !== "admin") return yield* new Refused({ code: "forbidden" });
  return viewer;
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const pieces = yield* Pieces.Pieces;
  const logs = yield* RuntimeLog.RuntimeLog;

  const get = Effect.fn("CommunityConnections.get")(function* (
    key: Key,
    companyId: string,
    id: string
  ) {
    const rows = yield* sql`
      SELECT id, handle, status, credentials, key_id AS "keyId", credential_revision AS revision,
        display->>'credentialFormat' AS "credentialFormat"
      FROM connections WHERE company_id = ${companyId} AND id = ${id} AND integration = ${integration(key)}`.pipe(
      Effect.flatMap(decodeStored),
      Effect.catchTags({ SchemaError: Effect.die })
    );
    if (!rows[0]) return yield* new Refused({ code: "missing" });
    return rows[0];
  });

  const list = Effect.fn("CommunityConnections.list")(function* (key: Key) {
    const viewer = yield* admin;
    return yield* sql`SELECT id, handle, status FROM connections
      WHERE company_id = ${viewer.company.id} AND integration = ${integration(key)} ORDER BY handle`.pipe(
      Effect.flatMap(decodeRows),
      Effect.catchTags({ SchemaError: Effect.die })
    );
  });

  const connect = Effect.fn("CommunityConnections.connect")(function* (
    input: Parameters<CommunityConnections["Service"]["connect"]>[0]
  ) {
    const viewer = yield* admin;
    const { key } = input;
    if (!validHandle(input.handle)) return yield* new Refused({ code: "invalid" });
    // Authorize an existing id before handing any token to the external connector.
    const before = input.id ? yield* get(key, viewer.company.id, input.id) : undefined;
    if (!(yield* pieces.validate(key, input.credentials)))
      return yield* new Refused({ code: "invalid" });
    const id = before?.id ?? newInternalId("conn");
    const encrypted = yield* keys.encrypt(
      { companyId: viewer.company.id, id, integration: integration(key) },
      Redacted.make(JSON.stringify(Redacted.value(input.credentials)))
    );
    const rows = before
      ? yield* sql`UPDATE connections SET credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId},
          credential_revision = credential_revision + 1, status = 'connected', last_tested_at = now()
          , display = ${JSON.stringify({ piece: key, version: definition(key).version, credentialFormat: 1 })}::jsonb
          WHERE company_id = ${viewer.company.id} AND id = ${id} AND integration = ${integration(key)}
          AND credential_revision = ${before.revision} RETURNING id`
      : yield* sql`INSERT INTO connections (id, company_id, integration, handle, description, mode,
          status, display, credentials, key_id, credential_revision, metadata_revision, created_by, last_tested_at)
          VALUES (${id}, ${viewer.company.id}, ${integration(key)}, ${input.handle}, 'Local Activepieces community prototype',
          'company', 'connected', ${JSON.stringify({ piece: key, version: definition(key).version, credentialFormat: 1 })}::jsonb,
          ${encrypted.credentials}, ${encrypted.keyId}, 1, 1, ${viewer.user.id}, now())
          ON CONFLICT DO NOTHING RETURNING id`;
    if (!rows.length) return yield* new Refused({ code: "conflict" });
    return id;
  });

  const run = Effect.fn("CommunityConnections.run")(function* (
    key: Key,
    id: string,
    requestedAction?: string,
    inputs: Readonly<Record<string, string>> = {}
  ) {
    const viewer = yield* admin;
    const entry = definition(key);
    const action = requestedAction ?? Object.keys(entry.actions)[0]!;
    if (!Object.hasOwn(entry.actions, action)) return yield* new Refused({ code: "invalid" });
    const admitted = pieces.infos
      .find((info) => info.key === key)!
      .actions.find((candidate) => candidate.name === action)!;
    if (!Pieces.validInputs(admitted.fields, inputs))
      return yield* new Refused({ code: "invalid" });
    const started = yield* Clock.currentTimeMillis;
    const correlationId = newInternalId("corr");
    // Failed company lookups are logged to the caller's company, never the target's history.
    yield* logs.begin({
      companyId: viewer.company.id,
      userId: viewer.user.id,
      credentialKind: "admin",
      patchId: null,
      versionId: null,
      op: `activepieces.${key}.${action}`,
      resource: action,
      connectionId: id,
      correlationId,
      deadlineMs: 6000
    });
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const row = yield* get(key, viewer.company.id, id);
        if (row.status !== "connected") return yield* new Refused({ code: "missing" });
        const encrypted = yield* keys.decrypt(
          { companyId: viewer.company.id, id, integration: integration(key) },
          row
        );
        // Read tokens saved by the earlier Slack-only prototype without rewriting them.
        const credentials =
          row.credentialFormat === "1"
            ? yield* Pieces.decodeCredentials(Redacted.value(encrypted)).pipe(
                Effect.map(Redacted.make),
                Effect.catchTags({
                  SchemaError: () => Effect.fail(new CredentialKeys.CredentialDecryptionFailed({}))
                })
              )
            : entry.legacyCredentialField
              ? Redacted.make({ [entry.legacyCredentialField]: Redacted.value(encrypted) })
              : yield* new CredentialKeys.CredentialDecryptionFailed({});
        const value = yield* pieces.run(key, action, credentials, inputs);
        // A token rotation or disconnect during the request invalidates this result.
        const current = yield* get(key, viewer.company.id, id);
        if (current.status !== "connected" || current.revision !== row.revision)
          return yield* new Refused({ code: "conflict" });
        return value;
      })
    );
    yield* logs.finish({
      correlationId,
      outcome: Exit.isSuccess(result) ? "success" : "failure",
      outcomeCode: Exit.isSuccess(result) ? null : "community_action_failed",
      durationMs: (yield* Clock.currentTimeMillis) - started,
      rowCount: null
    });
    return yield* result;
  });

  const disconnect = Effect.fn("CommunityConnections.disconnect")(function* (key: Key, id: string) {
    const viewer = yield* admin;
    yield* get(key, viewer.company.id, id);
    yield* sql`UPDATE connections SET status = 'disconnected', credential_revision = credential_revision + 1,
      credentials = '', key_id = '' WHERE company_id = ${viewer.company.id} AND id = ${id} AND integration = ${integration(key)}`;
  });
  const remove = Effect.fn("CommunityConnections.delete")(function* (key: Key, id: string) {
    const viewer = yield* admin;
    yield* sql`SELECT id FROM connections WHERE company_id = ${viewer.company.id} AND id = ${id} FOR UPDATE`;
    yield* get(key, viewer.company.id, id);
    const declared =
      yield* sql`SELECT 1 FROM patches JOIN patch_versions ON patch_versions.patch_id = patches.id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      WHERE patches.company_id = ${viewer.company.id} AND declaration.value->>'kind' = 'community'
      AND declaration.value->>'id' = ${id} LIMIT 1`;
    if (declared.length) return yield* new Refused({ code: "conflict" });
    const rows =
      yield* sql`DELETE FROM connections WHERE company_id = ${viewer.company.id} AND id = ${id}
      AND integration = ${integration(key)} AND status = 'disconnected' RETURNING id`;
    if (!rows.length) return yield* new Refused({ code: "missing" });
  }, sql.withTransaction);
  return CommunityConnections.of({ list, connect, run, disconnect, delete: remove });
});
export const layer = Layer.effect(CommunityConnections, make);
