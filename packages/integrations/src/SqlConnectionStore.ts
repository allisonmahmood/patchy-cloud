import {
  AttioSnapshot,
  type ConnectionDeclaration,
  type ConnectionDetail,
  ImapSnapshot,
  integrations,
  type Integration,
  PidgeonSnapshot,
  PostHogSnapshot
} from "@patchy/api";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Companies from "@patchy/companies/Companies";
import { Cryptography } from "@patchy/core";
import { Teams, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import { registry } from "@patchy/limits/registry";
import { withReportedCommit } from "@patchy/sql";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as ConnectionStore from "./ConnectionStore.js";
import * as PatchVisibility from "./PatchVisibility.js";
import {
  AttioConnection,
  Connection,
  ConnectionChanged,
  ConnectionHandleTaken,
  ConnectInProgress,
  ConnectionInUse,
  ConnectionNotConnected,
  ConnectionNotFound,
  ConnectionRetargetRequired,
  ConnectionRetargetUnavailable,
  ConnectionStorageFailed,
  Description,
  ImapConnection,
  InvalidConnectionDescription,
  InvalidConnectionHandle,
  Metadata,
  PidgeonConnection,
  PostgresConnection,
  PostHogConnection,
  StaleGenerated,
  type ConnectInput,
  type CredentialsInput,
  type Identity,
  type Target
} from "./ConnectionStore.js";
import * as CredentialKeys from "./CredentialKeys.js";
import * as PostgresSource from "./postgres/Source.js";
import * as PostHogSource from "./posthog/Source.js";
import * as PidgeonKeys from "./pidgeon/Keys.js";
import * as PidgeonSource from "./pidgeon/Source.js";
import * as AttioSource from "./attio/Source.js";
import * as ImapSource from "./imap/Source.js";

const isDescription = Schema.is(Description);
const decodeMetadata = Schema.decodeUnknownEffect(Metadata);
const encodePostgresSnapshot = Schema.encodeSync(Schema.fromJsonString(Snapshot));
const encodePostHogSnapshot = Schema.encodeSync(Schema.fromJsonString(PostHogSnapshot));
const encodePidgeonSnapshot = Schema.encodeSync(Schema.fromJsonString(PidgeonSnapshot));
const encodeAttioSnapshot = Schema.encodeSync(Schema.fromJsonString(AttioSnapshot));
const encodeImapSnapshot = Schema.encodeSync(Schema.fromJsonString(ImapSnapshot));
const encodePostgresDisplay = Schema.encodeSync(Schema.fromJsonString(PostgresSource.Display));
const encodePostHogDisplay = Schema.encodeSync(Schema.fromJsonString(PostHogSource.Display));
const encodePidgeonDisplay = Schema.encodeSync(Schema.fromJsonString(PidgeonSource.Display));
const encodeAttioDisplay = Schema.encodeSync(Schema.fromJsonString(AttioSource.Display));
const encodeImapDisplay = Schema.encodeSync(Schema.fromJsonString(ImapSource.Display));
const encodeSnapshot = (metadata: Metadata) => {
  switch (metadata.integration) {
    case "postgres":
      return encodePostgresSnapshot(metadata.snapshot);
    case "posthog":
      return encodePostHogSnapshot(metadata.snapshot);
    case "pidgeon":
      return encodePidgeonSnapshot(metadata.snapshot);
    case "attio":
      return encodeAttioSnapshot(metadata.snapshot);
    case "imap":
      return encodeImapSnapshot(metadata.snapshot);
  }
};
const encodeDisplay = (target: Target) => {
  switch (target.integration) {
    case "postgres":
      return encodePostgresDisplay(target.display);
    case "posthog":
      return encodePostHogDisplay(target.display);
    case "pidgeon":
      return encodePidgeonDisplay(target.display);
    case "attio":
      return encodeAttioDisplay(target.display);
    case "imap":
      return encodeImapDisplay(target.display);
  }
};
/** One mailbox login: the same host, port, security and username. */
const sameLogin = (
  current: Pick<ImapSource.Display, "host" | "port" | "security" | "username">,
  next: Pick<ImapSource.Display, "host" | "port" | "security" | "username">
) =>
  next.host === current.host &&
  next.port === current.port &&
  next.security === current.security &&
  next.username === current.username;
/**
 * Where an IMAP connection logs in after a login that worked, `logins` of them so far, with no
 * pause: what each saved success leaves.
 */
const working = (
  login: Pick<ImapSource.Display, "host" | "port" | "security" | "username">,
  logins: number
) => ({
  integration: "imap" as const,
  display: {
    host: login.host,
    port: login.port,
    security: login.security,
    username: login.username,
    logins
  } satisfies ImapSource.Display
});
/** The logins a connection has saved as working; absent is none. */
const loginsOf = (connection: Connection) =>
  connection.integration === "imap" ? (connection.display.logins ?? 0) : 0;
/** Credentials for the same destination may replace each other; anything else is a retarget. */
const sameTarget = (current: Target, next: Target) =>
  current.integration === "postgres"
    ? next.integration === "postgres" &&
      next.display.host === current.display.host &&
      next.display.port === current.display.port &&
      next.display.database === current.display.database
    : current.integration === "posthog"
      ? next.integration === "posthog" &&
        next.display.region === current.display.region &&
        next.display.projectId === current.display.projectId
      : current.integration === "pidgeon"
        ? next.integration === "pidgeon" && next.display.identityId === current.display.identityId
        : current.integration === "imap"
          ? next.integration === "imap" && sameLogin(current.display, next.display)
          : next.integration === "attio" &&
            next.display.workspace.id === current.display.workspace.id;
const secret = { credentials: Schema.String, keyId: Schema.String };
const StoredConnection = Schema.Union([
  Schema.Struct({ ...PostgresConnection.fields, ...secret }),
  Schema.Struct({ ...PostHogConnection.fields, ...secret }),
  Schema.Struct({ ...PidgeonConnection.fields, ...secret }),
  Schema.Struct({ ...AttioConnection.fields, ...secret }),
  Schema.Struct({ ...ImapConnection.fields, ...secret })
]);
type StoredConnection = typeof StoredConnection.Type;
type StoredPidgeon = Extract<StoredConnection, { readonly integration: "pidgeon" }>;
type StoredAttio = Extract<StoredConnection, { readonly integration: "attio" }>;
type StoredImap = Extract<StoredConnection, { readonly integration: "imap" }>;
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
    integration: Schema.Literal("postgres"),
    snapshot: Schema.NullOr(Snapshot)
  }),
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("posthog"),
    snapshot: Schema.NullOr(PostHogSnapshot)
  }),
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("pidgeon"),
    snapshot: Schema.NullOr(PidgeonSnapshot)
  }),
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("attio"),
    snapshot: Schema.NullOr(AttioSnapshot)
  }),
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("imap"),
    snapshot: Schema.NullOr(ImapSnapshot),
    // What a member is told about a pause: only when it began.
    display: ImapSource.Display
  })
]);
const Lookup = Schema.Struct({
  companyId: Schema.String,
  id: Schema.String,
  locked: Schema.Boolean
});

/**
 * Runs `effect` to its end even when the request that started it is interrupted, so a key Patchy
 * minted in Pidgeon is always saved, revoked or named.
 */
const detached = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.forkDetach(effect), Fiber.join);

/** Every integration this release ships; `knowing` makes a store of an earlier release's. */
export const make = Effect.suspend(() => knowing(integrations));

/**
 * A store that reads only `known` integrations' rows, as the release that shipped them did. Rows of
 * integrations a later release added stay hidden, so a rollback lists and shows the rest.
 */
