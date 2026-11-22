import {
  AttioSnapshot,
  type ConnectionDeclaration,
  type ConnectionDetail,
  type GithubAccount,
  type GithubRepository,
  GithubSnapshot,
  ImapSnapshot,
  integrations,
  type Integration,
  ModelsSnapshot,
  PidgeonSnapshot,
  PostHogSnapshot
} from "@patchy/api";
import { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Companies from "@patchy/companies/Companies";
import { Cryptography } from "@patchy/core";
import { Teams, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import { ContractLimits } from "@patchy/limits";
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
  GithubConnectionRow,
  ImapConnection,
  InvalidConnectionDescription,
  InvalidConnectionHandle,
  InvalidModelId,
  Metadata,
  ModelProvider,
  ModelsConnection,
  ModelsUnavailable,
  PidgeonConnection,
  PostgresConnection,
  PostHogConnection,
  ProviderInUse,
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
import * as PidgeonLedger from "./pidgeon/Ledger.js";
import * as PidgeonSource from "./pidgeon/Source.js";
import * as AttioSource from "./attio/Source.js";
import * as ImapSource from "./imap/Source.js";
import * as GithubAccess from "./github/Access.js";
import * as GithubClaims from "./github/Claims.js";
import * as GithubConnection from "./github/Connection.js";
import * as GithubFlows from "./github/Flows.js";
import * as Models from "./models/Models.js";

const isDescription = Schema.is(Description);
const decodeMetadata = Schema.decodeUnknownEffect(Metadata);
const encodePostgresSnapshot = Schema.encodeSync(Schema.fromJsonString(Snapshot));
const encodePostHogSnapshot = Schema.encodeSync(Schema.fromJsonString(PostHogSnapshot));
const encodePidgeonSnapshot = Schema.encodeSync(Schema.fromJsonString(PidgeonSnapshot));
const encodeAttioSnapshot = Schema.encodeSync(Schema.fromJsonString(AttioSnapshot));
const encodeImapSnapshot = Schema.encodeSync(Schema.fromJsonString(ImapSnapshot));
const encodeGithubSnapshot = Schema.encodeSync(Schema.fromJsonString(GithubSnapshot));
const encodeModelsSnapshot = Schema.encodeSync(Schema.fromJsonString(ModelsSnapshot));
const encodePostgresDisplay = Schema.encodeSync(Schema.fromJsonString(PostgresSource.Display));
const encodePostHogDisplay = Schema.encodeSync(Schema.fromJsonString(PostHogSource.Display));
const encodePidgeonDisplay = Schema.encodeSync(Schema.fromJsonString(PidgeonSource.Display));
const encodeAttioDisplay = Schema.encodeSync(Schema.fromJsonString(AttioSource.Display));
const encodeImapDisplay = Schema.encodeSync(Schema.fromJsonString(ImapSource.Display));
const encodeGithubDisplay = Schema.encodeSync(Schema.fromJsonString(GithubConnection.Display));
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
    case "github":
      return encodeGithubSnapshot(metadata.snapshot);
    case "models":
      return encodeModelsSnapshot(metadata.snapshot);
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
    case "github":
      return encodeGithubDisplay(target.display);
    // A role's mapping is its `model_roles` row, never display.
    case "models":
      return "{}";
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
        ? next.integration === "pidgeon" && next.display.inboxId === current.display.inboxId
        : current.integration === "imap"
          ? next.integration === "imap" && sameLogin(current.display, next.display)
          : current.integration === "github"
            ? next.integration === "github" &&
              next.display.account.id === current.display.account.id
            : current.integration === "attio"
              ? next.integration === "attio" &&
                next.display.workspace.id === current.display.workspace.id
              : false;
const secret = { credentials: Schema.String, keyId: Schema.String };
const StoredConnection = Schema.Union([
  Schema.Struct({ ...PostgresConnection.fields, ...secret }),
  Schema.Struct({ ...PostHogConnection.fields, ...secret }),
  Schema.Struct({ ...PidgeonConnection.fields, ...secret }),
  Schema.Struct({ ...AttioConnection.fields, ...secret }),
  Schema.Struct({ ...ImapConnection.fields, ...secret }),
  Schema.Struct({ ...GithubConnectionRow.fields, ...secret }),
  Schema.Struct({ ...ModelsConnection.fields, ...secret })
]);
type StoredConnection = typeof StoredConnection.Type;
type StoredPidgeon = Extract<StoredConnection, { readonly integration: "pidgeon" }>;
type StoredAttio = Extract<StoredConnection, { readonly integration: "attio" }>;
type StoredImap = Extract<StoredConnection, { readonly integration: "imap" }>;
type StoredGithub = Extract<StoredConnection, { readonly integration: "github" }>;
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
  }),
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("github"),
    snapshot: Schema.NullOr(GithubSnapshot)
  }),
  Schema.Struct({
    ...detailFields,
    integration: Schema.Literal("models"),
    snapshot: Schema.NullOr(ModelsSnapshot),
    // Its provider's state, null for a provider of an integration this release doesn't know.
    providerStatus: Schema.NullOr(Schema.Literals(["connected", "disconnected"]))
  })
]);
const Lookup = Schema.Struct({
  companyId: Schema.String,
  id: Schema.String,
  locked: Schema.Boolean
});

/** Runs `effect` to its end even when the request that started it is interrupted. */
const detached = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.forkDetach(effect), Fiber.join);

/**
 * Every integration this release ships, without Models' roles and providers while the host's
 * switch is off; `knowing` makes a store of an earlier release's.
 */
export const make = Effect.gen(function* () {
  // The launch checks the switch's value first, so an unreadable one never gets this far.
  return yield* knowing(Models.known(yield* Models.enabled.pipe(Effect.orDie)));
});

/**
 * A store that reads only `known` integrations' rows, as the release that shipped them did. Rows of
 * integrations a later release added stay hidden, so a rollback lists and shows the rest. Its
 * connection reads take the public ones; providers are read only by the Models methods, and only
 * while `models` is known.
 */
