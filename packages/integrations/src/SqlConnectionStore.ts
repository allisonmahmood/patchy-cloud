import { PostgresDeclaration } from "@patchy/api";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Companies from "@patchy/companies/Companies";
import { newInternalId } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as ConnectionStore from "./ConnectionStore.js";
import {
  Connection,
  ConnectionChanged,
  ConnectionHandleTaken,
  ConnectionInUse,
  ConnectionNotConnected,
  ConnectionNotFound,
  ConnectionRetargetRequired,
  ConnectionStorageFailed,
  Description,
  InvalidConnectionDescription,
  InvalidConnectionHandle,
  StaleGenerated,
  type ConnectInput,
  type CredentialsInput,
  type Identity
} from "./ConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import * as Source from "./postgres/Source.js";

const isDescription = Schema.is(Description);
const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(Snapshot));
const encodeDisplay = Schema.encodeSync(Schema.fromJsonString(Source.Display));
const StoredConnection = Schema.Struct({
  ...Connection.fields,
  credentials: Schema.String,
  keyId: Schema.String
});
type StoredConnection = typeof StoredConnection.Type;
const Lookup = Schema.Struct({
  companyId: Schema.String,
  id: Schema.String,
  locked: Schema.Boolean
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const source = yield* Source.Source;
  const audit = yield* RuntimeLog.RuntimeLog;
  const columns = sql`id, company_id AS "companyId", integration, handle, description, mode, status,
    display, credential_revision AS "credentialRevision", metadata_revision AS "metadataRevision",
    to_char(last_tested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastTestedAt",
    to_char(last_discovered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastDiscoveredAt",
    created_by AS "createdBy"`;
  const safe = (operation: ConnectionStorageFailed["operation"]) => ({
    SqlError: (cause: SqlError) =>
      Effect.fail(new ConnectionStorageFailed({ operation, cause: Redacted.make(cause) })),
    SchemaError: (cause: Schema.SchemaError) =>
      Effect.fail(new ConnectionStorageFailed({ operation, cause: Redacted.make(cause) }))
  });
  const connectionRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Connection,
    execute: (companyId) =>
      sql`SELECT ${columns} FROM connections WHERE company_id = ${companyId} ORDER BY handle, id`
  });
  const connectionRow = SqlSchema.findOneOption({
    Request: Lookup,
    Result: Connection,
    execute: ({ companyId, id, locked }) => sql`SELECT ${columns} FROM connections
      WHERE company_id = ${companyId} AND id = ${id} ${locked ? sql`FOR UPDATE` : sql``}`
  });
  const storedRow = SqlSchema.findOneOption({
    Request: Lookup,
    Result: StoredConnection,
    execute: ({
      companyId,
      id,
      locked
    }) => sql`SELECT ${columns}, credentials, key_id AS "keyId" FROM connections
      WHERE company_id = ${companyId} AND id = ${id} ${locked ? sql`FOR UPDATE` : sql``}`
  });
  const snapshotRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, id: Schema.String, revision: Schema.Int }),
    Result: Schema.Struct({ snapshot: Snapshot }),
    execute: ({ companyId, id, revision }) => sql`SELECT snapshot FROM connection_snapshots
      WHERE company_id = ${companyId} AND connection_id = ${id} AND revision = ${revision}`
  });
  const get = Effect.fn("ConnectionStore.get")(
    function* (companyId: string, id: string) {
      const found = yield* connectionRow({ companyId, id, locked: false });
      if (Option.isNone(found)) return yield* new ConnectionNotFound({ companyId, id });
      return found.value;
    },
    Effect.catchTags(safe("get"))
  );
  const stored = Effect.fn("ConnectionStore.stored")(function* (input: Identity) {
    const found = yield* storedRow({ ...input, locked: false });
    if (Option.isNone(found))
      return yield* new ConnectionNotFound({ companyId: input.companyId, id: input.id });
    return found.value;
  });
  const lock = Effect.fn("ConnectionStore.lock")(function* (
    input: Identity,
    expected?: StoredConnection
  ) {
    const found = yield* connectionRow({ ...input, locked: true });
    if (Option.isNone(found))
      return yield* new ConnectionNotFound({ companyId: input.companyId, id: input.id });
    if (
      expected !== undefined &&
      (found.value.credentialRevision !== expected.credentialRevision ||
        found.value.metadataRevision !== expected.metadataRevision)
    )
      return yield* new ConnectionChanged({});
    return found.value;
  });
  const inspect = Effect.fn("ConnectionStore.inspect")(function* (
    input: Identity,
    credentials: Redacted.Redacted<string>
  ) {
    const correlationId = newInternalId("cor");
    const start = yield* Clock.currentTimeMillis;
    yield* audit.begin({
      companyId: input.companyId,
      userId: input.userId,
      patchId: null,
      versionId: null,
      credentialKind: "admin",
      op: "postgres.discover",
      resource: null,
      connectionId: input.id,
      correlationId,
      deadlineMs: 15_000
    });
    return yield* source.inspect(credentials).pipe(
      Effect.flatMap((result) =>
        decodeSnapshot(result.snapshot).pipe(
          Effect.map((snapshot) => ({ display: result.display, snapshot }))
        )
      ),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const end = yield* Clock.currentTimeMillis;
          yield* audit.finish({
            correlationId,
            outcome: Exit.isSuccess(exit) ? "success" : "failure",
            durationMs: Math.max(0, end - start),
            rowCount: null
          });
        })
      )
    );
  });
  const writeSnapshot = Effect.fn("ConnectionStore.writeSnapshot")(function* (
    input: Identity,
    revision: number,
    snapshot: typeof Snapshot.Type,
    now: number
  ) {
    yield* sql`INSERT INTO connection_snapshots (company_id, connection_id, revision, snapshot, created_at)
      VALUES (${input.companyId}, ${input.id}, ${revision}, ${encodeSnapshot(snapshot)}, to_timestamp(${now / 1_000}))`;
  });

  const list = Effect.fn("ConnectionStore.list")(
    (companyId: string) => connectionRows(companyId),
    Effect.catchTags(safe("list"))
  );
  const snapshot = Effect.fn("ConnectionStore.snapshot")(
    function* (companyId: string, id: string, revision: number) {
      const found = yield* snapshotRow({ companyId, id, revision });
      if (Option.isNone(found)) return yield* new ConnectionNotFound({ companyId, id, revision });
      return found.value.snapshot;
    },
    Effect.catchTags(safe("snapshot"))
  );
  const connect = Effect.fn("ConnectionStore.connect")(
    function* (input: ConnectInput) {
      if (!Companies.isHandle(input.handle)) return yield* new InvalidConnectionHandle({});
      if (!isDescription(input.description)) return yield* new InvalidConnectionDescription({});
      const identity = { ...input, id: newInternalId("conn"), integration: "postgres" as const };
      const inspected = yield* inspect(identity, input.credentials);
      const encrypted = yield* keys.encrypt(identity, input.credentials);
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql`INSERT INTO connections
        (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
         credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
        VALUES (${identity.id}, ${input.companyId}, 'postgres', ${input.handle}, ${input.description}, 'company',
          'connected', ${encodeDisplay(inspected.display)}, ${encrypted.credentials}, ${encrypted.keyId},
          1, 1, ${input.userId}, to_timestamp(${now / 1_000}), to_timestamp(${now / 1_000}))
        ON CONFLICT (company_id, handle) DO NOTHING RETURNING id`;
          if (inserted.length === 0) return yield* new ConnectionHandleTaken({});
          yield* writeSnapshot(identity, 1, inspected.snapshot, now);
          return yield* get(input.companyId, identity.id);
        })
      );
    },
    Effect.catchTags(safe("connect"))
  );
  const test = Effect.fn("ConnectionStore.test")(
    function* (input: Identity) {
      const current = yield* stored(input);
      yield* source.test(yield* keys.decrypt(current, current));
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          yield* sql`UPDATE connections SET last_tested_at = to_timestamp(${now / 1_000}) WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    },
    Effect.catchTags(safe("test"))
  );
  const rotate = Effect.fn("ConnectionStore.rotate")(
    function* (input: CredentialsInput) {
      const current = yield* stored(input);
      const display = yield* source.test(input.credentials);
      if (
        display.host !== current.display.host ||
        display.port !== current.display.port ||
        display.database !== current.display.database
      ) {
        return yield* new ConnectionRetargetRequired({});
      }
      const encrypted = yield* keys.encrypt(current, input.credentials);
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          yield* sql`UPDATE connections SET display = ${encodeDisplay(display)}, credentials = ${encrypted.credentials},
        key_id = ${encrypted.keyId}, credential_revision = credential_revision + 1,
        last_tested_at = to_timestamp(${now / 1_000}) WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    },
    Effect.catchTags(safe("rotate"))
  );
  const discover = Effect.fn("ConnectionStore.discover")(function* (
    input: Identity,
    credentials?: Redacted.Redacted<string>
  ) {
    const current = yield* stored(input);
    if (credentials === undefined && current.status !== "connected")
      return yield* new ConnectionNotConnected({});
    const secret = credentials ?? (yield* keys.decrypt(current, current));
    const inspected = yield* inspect(input, secret);
    const encrypted = credentials === undefined ? undefined : yield* keys.encrypt(current, secret);
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(input, current);
        const revision = current.metadataRevision + 1;
        yield* writeSnapshot(input, revision, inspected.snapshot, now);
        yield* sql`UPDATE connections SET metadata_revision = ${revision},
        display = ${encodeDisplay(inspected.display)}, last_tested_at = to_timestamp(${now / 1_000}),
        last_discovered_at = to_timestamp(${now / 1_000})
        ${encrypted === undefined ? sql`` : sql`, credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId}, credential_revision = credential_revision + 1`}
        WHERE id = ${input.id} AND company_id = ${input.companyId}`;
        return yield* get(input.companyId, input.id);
      })
    );
  });
  const refresh = Effect.fn("ConnectionStore.refresh")(
    (input: Identity) => discover(input),
    Effect.catchTags(safe("refresh"))
  );
  const retarget = Effect.fn("ConnectionStore.retarget")(
    (input: CredentialsInput) => discover(input, input.credentials),
    Effect.catchTags(safe("retarget"))
  );
  const disconnect = Effect.fn("ConnectionStore.disconnect")(
    (input: Identity) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* lock(input);
          if (current.status === "disconnected") return current;
          yield* sql`UPDATE connections SET status = 'disconnected', credential_revision = credential_revision + 1
      WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      ),
    Effect.catchTags(safe("disconnect"))
  );
  const reconnect = Effect.fn("ConnectionStore.reconnect")(
    function* (input: Identity) {
      const current = yield* stored(input);
      if (current.status === "connected") return yield* get(input.companyId, input.id);
      yield* source.test(yield* keys.decrypt(current, current));
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          yield* sql`UPDATE connections SET status = 'connected', credential_revision = credential_revision + 1,
        last_tested_at = to_timestamp(${now / 1_000}) WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    },
    Effect.catchTags(safe("reconnect"))
  );
  const describe = Effect.fn("ConnectionStore.describe")(
    function* (input: Identity & { readonly description: string }) {
      if (!isDescription(input.description)) return yield* new InvalidConnectionDescription({});
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input);
          yield* sql`UPDATE connections SET description = ${input.description} WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    },
    Effect.catchTags(safe("describe"))
  );
  const remove = Effect.fn("ConnectionStore.delete")(
    (input: Identity) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input);
          const references =
            yield* sql`SELECT 1 FROM patch_versions v JOIN patches p ON p.id = v.patch_id
      WHERE p.company_id = ${input.companyId} AND EXISTS (
        SELECT 1 FROM jsonb_each(v.manifest->'uses') AS declaration
        WHERE declaration.value->>'kind' = 'postgres' AND declaration.value->>'id' = ${input.id}
      ) LIMIT 1`;
          if (references.length !== 0) return yield* new ConnectionInUse({});
          yield* sql`DELETE FROM connections WHERE id = ${input.id} AND company_id = ${input.companyId}`;
        })
      ),
    Effect.catchTags(safe("delete"))
  );
  const resolve = Effect.fn("ConnectionStore.resolve")(
    function* (companyId: string, declaration: typeof PostgresDeclaration.Type) {
      const found = yield* connectionRow({ companyId, id: declaration.id, locked: true });
      if (
        Option.isNone(found) ||
        found.value.handle !== declaration.handle ||
        found.value.status !== "connected"
      ) {
        return yield* new ConnectionNotConnected({});
      }
      if (found.value.metadataRevision !== declaration.revision)
        return yield* new StaleGenerated({});
      return {
        kind: "postgres" as const,
        handle: found.value.handle,
        id: found.value.id,
        revision: found.value.metadataRevision
      };
    },
    Effect.catchTags(safe("resolve"))
  );
  const poolCredentials = Effect.fn("ConnectionStore.poolCredentials")(
    function* (
      companyId: string,
      declaration: typeof PostgresDeclaration.Type,
      credentialRevision: number
    ) {
      const found = yield* storedRow({ companyId, id: declaration.id, locked: false });
      if (
        Option.isNone(found) ||
        found.value.handle !== declaration.handle ||
        found.value.status !== "connected"
      )
        return yield* new ConnectionNotConnected({});
      if (found.value.credentialRevision !== credentialRevision)
        return yield* new ConnectionChanged({});
      return yield* keys.decrypt(found.value, found.value);
    },
    Effect.catchTags(safe("poolCredentials"))
  );

  return ConnectionStore.ConnectionStore.of({
    list,
    get,
    snapshot,
    connect,
    test,
    rotate,
    retarget,
    refresh,
    disconnect,
    reconnect,
    describe,
    delete: remove,
    resolve,
    poolCredentials
  });
});

export const layer = Layer.effect(ConnectionStore.ConnectionStore, make);