export const knowing = (known: ReadonlyArray<Integration>) =>
  Effect.gen(function* () {
    const teamService = yield* Teams.Teams;
    const cryptography = yield* Cryptography.Cryptography;
    const sql = yield* SqlClient.SqlClient;
    const keys = yield* CredentialKeys.CredentialKeys;
    const postgres = yield* PostgresSource.Source;
    const posthog = yield* PostHogSource.Source;
    const pidgeonSource = yield* PidgeonSource.Source;
    const attio = yield* AttioSource.Source;
    const imap = yield* ImapSource.Source;
    const audit = yield* RuntimeLog.RuntimeLog;
    const columns = sql`id, company_id AS "companyId", integration, handle, description, mode, status,
    block_guests AS "blockGuests", display, credential_revision AS "credentialRevision", metadata_revision AS "metadataRevision",
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
    const isKnown = sql`integration IN ${sql.in(known)}`;
    const connectionRows = SqlSchema.findAll({
      Request: Schema.String,
      Result: Connection,
      execute: (companyId) => sql`SELECT ${columns} FROM connections
      WHERE company_id = ${companyId} AND ${isKnown} ORDER BY handle, id`
    });
    const connectionRow = SqlSchema.findOneOption({
      Request: Lookup,
      Result: Connection,
      execute: ({ companyId, id, locked }) => sql`SELECT ${columns} FROM connections
      WHERE company_id = ${companyId} AND id = ${id} AND ${isKnown}
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
      WHERE company_id = ${companyId} AND id = ${id} AND ${isKnown}
      ${locked ? sql`FOR UPDATE` : sql``}`
    });
    // The snapshot row names its own integration: it outlives its connection.
    const snapshotRow = SqlSchema.findOneOption({
      Request: Schema.Struct({ companyId: Schema.String, id: Schema.String, revision: Schema.Int }),
      Result: Metadata,
      execute: ({ companyId, id, revision }) => sql`SELECT integration, snapshot
      FROM connection_snapshots
      WHERE company_id = ${companyId} AND connection_id = ${id} AND revision = ${revision}
        AND ${isKnown}`
    });
    const detailRow = SqlSchema.findOneOption({
      Request: Schema.Struct({
        companyId: Schema.String,
        integration: Schema.Literals(integrations),
        handle: Schema.String
      }),
      Result: SnapshotDetail,
      execute: ({ companyId, integration, handle }) => sql`SELECT c.integration, c.handle,
      c.description, c.status, c.display,
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
    WHERE p.company_id = ${companyId} AND declaration.value->>'kind' IN ${sql.in(known)}`;
    // A patch is in one state: deleted, then disabled, then retired, else live.
    const live = sql`p.deleted_at IS NULL AND p.disabled_at IS NULL AND p.retired_at IS NULL`;
    const usageRows = SqlSchema.findAll({
      Request: Schema.Struct({
        companyId: Schema.String,
        patchIds: Schema.optionalKey(Schema.Array(Schema.String))
      }),
      Result: Schema.Struct({
        connectionId: Schema.String,
        usedBy: Schema.Array(Schema.String),
        olderVersions: Schema.Int,
        retired: Schema.Int,
        deleted: Schema.Int,
        disabled: Schema.Int,
        declaredBy: Schema.Array(Schema.String)
      }),
      execute: ({ companyId, patchIds }) => sql`SELECT declaration.value->>'id' AS "connectionId",
      COALESCE(array_agg(DISTINCT p.name ORDER BY p.name)
        FILTER (WHERE ${live} AND v.id = p.current_version_id), '{}') AS "usedBy",
      COALESCE(array_agg(DISTINCT p.name ORDER BY p.name)
        FILTER (WHERE NOT COALESCE(${live} AND v.id = p.current_version_id, false)), '{}') AS "declaredBy",
      (count(DISTINCT v.id)
        FILTER (WHERE ${live} AND v.id IS DISTINCT FROM p.current_version_id))::int AS "olderVersions",
      (count(DISTINCT p.id) FILTER (WHERE p.deleted_at IS NULL AND p.disabled_at IS NULL
        AND p.retired_at IS NOT NULL))::int AS retired,
      (count(DISTINCT p.id) FILTER (WHERE p.deleted_at IS NOT NULL))::int AS deleted,
      (count(DISTINCT p.id) FILTER (WHERE p.deleted_at IS NULL
        AND p.disabled_at IS NOT NULL))::int AS disabled
      FROM ${declarations(companyId)}
      ${patchIds === undefined ? sql`` : sql`AND ${sql.in("p.id", patchIds)}`}
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
      function* (companyId: string, userId?: string) {
        const patchIds =
          userId === undefined
            ? undefined
            : yield* (yield* PatchVisibility.PatchVisibility).openableIds(companyId, userId);
        const rows = yield* usageRows({
          companyId,
          ...(patchIds === undefined ? {} : { patchIds })
        });
        // A live patch that also kept older declaring versions is named once, as a user.
        return new Map(
          rows.map(
            ({ connectionId, declaredBy, ...usage }) =>
              [
                connectionId,
                {
                  ...usage,
                  declaredBy: declaredBy.filter((name) => !usage.usedBy.includes(name)),
                  declared: true
                }
              ] as const
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
      function* (companyId: string, integration: Integration, handle: string, userId?: string) {
        if (
          userId !== undefined &&
          !(yield* accessible(
            companyId,
            yield* accessRows({ companyId, integration, handle }),
            userId
          )).size
        )
          return yield* new ConnectionNotFound({ companyId, lookup: { integration, handle } });
        const found = yield* detailRow({ companyId, integration, handle });
        if (Option.isNone(found))
          return yield* new ConnectionNotFound({ companyId, lookup: { integration, handle } });
        const { revision, takenAt, ...row } = found.value;
        const stamp = takenAt === null ? null : { revision, takenAt };
        if (row.integration === "postgres")
          return {
            ...row,
            snapshot: row.snapshot === null || stamp === null ? null : { ...row.snapshot, ...stamp }
          } satisfies ConnectionDetail;
        if (row.integration === "posthog")
          return {
            ...row,
            snapshot: row.snapshot === null || stamp === null ? null : { ...row.snapshot, ...stamp }
          } satisfies ConnectionDetail;
        if (row.integration === "attio")
          return {
            ...row,
            snapshot: row.snapshot === null || stamp === null ? null : { ...row.snapshot, ...stamp }
          } satisfies ConnectionDetail;
        if (row.integration === "imap") {
          const { display, ...imap } = row;
          return {
            ...imap,
            snapshot:
              imap.snapshot === null || stamp === null ? null : { ...imap.snapshot, ...stamp },
            ...(display.paused === undefined ? {} : { paused: { at: display.paused.at } })
          } satisfies ConnectionDetail;
        }
        return {
          ...row,
          snapshot: row.snapshot === null || stamp === null ? null : { ...row.snapshot, ...stamp }
        } satisfies ConnectionDetail;
      },
      Effect.catchTags(safe("detail"))
    );
    const get = Effect.fn("ConnectionStore.get")(
      function* (companyId: string, id: string) {
        const found = yield* connectionRow({ companyId, id, locked: false });
        if (Option.isNone(found))
          return yield* new ConnectionNotFound({ companyId, lookup: { id } });
        return found.value;
      },
      Effect.catchTags(safe("get"))
    );
    const stored = Effect.fn("ConnectionStore.stored")(function* (input: Identity, locked = false) {
      const found = yield* storedRow({ ...input, locked });
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
      integration: "postgres" | "posthog",
      credentials: Redacted.Redacted<string>
    ) {
      const target: Target =
        integration === "postgres"
          ? { integration, display: yield* postgres.test(credentials) }
          : { integration, display: yield* posthog.test(credentials) };
      return target;
    });
    /** Tests and discovers; the snapshot is decoded again before it is stored. */
    const discoverTarget = Effect.fn("ConnectionStore.discoverTarget")(function* (
      integration: "postgres" | "posthog",
      credentials: Redacted.Redacted<string>
    ) {
      if (integration === "postgres") {
        const { display, snapshot } = yield* postgres.inspect(credentials);
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
    /** Records an admin's call to an outside source in recent calls, however it ends. */
    const audited = <A, E, R>(
      input: Identity & { readonly integration: Integration },
      op: string,
      effect: Effect.Effect<A, E, R>
    ) =>
      Effect.gen(function* () {
        const correlationId = yield* cryptography.internalId("cor");
        const start = yield* Clock.currentTimeMillis;
        yield* audit.begin({
          companyId: input.companyId,
          userId: input.userId,
          patchId: null,
          versionId: null,
          credentialKind: "admin",
          op,
          resource: null,
          connectionId: input.id,
          correlationId,
          deadlineMs:
            input.integration === "pidgeon"
              ? registry["pidgeon.connect.deadline"].default
              : input.integration === "attio"
                ? registry["attio.discovery.deadline"].default
                : input.integration === "imap"
                  ? registry["imap.test.deadline"].default
                  : registry["integration.deadline"].default
        });
        return yield* effect.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const end = yield* Clock.currentTimeMillis;
              yield* audit.finish({
                correlationId,
                outcome: Exit.isSuccess(exit) ? "success" : "failure",
                durationMs: Math.max(0, end - start),
                rowCount: null
              });
            }).pipe(Effect.ignore)
          )
        );
      });
    const inspect = (
      input: Identity & { readonly integration: "postgres" | "posthog" },
      credentials: Redacted.Redacted<string>
    ) =>
      audited(
        input,
        `${input.integration}.discover`,
        discoverTarget(input.integration, credentials).pipe(
          Effect.flatMap((result) =>
            decodeMetadata(result.metadata).pipe(
              Effect.map((metadata) => ({ target: result.target, metadata }))
            )
          )
        )
      );
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
      function* (companyId: string, userId?: string) {
        const rows = yield* connectionRows(companyId);
        if (userId === undefined || rows.length === 0) return rows;
        const admitted = yield* accessible(
          companyId,
          yield* accessRows({ companyId, ids: rows.map((row) => row.id) }),
          userId
        );
        return rows.filter((row) => admitted.has(row.id));
      },
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
    /** A targetless conflict resolves on whichever handle key the schema has. */
    const insert = Effect.fn("ConnectionStore.insert")(function* (
      identity: Identity & { readonly integration: Integration },
      input: ConnectInput,
      target: Target,
      encrypted: CredentialKeys.EncryptedCredentials,
      metadata: Metadata,
      now: number
    ) {
      const inserted = yield* sql`INSERT INTO connections
        (id, company_id, integration, handle, description, mode, status, display, credentials, key_id,
         credential_revision, metadata_revision, created_by, last_tested_at, last_discovered_at)
        VALUES (${identity.id}, ${input.companyId}, ${identity.integration}, ${input.handle},
          ${input.description}, 'company', 'connected', ${encodeDisplay(target)},
          ${encrypted.credentials}, ${encrypted.keyId}, 1, 1, ${input.userId},
          to_timestamp(${now / 1_000}), to_timestamp(${now / 1_000}))
        ON CONFLICT DO NOTHING RETURNING id`;
      if (inserted.length === 0) return yield* new ConnectionHandleTaken({});
      yield* writeSnapshot(identity, 1, metadata, now);
      return yield* get(input.companyId, identity.id);
    });

    // ---------- Pidgeon: keys Patchy mints, keeps and revokes ----------

    /** `display` with these retired keys, leaving them out when there are none. */
    const pidgeonDisplay = (
      display: PidgeonSource.Display,
      retired: PidgeonSource.Display["retired"]
    ): PidgeonSource.Display => ({
      email: display.email,
      identityId: display.identityId,
      sendPolicy: display.sendPolicy,
      access: display.access,
      test: display.test,
      key: display.key,
      ...(retired === undefined || retired.length === 0 ? {} : { retired })
    });
    /** The old keys a connection still has to revoke, with their secrets and names. */
    const retiredOf = (display: PidgeonSource.Display, credentials: PidgeonSource.Credentials) => {
      const named = new Map((display.retired ?? []).map((item) => [item.id, item.name] as const));
      return (credentials.retired ?? []).map((key) => ({ key, name: named.get(key.id) ?? key.id }));
    };
    const pidgeonOf = Effect.fn("ConnectionStore.pidgeonOf")(function* (
      input: Identity,
      locked = false
    ) {
      const current = yield* stored(input, locked);
      if (current.integration !== "pidgeon")
        return yield* new ConnectionNotFound({
          companyId: input.companyId,
          lookup: { id: input.id }
        });
      return current;
    });
    const secretOf = (current: StoredPidgeon) =>
      keys
        .decrypt(current, current)
        .pipe(Effect.flatMap((value) => PidgeonSource.parseCredentials(value)));
    const sealed = (current: Identity, value: PidgeonSource.Credentials) =>
      keys.encrypt(
        { companyId: current.companyId, id: current.id, integration: "pidgeon" },
        PidgeonSource.credentials(value)
      );
    /** Saves the credentials and display of a Pidgeon connection whose lock this transaction holds. */
    const updatePidgeon = Effect.fn("ConnectionStore.updatePidgeon")(function* (
      input: Identity,
      display: PidgeonSource.Display,
      credentials?: { readonly value: PidgeonSource.Credentials; readonly newKey: boolean }
    ) {
      const encrypted =
        credentials === undefined ? undefined : yield* sealed(input, credentials.value);
      yield* sql`UPDATE connections SET
        display = ${encodeDisplay({ integration: "pidgeon", display })}
        ${encrypted === undefined ? sql`` : sql`, credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId}`}
        ${credentials?.newKey === true ? sql`, credential_revision = credential_revision + 1` : sql``}
        WHERE id = ${input.id} AND company_id = ${input.companyId}`;
    });

    /**
     * Tracks a key Pidgeon minted for a save. A failure before the save's last statement revokes it; a
     * failure after, at COMMIT, leaves the save's outcome unknown, so nothing is revoked.
     */
    const minting = (name: string) => {
      let made: PidgeonKeys.Made | undefined;
      let finished = false;
      return {
        /** The key Pidgeon minted for this save. */
        made: (value: PidgeonKeys.Made) =>
          Effect.sync(() => {
            made = value;
          }),
        /** The save's last statement ran; only its COMMIT is left. */
        done: Effect.sync(() => {
          finished = true;
        }),
        settle: <E>(
          error: E
        ): Effect.Effect<
          never,
          E | PidgeonKeys.SaveUnknown | PidgeonKeys.StrayKey,
          PidgeonSource.Source | Cryptography.Cryptography
        > =>
          made === undefined
            ? Effect.fail(error)
            : finished
              ? Effect.fail(new PidgeonKeys.SaveUnknown({ key: made.name, name }))
              : PidgeonKeys.undo(made, error)
      };
    };

    const pidgeonConnect = Effect.fn("ConnectionStore.pidgeonConnect")(function* (
      input: ConnectInput,
      report?: (connection: Connection) => Effect.Effect<void>
    ) {
      const request = yield* PidgeonKeys.parseConnect(input.credentials);
      const identity = {
        ...input,
        integration: "pidgeon" as const,
        id: yield* cryptography.internalId("conn")
      };
      const minted = minting(`pidgeon/${input.handle}`);
      return yield* detached(
        audited(
          identity,
          "pidgeon.connect",
          Effect.gen(function* () {
            const provisioned = yield* PidgeonKeys.provision({
              request,
              handle: input.handle,
              scope: input.companyId
            });
            const { made, identity: address } = provisioned;
            yield* minted.made(made);
            const display: PidgeonSource.Display = {
              email: address.email,
              identityId: address.id,
              sendPolicy: address.sendPolicy,
              access: request.access,
              test: provisioned.test,
              key: { id: made.id, name: made.name, madeAt: made.madeAt }
            };
            const now = yield* Clock.currentTimeMillis;
            const encrypted = yield* sealed(identity, {
              identityId: address.id,
              key: { id: made.id, token: Redacted.value(made.token) }
            });
            return yield* reportedTransaction(
              insert(
                identity,
                input,
                { integration: "pidgeon", display },
                encrypted,
                { integration: "pidgeon", snapshot: provisioned.snapshot },
                now
              ).pipe(Effect.tap(() => minted.done)),
              report
            );
          }).pipe(
            Effect.catch(minted.settle),
            Effect.provideService(PidgeonSource.Source, pidgeonSource),
            Effect.provideService(Cryptography.Cryptography, cryptography)
          )
        )
      );
    });

    // ---------- Attio: a read-only key, checked at every turn ----------

    const attioSecret = (current: StoredAttio) =>
      keys.decrypt(current, current).pipe(Effect.flatMap(AttioSource.parseCredentials));
    /** What a passing check found, with no write scope left to name. */
    const attioDisplay = (self: AttioSource.Self, keyHint: string): AttioSource.Display => ({
      workspace: self.workspace,
      keyHint,
      scopes: self.scopes
    });
    /** The key's workspace must be the connection's: a key never moves a connection. */
    const sameWorkspace = (current: StoredAttio, self: AttioSource.Self) =>
      self.workspace.id === current.display.workspace.id
        ? Effect.void
        : Effect.fail(
            new AttioSource.OtherWorkspace({
              expected: current.display.workspace.name,
              found: self.workspace.name
            })
          );
    /**
     * A check found the stored key can write: disconnect as an admin's Disconnect does, naming the
     * scopes and the admin whose check it was, but only while the key it checked is still the
     * connection's, so a Replace key that landed meanwhile keeps its connection. Patchy never keeps
     * using a key it knows can write.
     */
    const attioWritable = (
      input: Identity,
      checked: StoredAttio,
      during: "test" | "refresh" | "reconnect",
      error: AttioSource.WriteScopes
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const locked = yield* lock(input);
            if (locked.credentialRevision !== checked.credentialRevision) return;
            const display: AttioSource.Display = {
              ...checked.display,
              writable: {
                scopes: error.scopes,
                by: input.userId,
                at: DateTime.formatIso(DateTime.makeUnsafe(now)),
                during
              }
            };
            yield* sql`UPDATE connections SET display = ${encodeDisplay({ integration: "attio", display })}
              ${locked.status === "connected" ? sql`, status = 'disconnected', credential_revision = credential_revision + 1` : sql``}
              WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          })
        );
        return yield* error;
      });
    /**
     * The stored key's check, recorded in recent calls as the admin's. Asking Attio may be
     * interrupted; once the check finds the key can write, the disconnect runs to its end even if
     * the request that asked goes away, so a writable key is never left connected.
     */
    const attioCheck = (input: Identity, current: StoredAttio, during: "test" | "reconnect") =>
      Effect.gen(function* () {
        const { key } = yield* attioSecret(current);
        const self = yield* Effect.uninterruptibleMask((restore) =>
          restore(
            audited(
              { ...input, integration: "attio" },
              "attio.check",
              attio.check(Redacted.make(key))
            )
          ).pipe(
            Effect.catchTags({
              AttioWriteScopes: (error) => attioWritable(input, current, during, error)
            })
          )
        );
        yield* sameWorkspace(current, self);
        return self;
      });

    /**
     * Connects in progress in this process, by integration, company and handle, and when each
     * started: a second submit while the first still talks to the source is refused rather than
     * run beside it.
     */
    const connecting = new Map<string, number>();
    /** Runs `effect` holding the connect's name; it's claimed and released as one bracket. */
    const claimed = <A, E, R>(input: ConnectInput, effect: Effect.Effect<A, E, R>) => {
      const slot = `${input.integration}\n${input.companyId}\n${input.handle}`;
      return Effect.acquireUseRelease(
        Effect.gen(function* () {
          const running = connecting.get(slot);
          if (running !== undefined)
            return yield* new ConnectInProgress({
              name: `${input.integration}/${input.handle}`,
              startedAt: DateTime.formatIso(DateTime.makeUnsafe(running))
            });
          connecting.set(slot, yield* Clock.currentTimeMillis);
        }),
        () => effect,
        () => Effect.sync(() => connecting.delete(slot))
      );
    };
    const attioConnect = Effect.fn("ConnectionStore.attioConnect")(function* (
      input: ConnectInput,
      report?: (connection: Connection) => Effect.Effect<void>
    ) {
      // An interrupted connect never keeps the name.
      return yield* claimed(
        input,
        Effect.gen(function* () {
          const identity = {
            ...input,
            integration: "attio" as const,
            id: yield* cryptography.internalId("conn")
          };
          const { self, snapshot } = yield* audited(
            identity,
            "attio.discover",
            attio.inspect(input.credentials)
          );
          const encrypted = yield* keys.encrypt(
            identity,
            AttioSource.credentials({
              key: Redacted.value(input.credentials),
              workspaceId: self.workspace.id
            })
          );
          const now = yield* Clock.currentTimeMillis;
          return yield* reportedTransaction(
            insert(
              identity,
              input,
              {
                integration: "attio",
                display: attioDisplay(self, AttioSource.keyHint(input.credentials))
              },
              encrypted,
              { integration: "attio", snapshot },
              now
            ),
            report
          );
        })
      );
    });

    /** Test: the check, and what it found about the workspace and the key's scopes. */
    const attioTest = Effect.fn("ConnectionStore.attioTest")(function* (
      input: Identity,
      current: StoredAttio
    ) {
      const self = yield* attioCheck(input, current, "test");
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          const display = { ...current.display, workspace: self.workspace, scopes: self.scopes };
          yield* sql`UPDATE connections SET last_tested_at = to_timestamp(${now / 1_000}),
            display = ${encodeDisplay({ integration: "attio", display })}
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /** Replace key: the new key's check and discovery, saved together or not at all. */
    const attioReplace = Effect.fn("ConnectionStore.attioReplace")(function* (
      input: CredentialsInput,
      current: StoredAttio
    ) {
      const { self, snapshot } = yield* audited(
        { ...input, integration: "attio" },
        "attio.discover",
        attio.inspect(input.credentials)
      );
      yield* sameWorkspace(current, self);
      const encrypted = yield* keys.encrypt(
        current,
        AttioSource.credentials({
          key: Redacted.value(input.credentials),
          workspaceId: self.workspace.id
        })
      );
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          const revision = current.metadataRevision + 1;
          yield* writeSnapshot(input, revision, { integration: "attio", snapshot }, now);
          // A disconnected connection stays disconnected; the new key was checked read-only.
          const display = attioDisplay(self, AttioSource.keyHint(input.credentials));
          yield* sql`UPDATE connections SET metadata_revision = ${revision},
            display = ${encodeDisplay({ integration: "attio", display })},
            credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId},
            credential_revision = credential_revision + 1,
            last_tested_at = to_timestamp(${now / 1_000}),
            last_discovered_at = to_timestamp(${now / 1_000})
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /** Refresh: the stored key's check and a fresh discovery, attributed to the admin. */
    const attioRefresh = Effect.fn("ConnectionStore.attioRefresh")(function* (
      input: Identity,
      current: StoredAttio
    ) {
      if (current.status !== "connected") return yield* new ConnectionNotConnected({});
      const { key } = yield* attioSecret(current);
      // As for the check: once Refresh finds the key can write, the disconnect isn't interrupted.
      const { self, snapshot } = yield* Effect.uninterruptibleMask((restore) =>
        restore(
          audited(
            { ...input, integration: "attio" },
            "attio.discover",
            attio.inspect(Redacted.make(key))
          )
        ).pipe(
          Effect.catchTags({
            AttioWriteScopes: (error) => attioWritable(input, current, "refresh", error)
          })
        )
      );
      yield* sameWorkspace(current, self);
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          const revision = current.metadataRevision + 1;
          yield* writeSnapshot(input, revision, { integration: "attio", snapshot }, now);
          const display = attioDisplay(self, current.display.keyHint);
          yield* sql`UPDATE connections SET metadata_revision = ${revision},
            display = ${encodeDisplay({ integration: "attio", display })},
            last_tested_at = to_timestamp(${now / 1_000}),
            last_discovered_at = to_timestamp(${now / 1_000})
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /** Reconnect runs the check; a key that still writes keeps the connection disconnected. */
    const attioReconnect = Effect.fn("ConnectionStore.attioReconnect")(function* (
      input: Identity,
      current: StoredAttio
    ) {
      const self = yield* attioCheck(input, current, "reconnect");
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          const display = attioDisplay(self, current.display.keyHint);
          yield* sql`UPDATE connections SET status = 'connected', credential_revision = credential_revision + 1,
            display = ${encodeDisplay({ integration: "attio", display })},
            last_tested_at = to_timestamp(${now / 1_000}) WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    // ---------- IMAP: a mailbox login, paused when its server refuses it ----------

    const imapSecret = (current: StoredImap) =>
      keys.decrypt(current, current).pipe(Effect.flatMap(ImapSource.parseCredentials));
    const iso = (now: number) => DateTime.formatIso(DateTime.makeUnsafe(now));
    /**
     * Records a refused login on the connection, so no host process logs in with it again: once,
     * and only while what the attempt started under still stands. A refusal that arrives after
     * other credentials were saved (`credentialRevision`), or after a login with these ones worked
     * and was saved (`logins`), is stale and pauses nothing.
     */
    const imapPause = (
      input: { readonly companyId: string; readonly id: string },
      attempt: { readonly credentialRevision: number; readonly logins: number },
      paused: ImapSource.Paused
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const locked = yield* connectionRow({ ...input, locked: true });
          if (
            Option.isNone(locked) ||
            locked.value.integration !== "imap" ||
            locked.value.credentialRevision !== attempt.credentialRevision ||
            loginsOf(locked.value) !== attempt.logins ||
            locked.value.display.paused !== undefined
          )
            return;
          yield* sql`UPDATE connections SET display = ${encodeDisplay({
            integration: "imap",
            display: { ...locked.value.display, paused }
          })} WHERE id = ${input.id} AND company_id = ${input.companyId}`;
        })
      );
    /**
     * The stored login's Test on a fresh session, recorded in recent calls as the admin's. A login
     * the server refuses pauses the connection, and once the refusal is known the pause is saved
     * even if the request that asked goes away.
     */
    const imapCheck = (
      input: Identity,
      current: StoredImap,
      during: "test" | "refresh" | "reconnect"
    ) =>
      Effect.gen(function* () {
        const login = yield* imapSecret(current);
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(
            audited(
              { ...input, integration: "imap" },
              `imap.${during}`,
              imap.inspect(ImapSource.settings(login))
            )
          ).pipe(
            Effect.catchTags({
              ImapLoginRefused: (error) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  yield* imapPause(
                    input,
                    {
                      credentialRevision: current.credentialRevision,
                      logins: current.display.logins ?? 0
                    },
                    { at: iso(now), reply: error.reply, during, by: input.userId }
                  );
                  return yield* error;
                })
            })
          )
        );
      });

    const imapConnect = Effect.fn("ConnectionStore.imapConnect")(function* (
      input: ConnectInput,
      report?: (connection: Connection) => Effect.Effect<void>
    ) {
      const login = yield* ImapSource.parseCredentials(input.credentials);
      return yield* claimed(
        input,
        Effect.gen(function* () {
          const identity = {
            ...input,
            integration: "imap" as const,
            id: yield* cryptography.internalId("conn")
          };
          const snapshot = yield* audited(
            identity,
            "imap.connect",
            imap.inspect(ImapSource.settings(login))
          );
          const encrypted = yield* keys.encrypt(identity, ImapSource.credentials(login));
          const now = yield* Clock.currentTimeMillis;
          return yield* reportedTransaction(
            insert(
              identity,
              input,
              working(login, 1),
              encrypted,
              { integration: "imap", snapshot },
              now
            ),
            report
          );
        })
      );
    });

    /** Test: the stored login on a fresh session. Logging in is the way out of a pause. */
    const imapTest = Effect.fn("ConnectionStore.imapTest")(function* (
      input: Identity,
      current: StoredImap
    ) {
      yield* imapCheck(input, current, "test");
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const locked = yield* lock(input, current);
          yield* sql`UPDATE connections SET last_tested_at = to_timestamp(${now / 1_000}),
            display = ${encodeDisplay(working(current.display, loginsOf(locked) + 1))}
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /**
     * Replace password: the new password's Test, then saved in place of the old with the pause
     * cleared. The login stays where it was, and so does the snapshot: a new password changes
     * nothing patches read. A disconnected connection stays disconnected.
     */
    const imapReplace = Effect.fn("ConnectionStore.imapReplace")(function* (
      input: CredentialsInput,
      current: StoredImap
    ) {
      const login = yield* ImapSource.parseCredentials(input.credentials);
      if (!sameLogin(current.display, login)) return yield* new ConnectionRetargetUnavailable({});
      yield* audited(
        { ...input, integration: "imap" },
        "imap.replace",
        imap.inspect(ImapSource.settings(login))
      );
      const encrypted = yield* keys.encrypt(current, ImapSource.credentials(login));
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const locked = yield* lock(input, current);
          yield* sql`UPDATE connections SET display = ${encodeDisplay(working(login, loginsOf(locked) + 1))},
            credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId},
            credential_revision = credential_revision + 1,
            last_tested_at = to_timestamp(${now / 1_000})
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /** Refresh folders: a fresh session's folders as a new snapshot revision. Never while paused. */
    const imapRefresh = Effect.fn("ConnectionStore.imapRefresh")(function* (
      input: Identity,
      current: StoredImap
    ) {
      if (current.status !== "connected") return yield* new ConnectionNotConnected({});
      if (current.display.paused !== undefined)
        return yield* new ImapSource.ConnectionPaused({ at: current.display.paused.at });
      const snapshot = yield* imapCheck(input, current, "refresh");
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const locked = yield* lock(input, current);
          const revision = current.metadataRevision + 1;
          yield* writeSnapshot(input, revision, { integration: "imap", snapshot }, now);
          yield* sql`UPDATE connections SET metadata_revision = ${revision},
            display = ${encodeDisplay(working(current.display, loginsOf(locked) + 1))},
            last_tested_at = to_timestamp(${now / 1_000}),
            last_discovered_at = to_timestamp(${now / 1_000})
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /** Reconnect always logs in on a fresh session; one that works clears a pause too. */
    const imapReconnect = Effect.fn("ConnectionStore.imapReconnect")(function* (
      input: Identity,
      current: StoredImap
    ) {
      yield* imapCheck(input, current, "reconnect");
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const locked = yield* lock(input, current);
          yield* sql`UPDATE connections SET status = 'connected', credential_revision = credential_revision + 1,
            display = ${encodeDisplay(working(current.display, loginsOf(locked) + 1))},
            last_tested_at = to_timestamp(${now / 1_000})
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    const pauseLogin = Effect.fn("ConnectionStore.pauseLogin")(
      function* (input: {
        readonly companyId: string;
        readonly id: string;
        readonly credentialRevision: number;
        readonly logins: number;
        readonly reply: ImapSource.Paused["reply"];
      }) {
        const now = yield* Clock.currentTimeMillis;
        yield* imapPause(input, input, {
          at: iso(now),
          reply: input.reply,
          during: "call"
        });
      },
      Effect.catchTags(safe("pauseLogin"))
    );

    const connect = Effect.fn("ConnectionStore.connect")(
      function* (input: ConnectInput, report?: (connection: Connection) => Effect.Effect<void>) {
        if (!Companies.isHandle(input.handle)) return yield* new InvalidConnectionHandle({});
        if (!isDescription(input.description)) return yield* new InvalidConnectionDescription({});
        if (input.integration === "pidgeon") return yield* pidgeonConnect(input, report);
        if (input.integration === "attio") return yield* attioConnect(input, report);
        if (input.integration === "imap") return yield* imapConnect(input, report);
        const identity = {
          ...input,
          integration: input.integration,
          id: yield* cryptography.internalId("conn")
        };
        const inspected = yield* inspect(identity, input.credentials);
        const encrypted = yield* keys.encrypt(identity, input.credentials);
        const now = yield* Clock.currentTimeMillis;
        return yield* reportedTransaction(
          insert(identity, input, inspected.target, encrypted, inspected.metadata, now),
          report
        );
      },
      Effect.catchTags(safe("connect"))
    );

    /** Revokes old keys with their own secrets: the ids it revoked, and the ones that refused. */
    const retire = Effect.fn("ConnectionStore.retire")(
      function* (old: ReadonlyArray<{ readonly key: PidgeonSource.Key; readonly name: string }>) {
        const revoked = new Set<string>();
        const left: Array<{ readonly key: PidgeonSource.Key; readonly name: string }> = [];
        for (const item of old) {
          const done = yield* PidgeonKeys.revoke(
            Redacted.make(item.key.token),
            item.key.id,
            "self"
          ).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false)
          );
          if (done) revoked.add(item.key.id);
          else left.push(item);
        }
        return { revoked, left };
      },
      Effect.provideService(PidgeonSource.Source, pidgeonSource),
      Effect.provideService(Cryptography.Cryptography, cryptography)
    );
    /**
     * Forgets old keys Pidgeon has revoked, under the connection's lock and as it stands now, so a
     * key retired meanwhile stays. Best effort: a revoked key still listed is tried again, and
     * counts as done, at the next Test connection.
     */
    const dropRetired = (input: Identity, revoked: ReadonlySet<string>) =>
      revoked.size === 0
        ? Effect.void
        : sql
            .withTransaction(
              Effect.gen(function* () {
                const current = yield* pidgeonOf(input, true);
                const credentials = yield* secretOf(current);
                const left = (credentials.retired ?? []).filter((key) => !revoked.has(key.id));
                yield* updatePidgeon(
                  input,
                  pidgeonDisplay(
                    current.display,
                    (current.display.retired ?? []).filter((item) => !revoked.has(item.id))
                  ),
                  {
                    value: {
                      identityId: credentials.identityId,
                      key: credentials.key,
                      ...(left.length === 0 ? {} : { retired: left })
                    },
                    newKey: false
                  }
                );
              })
            )
            .pipe(Effect.ignore);

    /**
     * Change access and Replace key: under the connection's lock, a new key for the same address,
     * checked, with a fresh snapshot, saved together with the old key as retired. Then the old key
     * revokes itself; one that won't, or a commit whose answer was lost, leaves it retired, named
     * on the page until Test connection or Delete revokes it.
     */
    const pidgeonReplace = Effect.fn("ConnectionStore.pidgeonReplace")(function* (
      input: CredentialsInput
    ) {
      const request = yield* PidgeonKeys.parseReplace(input.credentials);
      const identity = { ...input, integration: "pidgeon" as const };
      return yield* detached(
        Effect.gen(function* () {
          const current = yield* pidgeonOf(input);
          const minted = minting(`pidgeon/${current.handle}`);
          const replaced = yield* audited(
            identity,
            "pidgeon.replace",
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const locked = yield* pidgeonOf(input, true);
                  const old = yield* secretOf(locked);
                  const provisioned = yield* PidgeonKeys.replace({
                    request,
                    handle: locked.handle,
                    identityId: locked.display.identityId
                  });
                  const { made } = provisioned;
                  yield* minted.made(made);
                  const now = yield* Clock.currentTimeMillis;
                  const revision = locked.metadataRevision + 1;
                  yield* writeSnapshot(
                    input,
                    revision,
                    { integration: "pidgeon", snapshot: provisioned.snapshot },
                    now
                  );
                  // The old key is saved as retired with the new one, so it's never left untracked.
                  const retired = [
                    ...(locked.display.retired ?? []),
                    { id: old.key.id, name: locked.display.key.name }
                  ];
                  const retiredKeys = [...(old.retired ?? []), old.key];
                  yield* updatePidgeon(
                    input,
                    pidgeonDisplay(
                      {
                        email: provisioned.identity.email,
                        identityId: locked.display.identityId,
                        sendPolicy: provisioned.identity.sendPolicy,
                        access: request.access,
                        test: provisioned.test,
                        key: { id: made.id, name: made.name, madeAt: made.madeAt }
                      },
                      retired
                    ),
                    {
                      value: {
                        identityId: old.identityId,
                        key: { id: made.id, token: Redacted.value(made.token) },
                        retired: retiredKeys
                      },
                      newKey: true
                    }
                  );
                  yield* sql`UPDATE connections SET metadata_revision = ${revision},
                    last_tested_at = to_timestamp(${now / 1_000}),
                    last_discovered_at = to_timestamp(${now / 1_000})
                    WHERE id = ${input.id} AND company_id = ${input.companyId}`;
                  yield* minted.done;
                  return retiredOf(
                    { ...locked.display, retired },
                    { ...old, retired: retiredKeys }
                  );
                })
              )
              .pipe(Effect.catch(minted.settle))
          );
          yield* dropRetired(input, (yield* retire(replaced)).revoked);
          return yield* get(input.companyId, input.id);
        }).pipe(
          Effect.provideService(PidgeonSource.Source, pidgeonSource),
          Effect.provideService(Cryptography.Cryptography, cryptography)
        )
      );
    });

    const rotate = Effect.fn("ConnectionStore.rotate")(
      function* (input: CredentialsInput) {
        const current = yield* stored(input);
        if (current.integration === "pidgeon") return yield* pidgeonReplace(input);
        if (current.integration === "attio") return yield* attioReplace(input, current);
        if (current.integration === "imap") return yield* imapReplace(input, current);
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

    /** Checks the stored key reaches its address, and tries again to revoke old keys. */
    const pidgeonTest = Effect.fn("ConnectionStore.pidgeonTest")(
      function* (input: Identity, current: StoredPidgeon) {
        const credentials = yield* secretOf(current);
        yield* PidgeonKeys.test(credentials, current.display.email);
        yield* dropRetired(input, (yield* retire(retiredOf(current.display, credentials))).revoked);
        const now = yield* Clock.currentTimeMillis;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(input, current);
            yield* sql`UPDATE connections SET last_tested_at = to_timestamp(${now / 1_000}) WHERE id = ${input.id} AND company_id = ${input.companyId}`;
            return yield* get(input.companyId, input.id);
          })
        );
      },
      Effect.provideService(PidgeonSource.Source, pidgeonSource),
      Effect.provideService(Cryptography.Cryptography, cryptography)
    );

    const test = Effect.fn("ConnectionStore.test")(
      function* (input: Identity) {
        const current = yield* stored(input);
        if (current.integration === "pidgeon") return yield* pidgeonTest(input, current);
        if (current.integration === "attio") return yield* attioTest(input, current);
        if (current.integration === "imap") return yield* imapTest(input, current);
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
    /** A fresh snapshot of a Pidgeon address through its stored key: Refresh labels. */
    const pidgeonRefresh = Effect.fn("ConnectionStore.pidgeonRefresh")(
      function* (input: Identity, current: StoredPidgeon) {
        if (current.status !== "connected") return yield* new ConnectionNotConnected({});
        const credentials = yield* secretOf(current);
        const inspected = yield* audited(
          { ...input, integration: "pidgeon" },
          "pidgeon.discover",
          PidgeonKeys.inspect(credentials, current.display.email, current.display.access)
        );
        const now = yield* Clock.currentTimeMillis;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(input, current);
            const revision = current.metadataRevision + 1;
            yield* writeSnapshot(
              input,
              revision,
              { integration: "pidgeon", snapshot: inspected.snapshot },
              now
            );
            yield* updatePidgeon(input, {
              ...current.display,
              email: inspected.identity.email,
              sendPolicy: inspected.identity.sendPolicy
            });
            yield* sql`UPDATE connections SET metadata_revision = ${revision},
            last_tested_at = to_timestamp(${now / 1_000}),
            last_discovered_at = to_timestamp(${now / 1_000})
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
            return yield* get(input.companyId, input.id);
          })
        );
      },
      Effect.provideService(PidgeonSource.Source, pidgeonSource),
      Effect.provideService(Cryptography.Cryptography, cryptography)
    );
    const discover = Effect.fn("ConnectionStore.discover")(function* (
      input: Identity,
      credentials?: Redacted.Redacted<string>
    ) {
      const current = yield* stored(input);
      if (current.integration === "pidgeon") {
        if (credentials !== undefined) return yield* new ConnectionRetargetUnavailable({});
        return yield* pidgeonRefresh(input, current);
      }
      if (current.integration === "attio") {
        if (credentials !== undefined) return yield* new ConnectionRetargetUnavailable({});
        return yield* attioRefresh(input, current);
      }
      // Another mailbox is another connection.
      if (current.integration === "imap") {
        if (credentials !== undefined) return yield* new ConnectionRetargetUnavailable({});
        return yield* imapRefresh(input, current);
      }
      if (credentials === undefined && current.status !== "connected")
        return yield* new ConnectionNotConnected({});
      const secret = credentials ?? (yield* keys.decrypt(current, current));
      const inspected = yield* inspect({ ...input, integration: current.integration }, secret);
      const encrypted =
        credentials === undefined ? undefined : yield* keys.encrypt(current, secret);
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
        // The key was kept, so reconnecting needs no admin key: only a check that it still works.
        if (current.integration === "pidgeon")
          yield* PidgeonKeys.test(yield* secretOf(current), current.display.email).pipe(
            Effect.provideService(PidgeonSource.Source, pidgeonSource),
            Effect.provideService(Cryptography.Cryptography, cryptography)
          );
        else if (current.integration === "attio") return yield* attioReconnect(input, current);
        else if (current.integration === "imap") return yield* imapReconnect(input, current);
        else yield* testTarget(current.integration, yield* keys.decrypt(current, current));
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
    const AccessRow = Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["company", "teams"]),
      teamIds: Schema.Array(Schema.String)
    });
    type AccessRow = typeof AccessRow.Type;
    const audienceOf = (row: AccessRow): ConnectionStore.Audience =>
      row.kind === "company" ? { kind: "company" } : { kind: "teams", teamIds: row.teamIds };
    const accessRows = SqlSchema.findAll({
      Request: Schema.Struct({
        companyId: Schema.String,
        ids: Schema.optionalKey(Schema.Array(Schema.String)),
        integration: Schema.optionalKey(Schema.Literals(integrations)),
        handle: Schema.optionalKey(Schema.String)
      }),
      Result: AccessRow,
      execute: ({ companyId, ids, integration, handle }) => sql`
        SELECT c.id, c.audience_kind AS kind,
          ARRAY(SELECT team_id FROM connection_team_grants WHERE connection_id = c.id ORDER BY team_id) AS "teamIds"
        FROM connections c WHERE c.company_id = ${companyId} AND ${isKnown}
          ${ids === undefined ? sql`` : sql`AND ${sql.in("c.id", ids)}`}
          ${integration === undefined ? sql`` : sql`AND c.integration = ${integration}`}
          ${handle === undefined ? sql`` : sql`AND c.handle = ${handle}`}`
    });
    // Recorded memberships decide, whether or not the person is active, so a deactivated owner's
    // patches keep their connections. Teams are read only when an audience names some.
    const teamsOf = Effect.fn("ConnectionStore.teamsOf")(function* (
      companyId: string,
      userIds: readonly string[],
      audiences: readonly ConnectionStore.Audience[]
    ) {
      if (!audiences.some((audience) => audience.kind === "teams"))
        return new Map<string, readonly string[]>();
      const people = yield* teamService.people(companyId, userIds);
      return new Map(people.map((person) => [person.id, person.teamIds]));
    });
    const accessible = Effect.fn("ConnectionStore.accessible")(function* (
      companyId: string,
      rows: readonly AccessRow[],
      userId: string
    ) {
      const teams = yield* teamsOf(companyId, [userId], rows.map(audienceOf));
      const mine = teams.get(userId) ?? [];
      return new Set(
        rows.filter((row) => Teams.admits(audienceOf(row), mine)).map((row) => row.id)
      );
    });
    const audience = Effect.fn("ConnectionStore.audience")(
      function* (
        companyId: string,
        id: string
      ): Effect.fn.Return<
        ConnectionStore.Audience,
        ConnectionNotFound | SqlError | Schema.SchemaError
      > {
        const row = (yield* accessRows({ companyId, ids: [id] }))[0];
        if (!row) return yield* new ConnectionNotFound({ companyId, lookup: { id } });
        return audienceOf(row);
      },
      Effect.catchTags(safe("audience"))
    );
    const canUse = Effect.fn("ConnectionStore.canUse")(
      function* (companyId: string, id: string, userId: string) {
        const rows = yield* accessRows({ companyId, ids: [id] });
        if (!rows.length) return yield* new ConnectionNotFound({ companyId, lookup: { id } });
        return (yield* accessible(companyId, rows, userId)).has(id);
      },
      Effect.catchTags(safe("audience"))
    );
    const liveOwners = SqlSchema.findAll({
      Request: Schema.Struct({ companyId: Schema.String, id: Schema.String }),
      Result: Schema.Struct({ name: Schema.String, ownerId: Schema.String }),
      execute: ({ companyId, id }) => sql`SELECT DISTINCT p.name, p.owner_user_id AS "ownerId"
        FROM ${declarations(companyId)} AND ${live} AND v.id = p.current_version_id
          AND declaration.value->>'id' = ${id}
        ORDER BY p.name`
    });
    /** The live patches declaring the connection whose owners `current` admits and `next` doesn't. */
    const cutOff = Effect.fn("ConnectionStore.cutOff")(function* (
      companyId: string,
      id: string,
      current: ConnectionStore.Audience,
      next: ConnectionStore.Audience
    ) {
      const patches = yield* liveOwners({ companyId, id });
      const teams = yield* teamsOf(
        companyId,
        patches.map((patch) => patch.ownerId),
        [current, next]
      );
      return patches
        .filter((patch) => {
          const owner = teams.get(patch.ownerId) ?? [];
          return Teams.admits(current, owner) && !Teams.admits(next, owner);
        })
        .map((patch) => patch.name);
    });
    const setAudience = Effect.fn("ConnectionStore.setAudience")(
      function* (
        input: Identity & {
          readonly audience: ConnectionStore.Audience;
          readonly acknowledged?: boolean;
        }
      ) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* Users.lockAdministrator({
              companyId: input.companyId,
              actorId: input.userId
            }).pipe(
              Effect.catchTags({
                RoleForbidden: (cause) =>
                  Effect.fail(new ConnectionStore.ConnectionAdministrationDenied({ cause }))
              })
            );
            yield* lock(input);
            const selected = input.audience;
            if (selected.kind === "teams" && selected.teamIds.length === 0)
              return yield* new ConnectionStore.InvalidConnectionAudience({});
            const previous = yield* audience(input.companyId, input.id);
            const ids = selected.kind === "teams" ? [...new Set(selected.teamIds)].sort() : [];
            if (
              previous.kind === selected.kind &&
              (previous.kind === "company" ||
                (previous.teamIds.length === ids.length &&
                  previous.teamIds.every((id, index) => id === ids[index])))
            )
              return;
            // A publish holds the company row while it checks build access, so this sees it.
            const stopped = yield* cutOff(input.companyId, input.id, previous, selected);
            if (stopped.length > 0 && input.acknowledged !== true)
              return yield* new ConnectionStore.ConnectionCutsOff({ patches: stopped });
            yield* sql`DELETE FROM connection_team_grants WHERE connection_id = ${input.id}`;
            // The grant's foreign key refuses a team that isn't the company's, or was just deleted.
            for (const teamId of ids)
              yield* sql`INSERT INTO connection_team_grants(connection_id, company_id, team_id) VALUES (${input.id}, ${input.companyId}, ${teamId})`.pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "ConstraintError",
                  (cause) => Effect.fail(new ConnectionStore.InvalidConnectionAudience({ cause }))
                )
              );
            yield* sql`UPDATE connections SET audience_kind = ${selected.kind} WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          })
        );
      },
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTags(safe("audience"))
    );
    const ownerRows = SqlSchema.findAll({
      Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String }),
      Result: Schema.Struct({ userId: Schema.String }),
      execute: ({ companyId, patchId }) =>
        sql`SELECT owner_user_id AS "userId" FROM patches WHERE company_id = ${companyId} AND id = ${patchId}`
    });
    const ownerCanUse = Effect.fn("ConnectionStore.ownerCanUse")(
      function* (companyId: string, patchId: string, id: string) {
        const owner = (yield* ownerRows({ companyId, patchId }))[0];
        return owner !== undefined && (yield* canUse(companyId, id, owner.userId));
      },
      Effect.catchTags(safe("audience"))
    );
    const blockGuests = Effect.fn("ConnectionStore.blockGuests")(
      function* (input: Identity & { readonly block: boolean }) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(input);
            yield* sql`UPDATE connections SET block_guests = ${input.block} WHERE id = ${input.id} AND company_id = ${input.companyId}`;
            return yield* get(input.companyId, input.id);
          })
        );
      },
      Effect.catchTags(safe("blockGuests"))
    );
    const blockingRows = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (ids) => sql`SELECT id FROM connections WHERE id IN ${sql.in(ids)} AND block_guests`
    });
    const blockingGuests = Effect.fn("ConnectionStore.blockingGuests")(
      function* (ids: ReadonlyArray<string>) {
        if (ids.length === 0) return new Set<string>();
        return new Set((yield* blockingRows(ids)).map((row) => row.id));
      },
      Effect.catchTags(safe("blockingGuests"))
    );
    /**
     * Delete runs to its end even when its request is interrupted: once the row is gone, its keys
     * revoke themselves. If the COMMIT's answer is lost, the row says whether it went, but not who
     * removed it: the keys still revoke themselves, and only a delete whose own COMMIT answered
     * reports it.
     */
    const remove = Effect.fn("ConnectionStore.delete")(
      (input: Identity, report?: (connection: Connection) => Effect.Effect<void>) =>
        detached(
          Effect.gen(function* () {
            // Set once the DELETE ran, with the keys a removed row leaves to revoke.
            let doomed:
              | {
                  readonly connection: Connection;
                  readonly keys: ReadonlyArray<{
                    readonly key: PidgeonSource.Key;
                    readonly name: string;
                  }>;
                }
              | undefined;
            const removed = yield* reportedTransaction(
              Effect.gen(function* () {
                const connection = yield* lock(input);
                const references = yield* sql`SELECT 1 FROM ${declarations(input.companyId)}
                AND declaration.value->>'id' = ${input.id} LIMIT 1`;
                if (references.length !== 0) return yield* new ConnectionInUse({});
                // A minted key revokes itself once the row is gone, so its secret is read first.
                const minted =
                  connection.integration === "pidgeon" ? yield* pidgeonOf(input) : undefined;
                const keys =
                  minted === undefined
                    ? []
                    : yield* Effect.map(secretOf(minted), (credentials) => [
                        { key: credentials.key, name: minted.display.key.name },
                        ...retiredOf(minted.display, credentials)
                      ]);
                yield* sql`DELETE FROM connections WHERE id = ${input.id} AND company_id = ${input.companyId}`;
                doomed = { connection, keys };
                return doomed;
              }),
              (value) => report?.(value.connection) ?? Effect.void
            ).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (doomed === undefined || doomed.keys.length === 0) return yield* error;
                  if (Option.isSome(yield* connectionRow({ ...input, locked: false })))
                    return yield* error;
                  return doomed;
                })
              )
            );
            const { left } = yield* retire(removed.keys);
            return {
              connection: removed.connection,
              keyLeft: left.length === 0 ? null : left.map((item) => item.name).join(", ")
            };
          })
        ),
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
      function* (
        companyId: string,
        declaration: ConnectionDeclaration,
        credentialRevision: number
      ) {
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
        // A refused login paused it: nothing logs in until an admin's Test or Replace password.
        if (found.value.integration === "imap" && found.value.display.paused !== undefined)
          return yield* new ImapSource.ConnectionPaused({ at: found.value.display.paused.at });
        return yield* keys.decrypt(found.value, found.value);
      },
      Effect.catchTags(safe("poolCredentials"))
    );

    // The connection's row must be the company's; the budget check and the count are one
    // statement, so concurrent sends never pass it together.
    const countSend = Effect.fn("ConnectionStore.countSend")(
      function* (companyId: string, id: string, day: string, budget: number) {
        const counted = yield* sql<{ readonly sends: number }>`INSERT INTO pidgeon_sends
            (connection_id, day, sends)
          SELECT id, ${day}::date, 1 FROM connections
            WHERE id = ${id} AND company_id = ${companyId} AND integration = 'pidgeon'
              AND ${budget} > 0
          ON CONFLICT (connection_id, day) DO UPDATE SET sends = pidgeon_sends.sends + 1
            WHERE pidgeon_sends.sends < ${budget}
          RETURNING sends`;
        return counted.length === 1;
      },
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new ConnectionStorageFailed({ operation: "countSend", cause: Redacted.make(cause) })
          )
      })
    );
    const sends = Effect.fn("ConnectionStore.sends")(
      function* (companyId: string, id: string, day: string) {
        const rows = yield* sql<{ readonly sends: number }>`SELECT s.sends FROM pidgeon_sends s
          JOIN connections c ON c.id = s.connection_id
          WHERE c.company_id = ${companyId} AND s.connection_id = ${id} AND s.day = ${day}::date`;
        return rows[0]?.sends ?? 0;
      },
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new ConnectionStorageFailed({ operation: "sends", cause: Redacted.make(cause) })
          )
      })
    );

    return ConnectionStore.ConnectionStore.of({
      audience,
      setAudience,
      canUse,
      ownerCanUse,
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
      blockGuests,
      blockingGuests,
      delete: remove,
      resolve,
      poolCredentials,
      countSend,
      sends,
      pauseLogin
    });
  });

export const layer = Layer.effect(ConnectionStore.ConnectionStore, make);

/** Every connection whose audience names teams, with those teams. */
export const teamConnections = Effect.fn("ConnectionStore.teamConnections")(function* (
  companyId: string
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly id: string;
    readonly integration: string;
    readonly handle: string;
    readonly teamIds: readonly string[];
  }>`SELECT c.id, c.integration, c.handle, array_agg(g.team_id ORDER BY g.team_id) AS "teamIds"
    FROM connection_team_grants g JOIN connections c ON c.id = g.connection_id
    WHERE g.company_id = ${companyId}
    GROUP BY c.id, c.integration, c.handle ORDER BY c.integration, c.handle`;
});
