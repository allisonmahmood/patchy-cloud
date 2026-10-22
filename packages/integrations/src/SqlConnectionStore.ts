import {
  type ConnectionDeclaration,
  type ConnectionDetail,
  integrations,
  type Integration,
  PostHogSnapshot,
  SalesforceSnapshot
} from "@patchy/api";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Companies from "@patchy/companies/Companies";
import { newInternalId } from "@patchy/core";
import { RuntimeLog } from "@patchy/runtime";
import { registry } from "@patchy/limits/registry";
import { withReportedCommit } from "@patchy/sql";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
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
  Metadata,
  PostgresConnection,
  PostHogConnection,
  SalesforceConnection,
  StaleGenerated,
  type ConnectInput,
  type CredentialsInput,
  type Identity,
  type Target
} from "./ConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import * as PostgresSource from "./postgres/Source.js";
import * as Nango from "./Nango.js";
import * as SalesforceSource from "./salesforce/Source.js";
import * as PostHogSource from "./posthog/Source.js";

const isDescription = Schema.is(Description);
const decodeMetadata = Schema.decodeUnknownEffect(Metadata);
const encodeSalesforceSnapshot = Schema.encodeSync(Schema.fromJsonString(SalesforceSnapshot));
const encodeSalesforceDisplay = Schema.encodeSync(Schema.fromJsonString(SalesforceSource.Display));
const encodePostgresSnapshot = Schema.encodeSync(Schema.fromJsonString(Snapshot));
const encodePostHogSnapshot = Schema.encodeSync(Schema.fromJsonString(PostHogSnapshot));
const encodePostgresDisplay = Schema.encodeSync(Schema.fromJsonString(PostgresSource.Display));
const encodePostHogDisplay = Schema.encodeSync(Schema.fromJsonString(PostHogSource.Display));
const encodeSnapshot = (metadata: Metadata) =>
  metadata.integration === "postgres"
    ? encodePostgresSnapshot(metadata.snapshot)
    : metadata.integration === "salesforce"
      ? encodeSalesforceSnapshot(metadata.snapshot)
      : encodePostHogSnapshot(metadata.snapshot);
const encodeDisplay = (target: Target) =>
  target.integration === "postgres"
    ? encodePostgresDisplay(target.display)
    : target.integration === "salesforce"
      ? encodeSalesforceDisplay(target.display)
      : encodePostHogDisplay(target.display);
/** Credentials for the same destination may replace each other; anything else is a retarget. */
const sameTarget = (current: Target, next: Target) =>
  current.integration === "postgres"
    ? next.integration === "postgres" &&
      next.display.host === current.display.host &&
      next.display.port === current.display.port &&
      next.display.database === current.display.database
    : current.integration === "salesforce"
      ? next.integration === "salesforce" &&
        next.display.organizationId === current.display.organizationId
      : next.integration === "posthog" &&
        next.display.region === current.display.region &&
        next.display.projectId === current.display.projectId;