export const knowing = (known: ReadonlyArray<Models.Kind>) =>
  Effect.gen(function* () {
    const readable: ReadonlyArray<Integration> = integrations.filter((kind) =>
      known.includes(kind)
    );
    const models = readable.includes("models");
    const providerKinds = models ? Models.providers.filter((kind) => known.includes(kind)) : [];
    const teamService = yield* Teams.Teams;
    const cryptography = yield* Cryptography.Cryptography;
    const sql = yield* SqlClient.SqlClient;
    const keys = yield* CredentialKeys.CredentialKeys;
    const postgres = yield* PostgresSource.Source;
    const posthog = yield* PostHogSource.Source;
    const pidgeonSource = yield* PidgeonSource.Source;
    const attio = yield* AttioSource.Source;
    const imap = yield* ImapSource.Source;
    const githubAccess = yield* GithubAccess.Access;
    const githubFlows = yield* GithubFlows.Flows;
    const audit = yield* RuntimeLog.RuntimeLog;
    // A provider, `p`, is of an integration this release knows, or reads as none.
    const knownProvider =
      providerKinds.length === 0 ? sql`false` : sql`p.integration IN ${sql.in(providerKinds)}`;
    // A role's mapping, and its provider as this release reads it: null where it doesn't know it.
    // Only a role's row looks it up; every other row skips the probe.
    const role = sql`CASE WHEN connections.integration = 'models' THEN
      (SELECT json_build_object('kind', r.kind, 'model', r.model, 'providerId', r.provider_id,
        'provider', (SELECT json_build_object('integration', p.integration, 'handle', p.handle,
            'status', p.status)
          FROM connections p WHERE p.company_id = r.company_id AND p.id = r.provider_id
            AND ${knownProvider}))
      FROM model_roles r WHERE r.connection_id = connections.id) END AS "role"`;
    const columns = sql`id, company_id AS "companyId", integration, handle, description, mode, status,
    block_guests AS "blockGuests", display, credential_revision AS "credentialRevision", metadata_revision AS "metadataRevision",
    to_char(last_tested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastTestedAt",
    to_char(last_discovered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastDiscoveredAt",
    created_by AS "createdBy",
    (SELECT to_char(i.suspended_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM github_installations i WHERE connections.integration = 'github'
        AND i.installation_id = (connections.display->>'installationId')::bigint) AS "suspendedAt"
    ${models ? sql`, ${role}` : sql``}`;
    const safe = (operation: ConnectionStorageFailed["operation"]) => ({
      SqlError: (cause: SqlError) =>
        Effect.fail(new ConnectionStorageFailed({ operation, cause: Redacted.make(cause) })),
      SchemaError: (cause: Schema.SchemaError) =>
        Effect.fail(new ConnectionStorageFailed({ operation, cause: Redacted.make(cause) }))
    });
    // Rows of integrations a later release added are not this release's to read: a rollback
    // hides them, and a lookup by id answers not found instead of failing to decode. A provider
    // is never one of them.
    const isKnown = sql`integration IN ${sql.in(readable)}`;
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
      ${
        models
          ? sql`, CASE WHEN c.integration = 'models' THEN (SELECT p.status FROM model_roles r
              JOIN connections p
                ON p.company_id = r.company_id AND p.id = r.provider_id AND ${knownProvider}
              WHERE r.connection_id = c.id) END AS "providerStatus"`
          : sql``
      }
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
    WHERE p.company_id = ${companyId} AND declaration.value->>'kind' IN ${sql.in(readable)}`;
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
        // An integration this store doesn't read answers as an unknown handle, before any lookup.
        if (!readable.includes(integration))
          return yield* new ConnectionNotFound({ companyId, lookup: { integration, handle } });
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
        if (row.integration === "github")
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
        // A role reads as disconnected while its provider can't serve it, as it does in the list.
        if (row.integration === "models") {
          const { providerStatus, ...role } = row;
          return {
            ...role,
            status:
              role.status === "connected" && providerStatus === "connected"
                ? "connected"
                : "disconnected",
            snapshot:
              role.snapshot === null || stamp === null ? null : { ...role.snapshot, ...stamp }
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
    /**
     * No such record here. The connection verbs answer it for a role too: one changes only
     * through the Models methods.
     */
    const notFound = (input: { readonly companyId: string; readonly id: string }) =>
      new ConnectionNotFound({ companyId: input.companyId, lookup: { id: input.id } });
    const lock = Effect.fn("ConnectionStore.lock")(function* (
      input: Identity,
      expected?: Pick<StoredConnection, "credentialRevision" | "metadataRevision">
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

    // ---------- Pidgeon: a pasted key, kept with the one inbox it serves here ----------

    const secretOf = (current: StoredPidgeon) =>
      keys
        .decrypt(current, current)
        .pipe(Effect.flatMap((value) => PidgeonSource.parseCredentials(value)));
    const sealed = (current: Identity, value: PidgeonSource.Credentials) =>
      keys.encrypt(
        { companyId: current.companyId, id: current.id, integration: "pidgeon" },
        PidgeonSource.credentials(value)
      );
    const withPidgeon = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(PidgeonSource.Source, pidgeonSource));

    /** Connect: the pasted key's checks and the snapshot it read, saved with the inbox's id. */
    const pidgeonConnect = Effect.fn("ConnectionStore.pidgeonConnect")(function* (
      input: ConnectInput,
      report?: (connection: Connection) => Effect.Effect<void>
    ) {
      const request = yield* PidgeonKeys.parseConnect(input.credentials);
      // An interrupted connect never keeps the name.
      return yield* claimed(
        input,
        Effect.gen(function* () {
          const identity = {
            ...input,
            integration: "pidgeon" as const,
            id: yield* cryptography.internalId("conn")
          };
          const checked = yield* audited(
            identity,
            "pidgeon.connect",
            withPidgeon(PidgeonKeys.connect(request))
          );
          const encrypted = yield* sealed(identity, checked.credentials);
          const now = yield* Clock.currentTimeMillis;
          return yield* reportedTransaction(
            insert(
              identity,
              input,
              { integration: "pidgeon", display: checked.display },
              encrypted,
              { integration: "pidgeon", snapshot: checked.snapshot },
              now
            ),
            report
          );
        })
      );
    });

    /**
     * Saves what a Pidgeon check found under the connection's lock, as a new snapshot revision:
     * its display, and its key when it brought a new one.
     */
    const pidgeonSave = (
      input: Identity,
      current: StoredPidgeon,
      checked: Omit<PidgeonKeys.Checked, "credentials"> & {
        readonly credentials?: PidgeonSource.Credentials;
      },
      tested: boolean
    ) =>
      Effect.gen(function* () {
        const encrypted =
          checked.credentials === undefined ? undefined : yield* sealed(input, checked.credentials);
        const now = yield* Clock.currentTimeMillis;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock(input, current);
            const revision = current.metadataRevision + 1;
            yield* writeSnapshot(
              input,
              revision,
              { integration: "pidgeon", snapshot: checked.snapshot },
              now
            );
            yield* sql`UPDATE connections SET metadata_revision = ${revision},
              display = ${encodeDisplay({ integration: "pidgeon", display: checked.display })}
              ${encrypted === undefined ? sql`` : sql`, credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId}, credential_revision = credential_revision + 1`}
              ${tested ? sql`, last_tested_at = to_timestamp(${now / 1_000}), last_discovered_at = to_timestamp(${now / 1_000})` : sql``}
              WHERE id = ${input.id} AND company_id = ${input.companyId}`;
            return yield* get(input.companyId, input.id);
          })
        );
      });

    /**
     * Replace key: a new key, checked to reach the same inbox and do what patches may, saved with a
     * fresh snapshot. Change access: Patchy's own setting, so lowering it asks Pidgeon nothing;
     * raising it to send checks that the stored key can send.
     */
    const pidgeonChange = Effect.fn("ConnectionStore.pidgeonChange")(function* (
      input: CredentialsInput,
      current: StoredPidgeon
    ) {
      const change = yield* PidgeonKeys.parseChange(input.credentials);
      const identity = { ...input, integration: "pidgeon" as const };
      if ("key" in change)
        return yield* pidgeonSave(
          input,
          current,
          yield* audited(
            identity,
            "pidgeon.replace",
            withPidgeon(PidgeonKeys.replace(change.key, current.display))
          ),
          true
        );
      if (change.access === current.display.access) return yield* get(input.companyId, input.id);
      if (change.access === "send")
        return yield* pidgeonSave(
          input,
          current,
          yield* audited(
            identity,
            "pidgeon.access",
            withPidgeon(PidgeonKeys.inspect(yield* secretOf(current), current.display, "send"))
          ),
          true
        );
      const kept = yield* snapshot(input.companyId, input.id, current.metadataRevision);
      if (kept.integration !== "pidgeon")
        return yield* new ConnectionNotFound({
          companyId: input.companyId,
          lookup: { id: input.id }
        });
      return yield* pidgeonSave(
        input,
        current,
        {
          display: { ...current.display, access: "read" },
          snapshot: { ...kept.snapshot, access: "read" }
        },
        false
      );
    });

    /** Test connection: the stored key's checks at the connection's access. */
    const pidgeonTest = Effect.fn("ConnectionStore.pidgeonTest")(function* (
      input: Identity,
      current: StoredPidgeon
    ) {
      yield* withPidgeon(PidgeonKeys.test(yield* secretOf(current), current.display));
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, current);
          yield* sql`UPDATE connections SET last_tested_at = to_timestamp(${now / 1_000}) WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /** Refresh labels: the stored key's checks and a fresh snapshot, attributed to the admin. */
    const pidgeonRefresh = Effect.fn("ConnectionStore.pidgeonRefresh")(function* (
      input: Identity,
      current: StoredPidgeon
    ) {
      if (current.status !== "connected") return yield* new ConnectionNotConnected({});
      const credentials = yield* secretOf(current);
      const checked = yield* audited(
        { ...input, integration: "pidgeon" },
        "pidgeon.discover",
        withPidgeon(PidgeonKeys.inspect(credentials, current.display, current.display.access))
      );
      return yield* pidgeonSave(
        input,
        current,
        { display: checked.display, snapshot: checked.snapshot },
        true
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

    // ---------- GitHub: repositories on one account's installation of the App ----------

    const githubSeal = (identity: Identity, value: GithubConnection.Credentials) =>
      keys.encrypt(
        { companyId: identity.companyId, id: identity.id, integration: "github" },
        GithubConnection.credentials(value)
      );
    const githubSet = (repositories: ReadonlyArray<GithubRepository>) =>
      repositories.map(({ id, name, private: hidden, left }): GithubConnection.Repository => ({
        id,
        name,
        private: hidden,
        ...(left === true ? { left } : {})
      }));
    const githubMetadata = (
      account: GithubAccount,
      repositories: ReadonlyArray<GithubRepository>
    ): Metadata => ({ integration: "github", snapshot: { version: 1, account, repositories } });
    /**
     * A GitHub display as written: what's given, with the count of successes the row keeps plus
     * `bump`, so a write never moves it back under a mint that raced it.
     */
    const githubDisplay = (display: Omit<GithubConnection.Display, "successes">, bump: 0 | 1) =>
      sql`(${encodeDisplay({ integration: "github", display: { ...display, successes: 0 } })}::jsonb
        || jsonb_build_object('successes', COALESCE((display->>'successes')::int, 0) + ${bump}))`;
    /** A display without what Patchy paused it for: what a passing check leaves. */
    const githubCleared = (
      display: GithubConnection.Display
    ): Omit<GithubConnection.Display, "successes"> => ({
      installationId: display.installationId,
      account: display.account,
      repositories: display.repositories
    });
    /** The admin's live sign-in for this purpose and connection, or the refusal that asks again. */
    const githubSignedIn = (
      input: { readonly companyId: string; readonly userId: string },
      purpose: GithubFlows.Purpose,
      connectionId: string | null
    ) =>
      Effect.gen(function* () {
        const flow = yield* githubFlows.current(input);
        if (
          Option.isNone(flow) ||
          Option.isNone(flow.value.signedIn) ||
          flow.value.purpose !== purpose ||
          flow.value.connectionId !== connectionId
        )
          return yield* new GithubConnection.SignInRequired({});
        return { flow: flow.value, who: flow.value.signedIn.value };
      });
    /** The admin check, which locks the company first, as every change that consumes a flow does. */
    const githubAdmin = (input: { readonly companyId: string; readonly userId: string }) =>
      Users.lockAdministrator({ companyId: input.companyId, actorId: input.userId }).pipe(
        Effect.catchTags({
          RoleForbidden: (cause) =>
            Effect.fail(new ConnectionStore.ConnectionAdministrationDenied({ cause }))
        })
      );
    /**
     * A personal account's installation is exempt from the one-company claim only for its own
     * user: the person signed in to GitHub, by numeric id, is the account.
     */
    const githubExempt = (account: GithubAccount, who: { readonly id: number }) =>
      account.type === "User" && who.id === account.id;
    /**
     * A save that consumes the admin's flow, in one transaction, then the token the deleted row
     * held revoked at GitHub. Both run to their end even when the request is interrupted, so a
     * consumed flow never leaves its token live.
     */
    const githubSaved = <E>(
      input: { readonly companyId: string },
      save: Effect.Effect<
        { readonly held: GithubFlows.Held; readonly saved: Connection },
        E,
        SqlClient.SqlClient
      >,
      report?: (connection: Connection) => Effect.Effect<void>
    ) =>
      detached(
        reportedTransaction(save.pipe(Effect.provideService(SqlClient.SqlClient, sql)), (value) =>
          report === undefined ? Effect.void : report(value.saved)
        ).pipe(
          Effect.tap((value) => githubFlows.revoke(input.companyId, value.held)),
          Effect.map((value) => value.saved)
        )
      );

    /**
     * Connect: the repositories read again with the admin's GitHub sign-in, each in the one
     * installation with `admin` exactly true; the installation checked and the set discovered with
     * a mint for it; then one transaction in the lock order: the company's admin check, the flow
     * record consumed, the installation's row locked and claimed, the connection saved. Nothing is
     * saved on any refusal. The admin's token is revoked at GitHub after.
     */
    const githubConnect = Effect.fn("ConnectionStore.githubConnect")(function* (
      input: ConnectInput,
      report?: (connection: Connection) => Effect.Effect<void>
    ) {
      const request = yield* GithubConnection.parseRequest(input.credentials);
      return yield* claimed(
        input,
        Effect.gen(function* () {
          const identity = {
            ...input,
            integration: "github" as const,
            id: yield* cryptography.internalId("conn")
          };
          const { flow, who } = yield* githubSignedIn(input, "connect", null);
          const { verified, inspected } = yield* audited(
            identity,
            "github.connect",
            Effect.gen(function* () {
              const verified = yield* githubFlows.verify(who.token, request);
              const inspected = yield* githubAccess.inspect(
                verified.installationId,
                verified.repositories.map((item) => item.id),
                verified.account.login
              );
              return { verified, inspected };
            })
          );
          const { account } = inspected;
          const display: GithubConnection.Display = {
            installationId: verified.installationId,
            account,
            repositories: githubSet(inspected.repositories),
            // The check that saves it is its first success.
            successes: 1
          };
          const encrypted = yield* githubSeal(identity, {
            installationId: verified.installationId,
            repositoryIds: display.repositories.map((item) => item.id)
          });
          const now = yield* Clock.currentTimeMillis;
          return yield* githubSaved(
            input,
            Effect.gen(function* () {
              yield* githubAdmin(input);
              const held = yield* GithubClaims.consumeFlow({
                id: flow.id,
                companyId: input.companyId,
                userId: input.userId
              });
              yield* GithubClaims.lock(verified.installationId);
              yield* GithubClaims.claim({
                installationId: verified.installationId,
                companyId: input.companyId,
                account: account.login,
                exempt: githubExempt(account, who)
              });
              const saved = yield* insert(
                identity,
                input,
                { integration: "github", display },
                encrypted,
                githubMetadata(account, inspected.repositories),
                now
              );
              return { held, saved };
            }),
            report
          );
        })
      );
    });

    /** Test: the check. Passing clears what Patchy paused it for; Resume connects it again. */
    const githubTest = Effect.fn("ConnectionStore.githubTest")(function* (input: Identity) {
      const loaded = yield* audited(
        { ...input, integration: "github" },
        "github.test",
        githubAccess.check(input, "test", input.userId)
      );
      const now = yield* Clock.currentTimeMillis;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // The display written is what the check loaded: a Refresh that renamed a repository
          // meanwhile is kept, and this Test refused as changed.
          yield* lock(input, loaded);
          yield* sql`UPDATE connections SET last_tested_at = to_timestamp(${now / 1_000}),
            display = ${githubDisplay(githubCleared(loaded.display), 1)}
            WHERE id = ${input.id} AND company_id = ${input.companyId}
              AND credential_revision = ${loaded.credentialRevision}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /**
     * Refresh: the check, and each repository read again by id, its name now and whether it left
     * or came back, as a new snapshot. A set whose left ones changed takes a new credential
     * revision too, so no token for the old set is used again.
     */
    const githubRefresh = Effect.fn("ConnectionStore.githubRefresh")(function* (input: Identity) {
      const { loaded, repositories } = yield* audited(
        { ...input, integration: "github" },
        "github.discover",
        githubAccess.discover(input, input.userId)
      );
      const now = yield* Clock.currentTimeMillis;
      const left = (items: ReadonlyArray<{ readonly id: number; readonly left?: true }>) =>
        items
          .filter((item) => item.left === true)
          .map((item) => item.id)
          .sort((a, b) => a - b)
          .join(",");
      const moved = left(loaded.display.repositories) !== left(repositories);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock(input, loaded);
          const revision = loaded.metadataRevision + 1;
          yield* writeSnapshot(
            input,
            revision,
            githubMetadata(loaded.display.account, repositories),
            now
          );
          yield* sql`UPDATE connections SET metadata_revision = ${revision},
            display = ${githubDisplay({ ...githubCleared(loaded.display), repositories: githubSet(repositories) }, 1)},
            last_tested_at = to_timestamp(${now / 1_000}),
            last_discovered_at = to_timestamp(${now / 1_000})
            ${moved ? sql`, credential_revision = credential_revision + 1` : sql``}
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        })
      );
    });

    /**
     * Resume: the check, then the installation's row locked and the company's claim confirmed,
     * then the connection connected again with what Patchy paused it for cleared.
     */
    const githubResume = Effect.fn("ConnectionStore.githubResume")(function* (input: Identity) {
      const loaded = yield* audited(
        { ...input, integration: "github" },
        "github.reconnect",
        githubAccess.check(input, "reconnect", input.userId)
      );
      const now = yield* Clock.currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* GithubClaims.lock(loaded.display.installationId);
            // Resume has no GitHub sign-in to match a personal account's user against, and needs
            // none: a paused connection keeps its company's claim, made when a sign-in proved it, so
            // this confirms a claim the company already holds and grants nothing new.
            yield* GithubClaims.claim({
              installationId: loaded.display.installationId,
              companyId: input.companyId,
              account: loaded.display.account.login,
              exempt: loaded.display.account.type === "User"
            });
            yield* lock(input, loaded);
            yield* sql`UPDATE connections SET status = 'connected',
              credential_revision = credential_revision + 1,
              display = ${githubDisplay(githubCleared(loaded.display), 1)},
              last_tested_at = to_timestamp(${now / 1_000})
              WHERE id = ${input.id} AND company_id = ${input.companyId}`;
            return yield* get(input.companyId, input.id);
          })
        )
        .pipe(Effect.provideService(SqlClient.SqlClient, sql));
    });

    /** The connection's current snapshot's repositories, by id, for a change that keeps some. */
    const githubKnown = (input: Identity, revision: number) =>
      Effect.map(snapshot(input.companyId, input.id, revision), (metadata) =>
        metadata.integration === "github"
          ? new Map(metadata.snapshot.repositories.map((item) => [item.id, item] as const))
          : new Map<number, GithubRepository>()
      );

    /**
     * Add and Remove. Removing needs no GitHub sign-in. Adding reads the new repositories with
     * the admin's sign-in, under the same rule as connecting, checks the installation and mints for
     * the whole set before one transaction in the lock order saves it.
     */
    const githubRepositories = Effect.fn("ConnectionStore.githubRepositories")(function* (
      input: CredentialsInput,
      current: StoredGithub,
      change: Extract<GithubConnection.Change, { readonly action: "repositories" }>
    ) {
      const max = yield* ContractLimits.get("github.connection.repositories");
      const { display } = current;
      const keep = display.repositories.filter((item) => change.keep.includes(item.id));
      const known = new Set(display.repositories.map((item) => item.id));
      const added = change.add.filter((item) => !known.has(item.id));
      if (keep.length + added.length === 0) return yield* new GithubConnection.LastRepository({});
      if (keep.length + added.length > max)
        return yield* new GithubConnection.TooManyRepositories({ max });
      const before = yield* githubKnown(input, current.metadataRevision);
      const now = yield* Clock.currentTimeMillis;
      const save = (repositories: ReadonlyArray<GithubRepository>, account: GithubAccount) =>
        Effect.gen(function* () {
          yield* lock(input, current);
          const revision = current.metadataRevision + 1;
          const encrypted = yield* githubSeal(input, {
            installationId: display.installationId,
            repositoryIds: repositories.map((item) => item.id)
          });
          yield* writeSnapshot(input, revision, githubMetadata(account, repositories), now);
          yield* sql`UPDATE connections SET metadata_revision = ${revision},
            display = ${githubDisplay({ ...display, account, repositories: githubSet(repositories) }, 0)},
            credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId},
            credential_revision = credential_revision + 1,
            last_discovered_at = to_timestamp(${now / 1_000})
            WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          return yield* get(input.companyId, input.id);
        });
      const kept = keep.map(
        (item): GithubRepository =>
          before.get(item.id) ?? {
            id: item.id,
            name: item.name,
            defaultBranch: "",
            private: item.private,
            archived: false,
            disabled: false,
            ...(item.left === true ? { left: true as const } : {})
          }
      );
      if (added.length === 0) {
        if (keep.length === display.repositories.length)
          return yield* get(input.companyId, input.id);
        return yield* sql.withTransaction(save(kept, display.account));
      }
      const { flow, who } = yield* githubSignedIn(input, "add", input.id);
      const { inspected } = yield* audited(
        { ...input, integration: "github" },
        "github.add",
        Effect.gen(function* () {
          const verified = yield* githubFlows.verify(who.token, { repositories: added });
          if (verified.installationId !== display.installationId)
            return yield* new GithubConnection.OneAccount({});
          const reachable = kept.filter((item) => item.left !== true).map((item) => item.id);
          const inspected = yield* githubAccess.inspect(
            display.installationId,
            [...reachable, ...verified.repositories.map((item) => item.id)],
            display.account.login
          );
          return { inspected };
        })
      );
      const fresh = new Map(inspected.repositories.map((item) => [item.id, item] as const));
      const repositories = [
        ...kept.map((item) => fresh.get(item.id) ?? item),
        ...added.flatMap((item) => fresh.get(item.id) ?? [])
      ];
      return yield* githubSaved(
        input,
        Effect.gen(function* () {
          yield* githubAdmin(input);
          const held = yield* GithubClaims.consumeFlow({
            id: flow.id,
            companyId: input.companyId,
            userId: input.userId
          });
          yield* GithubClaims.lock(display.installationId);
          yield* GithubClaims.claim({
            installationId: display.installationId,
            companyId: input.companyId,
            account: inspected.account.login,
            exempt: githubExempt(inspected.account, who)
          });
          return { held, saved: yield* save(repositories, inspected.account) };
        })
      );
    });

    /**
     * Reconnect, after the App was reinstalled, which is a new installation: the admin's sign-in
     * must see the App on the connection's own account, GitHub must show them administering every
     * repository in the set there, and the check and a mint must pass. Then one transaction locks
     * both installations' rows in ascending order, claims the new one, moves the connection to it
     * and drops the company's claim on the old one if nothing else of its uses it.
     */
    const githubReconnect = Effect.fn("ConnectionStore.githubReconnect")(function* (
      input: CredentialsInput,
      current: StoredGithub
    ) {
      const { display } = current;
      const { flow, who } = yield* githubSignedIn(input, "reconnect", input.id);
      const { installationId, inspected } = yield* audited(
        { ...input, integration: "github" },
        "github.reconnect",
        Effect.gen(function* () {
          const found = yield* githubFlows.installationOn(who.token, display.account.id);
          if (Option.isNone(found))
            return yield* new GithubConnection.OtherAccount({ account: display.account.login });
          const ids = display.repositories.map((item) => item.id);
          yield* githubFlows.verify(who.token, {
            repositories: ids.map((id) => ({ installationId: found.value, id }))
          });
          const inspected = yield* githubAccess.inspect(found.value, ids, display.account.login);
          if (inspected.account.id !== display.account.id)
            return yield* new GithubConnection.OtherAccount({ account: display.account.login });
          return { installationId: found.value, inspected };
        })
      );
      const now = yield* Clock.currentTimeMillis;
      const saved = yield* githubSaved(
        input,
        Effect.gen(function* () {
          yield* githubAdmin(input);
          const held = yield* GithubClaims.consumeFlow({
            id: flow.id,
            companyId: input.companyId,
            userId: input.userId
          });
          for (const id of [...new Set([display.installationId, installationId])].sort(
            (a, b) => a - b
          ))
            yield* GithubClaims.lock(id);
          yield* GithubClaims.claim({
            installationId,
            companyId: input.companyId,
            account: inspected.account.login,
            exempt: githubExempt(inspected.account, who)
          });
          yield* lock(input, current);
          const revision = current.metadataRevision + 1;
          const encrypted = yield* githubSeal(input, {
            installationId,
            repositoryIds: inspected.repositories.map((item) => item.id)
          });
          yield* writeSnapshot(
            input,
            revision,
            githubMetadata(inspected.account, inspected.repositories),
            now
          );
          yield* sql`UPDATE connections SET status = 'connected', metadata_revision = ${revision},
              display = ${githubDisplay(
                {
                  installationId,
                  account: inspected.account,
                  repositories: githubSet(inspected.repositories)
                },
                1
              )},
              credentials = ${encrypted.credentials}, key_id = ${encrypted.keyId},
              credential_revision = credential_revision + 1,
              last_tested_at = to_timestamp(${now / 1_000}),
              last_discovered_at = to_timestamp(${now / 1_000})
              WHERE id = ${input.id} AND company_id = ${input.companyId}`;
          if (installationId !== display.installationId)
            yield* GithubClaims.release({
              installationId: display.installationId,
              companyId: input.companyId,
              except: input.id
            });
          return { held, saved: yield* get(input.companyId, input.id) };
        })
      );
      yield* githubAccess.forget(input.id);
      return saved;
    });

    /** Add, Remove or Reconnect, as the connection's dialogs submit them. */
    const githubChange = Effect.fn("ConnectionStore.githubChange")(function* (
      input: CredentialsInput,
      current: StoredGithub
    ) {
      const change = yield* GithubConnection.parseChange(input.credentials);
      return change.action === "reconnect"
        ? yield* githubReconnect(input, current)
        : yield* githubRepositories(input, current, change);
    });

    const connect = Effect.fn("ConnectionStore.connect")(
      function* (input: ConnectInput, report?: (connection: Connection) => Effect.Effect<void>) {
        if (!Companies.isHandle(input.handle)) return yield* new InvalidConnectionHandle({});
        if (!isDescription(input.description)) return yield* new InvalidConnectionDescription({});
        if (input.integration === "pidgeon") return yield* pidgeonConnect(input, report);
        if (input.integration === "attio") return yield* attioConnect(input, report);
        if (input.integration === "imap") return yield* imapConnect(input, report);
        if (input.integration === "github") return yield* githubConnect(input, report);
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

    const rotate = Effect.fn("ConnectionStore.rotate")(
      function* (input: CredentialsInput) {
        const current = yield* stored(input);
        if (current.integration === "models") return yield* notFound(input);
        if (current.integration === "pidgeon") return yield* pidgeonChange(input, current);
        if (current.integration === "attio") return yield* attioReplace(input, current);
        if (current.integration === "imap") return yield* imapReplace(input, current);
        if (current.integration === "github") return yield* githubChange(input, current);
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

    const test = Effect.fn("ConnectionStore.test")(
      function* (input: Identity) {
        const current = yield* stored(input);
        if (current.integration === "models") return yield* notFound(input);
        if (current.integration === "pidgeon") return yield* pidgeonTest(input, current);
        if (current.integration === "attio") return yield* attioTest(input, current);
        if (current.integration === "imap") return yield* imapTest(input, current);
        if (current.integration === "github") return yield* githubTest(input);
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
    const discover = Effect.fn("ConnectionStore.discover")(function* (
      input: Identity,
      credentials?: Redacted.Redacted<string>
    ) {
      const current = yield* stored(input);
      if (current.integration === "models") return yield* notFound(input);
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
      // Another account is another connection.
      if (current.integration === "github") {
        if (credentials !== undefined) return yield* new ConnectionRetargetUnavailable({});
        if (current.status !== "connected") return yield* new ConnectionNotConnected({});
        return yield* githubRefresh(input);
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
            if (current.integration === "models") return yield* notFound(input);
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
        if (current.integration === "models") return yield* notFound(input);
        if (current.status === "connected") return yield* get(input.companyId, input.id);
        // The key was kept, so reconnecting needs no admin key: only a check that it still works.
        if (current.integration === "pidgeon")
          yield* withPidgeon(PidgeonKeys.test(yield* secretOf(current), current.display));
        else if (current.integration === "attio") return yield* attioReconnect(input, current);
        else if (current.integration === "imap") return yield* imapReconnect(input, current);
        else if (current.integration === "github") return yield* githubResume(input);
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
     * Delete runs to its end even when its request is interrupted, so a GitHub connection's
     * installation access is forgotten once its row is gone. A Pidgeon connection's key stays
     * valid in Pidgeon: Patchy can't revoke it, so its page tells the admin to.
     */
    const remove = Effect.fn("ConnectionStore.delete")(
      (input: Identity, report?: (connection: Connection) => Effect.Effect<void>) =>
        detached(
          Effect.gen(function* () {
            const connection = yield* reportedTransaction(
              Effect.gen(function* () {
                // A GitHub connection's installation row is locked before the connection, as
                // every claim and release does.
                const peek = yield* connectionRow({ ...input, locked: false });
                const installationId =
                  Option.isSome(peek) && peek.value.integration === "github"
                    ? peek.value.display.installationId
                    : undefined;
                if (installationId !== undefined)
                  yield* GithubClaims.lock(installationId).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql)
                  );
                const connection = yield* lock(input);
                if (connection.integration === "models") return yield* notFound(input);
                // A Reconnect between the read and the lock moved it to an installation whose row
                // this attempt never locked: refused, and a retry locks the one it names now.
                if (
                  connection.integration === "github" &&
                  connection.display.installationId !== installationId
                )
                  return yield* new ConnectionChanged({});
                const references = yield* sql`SELECT 1 FROM ${declarations(input.companyId)}
                AND declaration.value->>'id' = ${input.id} LIMIT 1`;
                if (references.length !== 0) return yield* new ConnectionInUse({});
                yield* sql`DELETE FROM connections WHERE id = ${input.id} AND company_id = ${input.companyId}`;
                if (connection.integration === "github")
                  yield* GithubClaims.release({
                    installationId: connection.display.installationId,
                    companyId: input.companyId,
                    except: input.id
                  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
                return connection;
              }),
              report
            );
            if (connection.integration === "github") yield* githubAccess.forget(input.id);
            const deleted: ConnectionStore.Deleted = { connection };
            return deleted;
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

    // The ledger of Pidgeon sends (`pidgeon/Ledger.ts`), over this store's database.
    const ledger = <A>(effect: Effect.Effect<A, SqlError, SqlClient.SqlClient>) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchTags({
          SqlError: (cause) =>
            Effect.fail(
              new ConnectionStorageFailed({ operation: "drafts", cause: Redacted.make(cause) })
            )
        })
      );
    const claimDraft: ConnectionStore.ConnectionStore["Service"]["claimDraft"] = (input) =>
      ledger(PidgeonLedger.claim(input));
    const recordDraft: ConnectionStore.ConnectionStore["Service"]["recordDraft"] = (change) =>
      ledger(PidgeonLedger.record(change));
    const releaseDraft: ConnectionStore.ConnectionStore["Service"]["releaseDraft"] = (key) =>
      ledger(PidgeonLedger.release(key));
    const readDraft: ConnectionStore.ConnectionStore["Service"]["readDraft"] = (key) =>
      ledger(PidgeonLedger.read(key));
    const unsettledSends: ConnectionStore.ConnectionStore["Service"]["unsettledSends"] = (
      companyId,
      id
    ) => ledger(PidgeonLedger.unsettled(companyId, id));
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

    // ---------- Models: providers, and the roles mapped to them ----------

    const providerColumns = sql`p.id, p.company_id AS "companyId", p.integration, p.handle, p.status,
      p.credential_revision AS "credentialRevision", p.created_by AS "createdBy"`;
    const providerRows = SqlSchema.findAll({
      Request: Schema.String,
      Result: ModelProvider,
      execute: (companyId) => sql`SELECT ${providerColumns} FROM connections p
        WHERE p.company_id = ${companyId} AND ${knownProvider} ORDER BY p.integration, p.handle`
    });
    const providerRow = SqlSchema.findOneOption({
      Request: Lookup,
      Result: ModelProvider,
      execute: ({ companyId, id, locked }) => sql`SELECT ${providerColumns} FROM connections p
        WHERE p.company_id = ${companyId} AND p.id = ${id} AND ${knownProvider}
        ${locked ? sql`FOR UPDATE` : sql``}`
    });
    /**
     * Live patches whose current version declares the role, or a role on the provider, by name;
     * with `connected`, only the provider's roles that aren't paused themselves.
     */
    const affectedRows = SqlSchema.findAll({
      Request: Schema.Struct({
        companyId: Schema.String,
        id: Schema.String,
        provider: Schema.Boolean,
        connected: Schema.Boolean
      }),
      Result: Schema.Struct({ name: Schema.String }),
      execute: ({ companyId, id, provider, connected }) => sql`SELECT DISTINCT p.name
        FROM ${declarations(companyId)} AND ${live} AND v.id = p.current_version_id
          AND declaration.value->>'id' IN ${
            provider
              ? sql`(SELECT r.connection_id FROM model_roles r
                  ${connected ? sql`JOIN connections role ON role.id = r.connection_id AND role.status = 'connected'` : sql``}
                  WHERE r.company_id = ${companyId} AND r.provider_id = ${id})`
              : sql`(${id})`
          }
        ORDER BY p.name`
    });
    const providerOf = Effect.fn("ConnectionStore.providerOf")(function* (
      input: { readonly companyId: string; readonly id: string },
      locked = false
    ) {
      const found = yield* providerRow({ ...input, locked });
      if (Option.isNone(found)) return yield* notFound(input);
      return found.value;
    });
    /** A role by id, or undefined when the id names anything else. */
    const roleOf = Effect.fn("ConnectionStore.roleOf")(function* (
      input: { readonly companyId: string; readonly id: string },
      locked = false
    ) {
      const found = yield* connectionRow({ ...input, locked });
      const row = Option.getOrUndefined(found);
      return row?.integration === "models" ? row : undefined;
    });

    const providers = Effect.fn("ConnectionStore.providers")(
      function* (companyId: string) {
        if (!models) return yield* new ModelsUnavailable({});
        return yield* providerRows(companyId);
      },
      Effect.catchTags(safe("providers"))
    );
    const providerSecret = SqlSchema.findOneOption({
      Request: Schema.Struct({ companyId: Schema.String, id: Schema.String }),
      Result: Schema.Struct({
        ...ModelProvider.fields,
        credentials: Schema.String,
        keyId: Schema.String
      }),
      execute: ({
        companyId,
        id
      }) => sql`SELECT ${providerColumns}, p.credentials, p.key_id AS "keyId"
        FROM connections p WHERE p.company_id = ${companyId} AND p.id = ${id} AND ${knownProvider}`
    });
    const modelCall = Effect.fn("ConnectionStore.modelCall")(
      function* (input: {
        readonly companyId: string;
        readonly patchId: string;
        readonly roleId: string;
        readonly key: boolean;
      }) {
        if (!models) return yield* new ModelsUnavailable({});
        // One snapshot for every read, so the role, its provider, the owner's authority and the
        // key agree with each other however changes land around it.
        const read = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
            const found = yield* connectionRow({
              companyId: input.companyId,
              id: input.roleId,
              locked: false
            });
            if (Option.isNone(found) || found.value.integration !== "models")
              return yield* notFound({ companyId: input.companyId, id: input.roleId });
            const role = found.value;
            const stored = input.key
              ? Option.getOrUndefined(
                  yield* providerSecret({ companyId: input.companyId, id: role.role.providerId })
                )
              : undefined;
            const provider =
              stored ??
              Option.getOrUndefined(
                yield* providerRow({
                  companyId: input.companyId,
                  id: role.role.providerId,
                  locked: false
                })
              );
            const owner = yield* ownerCanUse(input.companyId, input.patchId, input.roleId).pipe(
              Effect.catchTags({ ConnectionNotFound: () => Effect.succeed(false) })
            );
            return { role, provider, stored, owner };
          })
        );
        const key =
          read.stored === undefined ? undefined : yield* keys.decrypt(read.stored, read.stored);
        return {
          role: read.role,
          provider:
            read.provider === undefined
              ? undefined
              : {
                  id: read.provider.id,
                  companyId: read.provider.companyId,
                  integration: read.provider.integration,
                  handle: read.provider.handle,
                  status: read.provider.status,
                  credentialRevision: read.provider.credentialRevision,
                  createdBy: read.provider.createdBy
                },
          ownerCanUse: read.owner,
          ...(key === undefined ? {} : { key })
        } satisfies ConnectionStore.ModelCall;
      },
      Effect.catchTags(safe("models"))
    );
    const connectProvider = Effect.fn("ConnectionStore.connectProvider")(
      function* (input: ConnectionStore.ProviderInput, report?: ConnectionStore.ModelsReport) {
        if (!providerKinds.includes(input.provider)) return yield* new ModelsUnavailable({});
        const handle = input.handle ?? "main";
        if (!Companies.isHandle(handle)) return yield* new InvalidConnectionHandle({});
        const id = yield* cryptography.internalId("conn");
        const encrypted = yield* keys.encrypt(
          { companyId: input.companyId, id, integration: input.provider },
          input.credentials
        );
        // A provider has no description, audience or guest setting of its own: its roles do.
        return yield* reportedTransaction(
          Effect.gen(function* () {
            const inserted = yield* sql`INSERT INTO connections
              (id, company_id, integration, handle, description, mode, status, display, credentials,
                key_id, credential_revision, metadata_revision, created_by)
              VALUES (${id}, ${input.companyId}, ${input.provider}, ${handle}, '', 'company',
                'connected', '{}', ${encrypted.credentials}, ${encrypted.keyId}, 1, 1, ${input.userId})
              ON CONFLICT DO NOTHING RETURNING id`;
            if (inserted.length === 0) return yield* new ConnectionHandleTaken({});
            return yield* providerOf({ companyId: input.companyId, id });
          }),
          (provider) =>
            report === undefined
              ? Effect.void
              : report({
                  id: provider.id,
                  integration: provider.integration,
                  change: "connected",
                  affected: []
                })
        );
      },
      Effect.catchTags(safe("providers"))
    );
    const createRole = Effect.fn("ConnectionStore.createRole")(
      function* (input: ConnectionStore.RoleInput, report?: ConnectionStore.ModelsReport) {
        if (!models) return yield* new ModelsUnavailable({});
        if (!Companies.isHandle(input.handle)) return yield* new InvalidConnectionHandle({});
        if (!isDescription(input.description)) return yield* new InvalidConnectionDescription({});
        if (!Models.isModelId(input.model)) return yield* new InvalidModelId({});
        const identity = { ...input, id: yield* cryptography.internalId("conn") };
        const now = yield* Clock.currentTimeMillis;
        return yield* reportedTransaction(
          Effect.gen(function* () {
            // Its provider's lock keeps it from being deleted while the role is made.
            yield* providerOf({ companyId: input.companyId, id: input.providerId }, true);
            // A role holds no credential; its provider does.
            const inserted = yield* sql`INSERT INTO connections
              (id, company_id, integration, handle, description, mode, status, display, credentials,
                key_id, credential_revision, metadata_revision, created_by)
              VALUES (${identity.id}, ${input.companyId}, 'models', ${input.handle},
                ${input.description}, 'company', 'connected', '{}', '', '', 1, 1, ${input.userId})
              ON CONFLICT DO NOTHING RETURNING id`;
            if (inserted.length === 0) return yield* new ConnectionHandleTaken({});
            yield* sql`INSERT INTO model_roles (connection_id, company_id, kind, provider_id, model)
              VALUES (${identity.id}, ${input.companyId}, ${input.kind}, ${input.providerId},
                ${input.model})`;
            yield* writeSnapshot(
              identity,
              1,
              { integration: "models", snapshot: { version: 1, kind: input.kind } },
              now
            );
            const role = yield* roleOf(identity);
            if (role === undefined) return yield* notFound(identity);
            return role;
          }),
          (role) =>
            report === undefined
              ? Effect.void
              : report({ id: role.id, integration: "models", change: "created", affected: [] })
        );
      },
      Effect.catchTags(safe("models"))
    );
    const past = {
      pause: "paused",
      resume: "resumed",
      delete: "deleted",
      replaceKey: "key_replaced",
      remap: "remapped"
    } as const satisfies Record<ConnectionStore.ModelsChange["kind"], string>;
    const changeModels = Effect.fn("ConnectionStore.changeModels")(
      function* (
        input: Identity & { readonly change: ConnectionStore.ModelsChange },
        report?: ConnectionStore.ModelsReport
      ) {
        if (!models) return yield* new ModelsUnavailable({});
        const change = input.change;
        if (change.kind === "remap" && !Models.isModelId(change.model))
          return yield* new InvalidModelId({});
        // A new key is sealed before any lock is held, bound to its provider's integration.
        const encrypted =
          change.kind === "replaceKey"
            ? yield* keys.encrypt(
                { ...input, integration: (yield* providerOf(input)).integration },
                change.credentials
              )
            : undefined;
        const where = sql`WHERE id = ${input.id} AND company_id = ${input.companyId}`;
        const outcome = yield* reportedTransaction(
          Effect.gen(function* () {
            // A statement that waited on the role's lock reads its mapping as it stood before the
            // wait, so the role is read again once locked.
            const role =
              (yield* roleOf(input, true)) === undefined ? undefined : yield* roleOf(input);
            const record: ConnectionStore.ModelsConnection | ConnectionStore.ModelProvider =
              role ?? (yield* providerOf(input, true));
            const affected = (connected = false) =>
              affectedRows({ ...input, provider: role === undefined, connected }).pipe(
                Effect.map((rows) => rows.map((row) => row.name))
              );
            const changed = (affected: ReadonlyArray<string>): ConnectionStore.ModelsChanged => ({
              id: record.id,
              integration: record.integration,
              change: past[change.kind],
              affected
            });
            // A change to the state it already has reaches no one.
            const unchanged = () => ({ changed: changed([]), reported: false });
            switch (change.kind) {
              case "pause":
              case "resume": {
                const status = change.kind === "pause" ? "disconnected" : "connected";
                if (record.status === status) return unchanged();
                // It names the patches whose role it makes unavailable or available again. A
                // provider's own pause or resume reaches no role paused itself, and a role's
                // reaches its patches only while its provider serves them. The provider's lock,
                // shared, keeps its own change from landing between this read and the commit.
                const serves =
                  role === undefined ||
                  (yield* sql<{ readonly status: string }>`SELECT p.status FROM connections p
                    WHERE p.company_id = ${input.companyId} AND p.id = ${role.role.providerId}
                      AND ${knownProvider} FOR SHARE`)[0]?.status === "connected";
                yield* sql`UPDATE connections SET status = ${status},
                  credential_revision = credential_revision + 1 ${where}`;
                return {
                  changed: changed(serves ? yield* affected(role === undefined) : []),
                  reported: true
                };
              }
              case "replaceKey":
                // Only a provider holds a key; a paused one stays paused.
                if (role !== undefined || encrypted === undefined) return yield* notFound(input);
                yield* sql`UPDATE connections SET credentials = ${encrypted.credentials},
                  key_id = ${encrypted.keyId}, credential_revision = credential_revision + 1 ${where}`;
                break;
              case "remap": {
                if (role === undefined) return yield* notFound(input);
                // Both providers' locks, in id order: the one it joins can't be deleted while it
                // moves, and a change to either, such as a pause naming whom it stops, sees the
                // move whole. A provider's own changes take no role's lock.
                for (const id of [...new Set([role.role.providerId, change.providerId])].sort())
                  if (id === change.providerId)
                    yield* providerOf({ companyId: input.companyId, id }, true);
                  else
                    yield* sql`SELECT 1 FROM connections
                      WHERE company_id = ${input.companyId} AND id = ${id} FOR UPDATE`;
                if (role.role.providerId === change.providerId && role.role.model === change.model)
                  return unchanged();
                yield* sql`UPDATE model_roles SET provider_id = ${change.providerId},
                  model = ${change.model} WHERE connection_id = ${input.id}`;
                yield* sql`UPDATE connections SET credential_revision = credential_revision + 1 ${where}`;
                break;
              }
              case "delete": {
                if (role !== undefined) {
                  const declared = yield* sql`SELECT 1 FROM ${declarations(input.companyId)}
                    AND declaration.value->>'id' = ${input.id} LIMIT 1`;
                  if (declared.length !== 0) return yield* new ConnectionInUse({});
                } else {
                  // Every role making or moving to it holds its lock first, so none slips in here.
                  const roles = yield* sql<{ readonly handle: string }>`SELECT c.handle
                    FROM model_roles r JOIN connections c ON c.id = r.connection_id
                    WHERE r.company_id = ${input.companyId} AND r.provider_id = ${input.id}
                    ORDER BY c.handle`;
                  if (roles.length !== 0)
                    return yield* new ProviderInUse({ roles: roles.map((row) => row.handle) });
                }
                // A role's mapping and team grants go with it; its snapshots stay.
                yield* sql`DELETE FROM connections ${where}`;
                return { changed: changed([]), reported: true };
              }
            }
            return { changed: changed(yield* affected()), reported: true };
          }),
          (outcome) =>
            outcome.reported && report !== undefined ? report(outcome.changed) : Effect.void
        );
        return outcome.changed;
      },
      Effect.catchTags(safe("models"))
    );

    return ConnectionStore.ConnectionStore.of({
      integrations: readable,
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
      claimDraft,
      recordDraft,
      releaseDraft,
      readDraft,
      unsettledSends,
      sends,
      pauseLogin,
      providers,
      modelCall,
      connectProvider,
      createRole,
      changeModels
    });
  });

export const layer = Layer.effect(ConnectionStore.ConnectionStore, make);

/**
 * By team, how many model roles name it in their audience. While Models is off no page lists a
 * role, but its grant still keeps the team, so a refused delete can say what does.
 */
export const modelRoleTeamGrants = Effect.fn("ConnectionStore.modelRoleTeamGrants")(function* (
  companyId: string
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly teamId: string; readonly count: number }>`SELECT
      g.team_id AS "teamId", count(*)::int AS count
    FROM connection_team_grants g JOIN connections c ON c.id = g.connection_id
    WHERE g.company_id = ${companyId} AND c.integration = 'models'
    GROUP BY g.team_id`;
  return new Map(rows.map((row) => [row.teamId, row.count] as const));
});

/**
 * Every connection of the `known` integrations, a store's own, whose audience names teams, with
 * those teams.
 */
export const teamConnections = Effect.fn("ConnectionStore.teamConnections")(function* (
  companyId: string,
  known: ReadonlyArray<Integration>
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly id: string;
    readonly integration: string;
    readonly handle: string;
    readonly teamIds: readonly string[];
  }>`SELECT c.id, c.integration, c.handle, array_agg(g.team_id ORDER BY g.team_id) AS "teamIds"
    FROM connection_team_grants g JOIN connections c ON c.id = g.connection_id
    WHERE g.company_id = ${companyId} AND c.integration IN ${sql.in(known)}
    GROUP BY c.id, c.integration, c.handle ORDER BY c.integration, c.handle`;
});