const secret = { credentials: Schema.String, keyId: Schema.String };
const StoredConnection = Schema.Union([
  Schema.Struct({ ...PostgresConnection.fields, ...secret }),
  Schema.Struct({ ...PostHogConnection.fields, ...secret }),
  Schema.Struct({ ...SalesforceConnection.fields, ...secret })
]);
type StoredConnection = typeof StoredConnection.Type;
const detailFields = {
  handle: Schema.String,
  description: Schema.String,
  status: Schema.Literals(["connected", "disconnected"]),
  revision: Schema.Int,
  takenAt: Schema.NullOr(Schema.String)
};
const SnapshotDetail = Schema.Union([
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("salesforce"),
    snapshot: Schema.NullOr(SalesforceSnapshot)
  }),
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("postgres"),
    snapshot: Schema.NullOr(Snapshot)
  }),
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("posthog"),
    snapshot: Schema.NullOr(PostHogSnapshot)
  })
]);
const Lookup = Schema.Struct({
  companyId: Schema.String,
  id: Schema.String,
  locked: Schema.Boolean
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* CredentialKeys.CredentialKeys;
  const postgres = yield* PostgresSource.Source;
  const posthog = yield* PostHogSource.Source;
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
  // Rows of integrations a later release added are not this release's to read: a rollback
  // hides them, and a lookup by id answers not found instead of failing to decode.
  const known = sql`integration IN ${sql.in(integrations)}`;
  const connectionRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Connection,
    execute: (companyId) => sql`SELECT ${columns} FROM connections
      WHERE company_id = ${companyId} AND ${known} ORDER BY handle, id`
  });
  const connectionRow = SqlSchema.findOneOption({
    Request: Lookup,
    Result: Connection,
    execute: ({ companyId, id, locked }) => sql`SELECT ${columns} FROM connections
      WHERE company_id = ${companyId} AND id = ${id} AND ${known}
      ${locked ? sql`FOR UPDATE` : sql``}`
  });
  const storedRow = SqlSchema.findOneOption({
    Request: Lookup,
    Result: StoredConnection,
    execute: ({
      companyId,
      id,
      locked
    }) => sql`SELECT ${columns}, credentials, key_id AS "keyId" FROM connections
      WHERE company_id = ${companyId} AND id = ${id} AND ${known}
      ${locked ? sql`FOR UPDATE` : sql``}`
  });
  // The snapshot row names its own integration: it outlives its connection.
  const snapshotRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, id: Schema.String, revision: Schema.Int }),
    Result: Metadata,
    execute: ({ companyId, id, revision }) => sql`SELECT integration, snapshot
      FROM connection_snapshots
      WHERE company_id = ${companyId} AND connection_id = ${id} AND revision = ${revision}
        AND ${known}`
  });
  const detailRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      integration: Schema.Literals(integrations),
      handle: Schema.String
    }),
    Result: SnapshotDetail,
    execute: ({ companyId, integration, handle }) => sql`SELECT c.integration, c.handle,
      c.description, c.status,
      c.metadata_revision AS revision, s.snapshot,
      to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "takenAt"
      FROM connections c LEFT JOIN connection_snapshots s
        ON s.connection_id = c.id AND s.company_id = c.company_id AND s.revision = c.metadata_revision
          AND s.integration = c.integration
      WHERE c.company_id = ${companyId} AND c.integration = ${integration} AND c.handle = ${handle}`
  });
  /**
   * Every declaration of a connection in a stored version of one company's patches: the
   * deletion rule, so `usage` and `delete` cannot disagree about what is unused.
   */
  const declarations = (companyId: string) => sql`patch_versions v
    JOIN patches p ON p.id = v.patch_id
    CROSS JOIN LATERAL jsonb_each(v.manifest->'uses') AS declaration
    WHERE p.company_id = ${companyId} AND declaration.value->>'kind' IN ${sql.in(integrations)}`;
  // A patch is in one state: deleted, then disabled, then retired, else live.
  const live = sql`p.deleted_at IS NULL AND p.disabled_at IS NULL AND p.retired_at IS NULL`;
  const usageRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      connectionId: Schema.String,
      usedBy: Schema.Array(Schema.String),
      olderVersions: Schema.Int,
      retired: Schema.Int,
      deleted: Schema.Int,
      disabled: Schema.Int
    }),
    execute: (companyId) => sql`SELECT declaration.value->>'id' AS "connectionId",
      COALESCE(array_agg(DISTINCT p.name ORDER BY p.name)
        FILTER (WHERE ${live} AND v.id = p.current_version_id), '{}') AS "usedBy",
      (count(DISTINCT v.id)
        FILTER (WHERE ${live} AND v.id IS DISTINCT FROM p.current_version_id))::int AS "olderVersions",
      (count(DISTINCT p.id) FILTER (WHERE p.deleted_at IS NULL AND p.disabled_at IS NULL
        AND p.retired_at IS NOT NULL))::int AS retired,
      (count(DISTINCT p.id) FILTER (WHERE p.deleted_at IS NOT NULL))::int AS deleted,
      (count(DISTINCT p.id) FILTER (WHERE p.deleted_at IS NULL
        AND p.disabled_at IS NOT NULL))::int AS disabled
      FROM ${declarations(companyId)}
      GROUP BY 1`
  });
  const versionRows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, ids: Schema.Array(Schema.String) }),
    Result: Schema.Struct({ id: Schema.String, patch: Schema.String, number: Schema.Int }),
    execute: ({ companyId, ids }) => sql`SELECT v.id, p.name AS patch, v.version_number AS number
      FROM patch_versions v JOIN patches p ON p.id = v.patch_id
      WHERE p.company_id = ${companyId} AND ${sql.in("v.id", ids)}`
  });
  const usage = Effect.fn("ConnectionStore.usage")(
    function* (companyId: string) {
      const rows = yield* usageRows(companyId);
      return new Map(
        rows.map(
          ({ connectionId, ...usage }) => [connectionId, { ...usage, declared: true }] as const
        )
      );
    },
    Effect.catchTags(safe("usage"))
  );
  const versions = Effect.fn("ConnectionStore.versions")(
    function* (companyId: string, ids: ReadonlyArray<string>) {
      const rows = ids.length === 0 ? [] : yield* versionRows({ companyId, ids });
      return new Map(rows.map((row) => [row.id, { patch: row.patch, number: row.number }]));
    },
    Effect.catchTags(safe("versions"))
  );
  // The current revision's immutable row supplies both metadata and its timestamp.
  const detail = Effect.fn("ConnectionStore.detail")(
    function* (companyId: string, integration: Integration, handle: string) {
      const found = yield* detailRow({ companyId, integration, handle });
      if (Option.isNone(found))
        return yield* new ConnectionNotFound({ companyId, lookup: { integration, handle } });
      const { revision, takenAt, ...row } = found.value;
      const stamp = takenAt === null ? null : { revision, takenAt };
      return row.integration === "postgres"
        ? {
            ...row,
            snapshot: row.snapshot === null || stamp === null ? null : { ...row.snapshot, ...stamp }
          }
        : row.integration === "salesforce"
          ? {
              ...row,
              snapshot:
                row.snapshot === null || stamp === null ? null : { ...row.snapshot, ...stamp }
            }
          : ({
              ...row,
              snapshot:
                row.snapshot === null || stamp === null ? null : { ...row.snapshot, ...stamp }
            } satisfies ConnectionDetail);
    },
    Effect.catchTags(safe("detail"))
  );
  const get = Effect.fn("ConnectionStore.get")(
    function* (companyId: string, id: string) {
      const found = yield* connectionRow({ companyId, id, locked: false });
      if (Option.isNone(found)) return yield* new ConnectionNotFound({ companyId, lookup: { id } });
      return found.value;
    },
    Effect.catchTags(safe("get"))
  );
  const stored = Effect.fn("ConnectionStore.stored")(function* (input: Identity) {
    const found = yield* storedRow({ ...input, locked: false });
    if (Option.isNone(found))
      return yield* new ConnectionNotFound({
        companyId: input.companyId,
        lookup: { id: input.id }
      });
    return found.value;
  });
  const lock = Effect.fn("ConnectionStore.lock")(function* (
    input: Identity,
    expected?: StoredConnection
  ) {
    const found = yield* connectionRow({ ...input, locked: true });
    if (Option.isNone(found))
      return yield* new ConnectionNotFound({
        companyId: input.companyId,
        lookup: { id: input.id }
      });
    if (
      expected !== undefined &&
      (found.value.credentialRevision !== expected.credentialRevision ||
        found.value.metadataRevision !== expected.metadataRevision)
    )
      return yield* new ConnectionChanged({});
    return found.value;
  });
  /** The integration's own check of credentials, before anything is saved. */
  const testTarget = Effect.fn("ConnectionStore.testTarget")(function* (
    integration: Integration,
    credentials: Redacted.Redacted<string>
  ) {
    const target: Target =
      integration === "postgres"
        ? { integration, display: yield* postgres.test(credentials) }
        : integration === "salesforce"
          ? { integration, display: yield* SalesforceSource.test(credentials) }
          : { integration, display: yield* posthog.test(credentials) };
    return target;
  });
  /** Tests and discovers; the snapshot is decoded again before it is stored. */
  const discoverTarget = Effect.fn("ConnectionStore.discoverTarget")(function* (
    integration: Integration,
    credentials: Redacted.Redacted<string>
  ) {
    if (integration === "postgres") {
      const { display, snapshot } = yield* postgres.inspect(credentials);
      return {
        target: { integration, display } satisfies Target as Target,
        metadata: { integration, snapshot } satisfies Metadata as Metadata
      };
    }
    if (integration === "salesforce") {
      const { display, snapshot } = yield* SalesforceSource.inspect(credentials);
      return {
        target: { integration, display } satisfies Target as Target,
        metadata: { integration, snapshot } satisfies Metadata as Metadata
      };
    }
    const { display, snapshot } = yield* posthog.inspect(credentials);
    return {
      target: { integration, display } satisfies Target as Target,
      metadata: { integration, snapshot } satisfies Metadata as Metadata
    };
  });
  const inspect = Effect.fn("ConnectionStore.inspect")(function* (
    input: Identity & { readonly integration: Integration },
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
      op: `${input.integration}.discover`,
      resource: null,
      connectionId: input.id,
      correlationId,
      deadlineMs: registry["integration.deadline"].default
    });
    return yield* discoverTarget(input.integration, credentials).pipe(
      Effect.flatMap((result) =>
        decodeMetadata(result.metadata).pipe(
          Effect.map((metadata) => ({ target: result.target, metadata }))
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
  // A snapshot names its integration itself: it outlives its connection, and decodes by it.
  const writeSnapshot = Effect.fn("ConnectionStore.writeSnapshot")(function* (
    input: Identity,
    revision: number,
    metadata: Metadata,
    now: number
  ) {
    yield* sql`INSERT INTO connection_snapshots
      (company_id, connection_id, integration, revision, snapshot, created_at)
      VALUES (${input.companyId}, ${input.id}, ${metadata.integration}, ${revision},
        ${encodeSnapshot(metadata)}, to_timestamp(${now / 1_000}))`;
  });

  const list = Effect.fn("ConnectionStore.list")(
    (companyId: string) => connectionRows(companyId),
    Effect.catchTags(safe("list"))
  );
  const snapshot = Effect.fn("ConnectionStore.snapshot")(
    function* (companyId: string, id: string, revision: number) {
      const found = yield* snapshotRow({ companyId, id, revision });
      if (Option.isNone(found))
        return yield* new ConnectionNotFound({ companyId, lookup: { id, revision } });
      return found.value;
    },
    Effect.catchTags(safe("snapshot"))
  );
  /** The outermost transaction of a change whose caller reports it with the commit. */
  const reportedTransaction = <A, E>(
    change: Effect.Effect<A, E>,
    report: (value: A) => Effect.Effect<void> = () => Effect.void
  ) => withReportedCommit(change, report).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const connect = Effect.fn("ConnectionStore.connect")(
    function* (input: ConnectInput, report?: (connection: Connection) => Effect.Effect<void>) {
      if (!Companies.isHandle(input.handle)) return yield* new InvalidConnectionHandle({});
      if (!isDescription(input.description)) return yield* new InvalidConnectionDescription({});
      const identity = { ...input, id: newInternalId("conn") };
      const inspected = yield* inspect(identity, input.credentials);
      const encrypted = yield* keys.encrypt(identity, input.credentials);
      const now = yield* Clock.currentTimeMillis;
      return yield* reportedTransaction(
        Effect.gen(function* () {
          // A targetless conflict resolves on whichever handle key the schema has, so the
          // release before handles became unique per integration also worked.
          const inserted = yield* sql`INSERT INTO connections
        (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
         credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
        VALUES (${identity.id}, ${input.companyId}, ${identity.integration}, ${input.handle},
          ${input.description}, 'company', 'connected', ${encodeDisplay(inspected.target)},
          ${encrypted.credentials}, ${encrypted.keyId}, 1, 1, ${input.userId},
          to_timestamp(${now / 1_000}), to_timestamp(${now / 1_000}))
        ON CONFLICT DO NOTHING RETURNING id`;
          if (inserted.length === 0) return yield* new ConnectionHandleTaken({});
          yield* writeSnapshot(identity, 1, inspected.metadata, now);
          return yield* get(input.companyId, identity.id);
        }),
        report
      );
    },
    Effect.catchTags(safe("connect"))
  );
  const test = Effect.fn("ConnectionStore.test")(
    function* (input: Identity) {
      const current = yield* stored(input);
      yield* testTarget(current.integration, yield* keys.decrypt(current, current));
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
      const target = yield* testTarget(current.integration, input.credentials);
      if (!sameTarget(current, target)) return yield* new ConnectionRetargetRequired({});
      const encrypted = yield* keys.encrypt(current, input.credentials);
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          yield* sql`UPDATE connections SET display = ${encodeDisplay(target)}, credentials = ${encrypted.credentials},
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
    const inspected = yield* inspect({ ...input, integration: current.integration }, secret);
    const encrypted = credentials === undefined ? undefined : yield* keys.encrypt(current, secret);
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lock(input, current);
        const revision = current.metadataRevision + 1;
        yield* writeSnapshot(input, revision, inspected.metadata, now);
        yield* sql`UPDATE connections SET metadata_revision = ${revision},
        display = ${encodeDisplay(inspected.target)}, last_tested_at = to_timestamp(${now / 1_000}),
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
    function* (input: Identity) {
      const saved = yield* stored(input);
      if (saved.integration !== "salesforce")
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* lock(input);
            if (current.status === "disconnected") return current;
            yield* sql`UPDATE connections SET status = 'disconnected', credential_revision = credential_revision + 1 WHERE id = ${input.id} AND company_id = ${input.companyId}`;
            return yield* get(input.companyId, input.id);
          })
        );
      const mapping =
        saved.integration === "salesforce"
          ? yield* SalesforceSource.parseCredentials(yield* keys.decrypt(saved, saved))
          : undefined;
      const connection = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* lock(input, saved);
          if (current.status === "disconnected") return current;
          yield* sql`UPDATE connections SET status = 'disconnected', credential_revision = credential_revision + 1 WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
      // Fail closed first. A failed deletion can be retried, including when already disconnected.
      if (mapping !== undefined) yield* Nango.remove(mapping);
      return connection;
    },
    Effect.catchTags(safe("disconnect"))
  );
  const reconnect = Effect.fn("ConnectionStore.reconnect")(
    function* (input: Identity) {
      const current = yield* stored(input);
      if (current.status === "connected") return yield* get(input.companyId, input.id);
      yield* testTarget(current.integration, yield* keys.decrypt(current, current));
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
    function* (input: Identity, report?: (connection: Connection) => Effect.Effect<void>) {
      const current = yield* get(input.companyId, input.id);
      if (current.integration === "salesforce") {
        if ((yield* usage(input.companyId)).get(input.id)?.declared)
          return yield* new ConnectionInUse({});
        yield* disconnect(input);
      }
      return yield* reportedTransaction(
        Effect.gen(function* () {
          const connection = yield* lock(input);
          const references = yield* sql`SELECT 1 FROM ${declarations(input.companyId)}
            AND declaration.value->>'id' = ${input.id} LIMIT 1`;
          if (references.length !== 0) return yield* new ConnectionInUse({});
          yield* sql`DELETE FROM connections WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return connection;
        }),
        report
      );
    },
    Effect.catchTags(safe("delete"))
  );
  const resolve = Effect.fn("ConnectionStore.resolve")(
    function* (companyId: string, declaration: ConnectionDeclaration) {
      const found = yield* connectionRow({ companyId, id: declaration.id, locked: true });
      if (
        Option.isNone(found) ||
        found.value.integration !== declaration.kind ||
        found.value.handle !== declaration.handle ||
        found.value.status !== "connected"
      ) {
        return yield* new ConnectionNotConnected({});
      }
      if (found.value.metadataRevision !== declaration.revision)
        return yield* new StaleGenerated({});
      return {
        kind: declaration.kind,
        handle: found.value.handle,
        id: found.value.id,
        revision: found.value.metadataRevision
      };
    },
    Effect.catchTags(safe("resolve"))
  );
  const poolCredentials = Effect.fn("ConnectionStore.poolCredentials")(
    function* (companyId: string, declaration: ConnectionDeclaration, credentialRevision: number) {
      const found = yield* storedRow({ companyId, id: declaration.id, locked: false });
      if (
        Option.isNone(found) ||
        found.value.integration !== declaration.kind ||
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
    usage,
    versions,
    detail,
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
