/**
 * Patches and their versions: every row the capability keeps, read and
 * written here and nowhere else. Rows are decoded through `SqlSchema` in this
 * module only, so a client type change lands in one place.
 *
 * The retention clock lives in these queries. Every patch carries one expiry
 * anchor and three rules act on it: a publish resets the anchor to the full
 * retention window; a visit with less than the visit-extension window
 * remaining moves the anchor to exactly that window out — never shorter,
 * never reviving an expired patch; the clock check is `expires_at < now`, and
 * nothing else. Visits top up the clock regardless of the creating machine
 * token's state.
 *
 * The clock is Effect's, read as `Clock.currentTimeMillis`, so a test winds
 * retention and pending-object leases. Audit stamps (`created_at`,
 * `updated_at`, `deleted_at`, `disabled_at`) stay on SQL `now()`.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type * as Statement from "effect/unstable/sql/Statement";
import {
  Manifest,
  PatchInventory,
  PatchName,
  PublishCreated,
  PublishUpdated,
  SharingScope,
  TableDefinition,
  sharedTableId
} from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { Tables } from "@patchy/primitives";

const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));
const encodePublishCreated = Schema.encodeSync(Schema.fromJsonString(PublishCreated));
const encodePublishUpdated = Schema.encodeSync(Schema.fromJsonString(PublishUpdated));
const decodeResponseBodies = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ responseBody: Schema.String }))
);

/** The window a publish gives a patch. */
export const RETENTION_WINDOW = Duration.days(90);

/** What a visit tops the remaining time up to, when less than this remains. */
export const VISIT_EXTENSION_WINDOW = Duration.days(30);

/** Allows the bounded put and 60-second record transaction to finish before reclamation. */
export const PENDING_OBJECT_LEASE = Duration.minutes(5);

/** The first publish starts a patch's version sequence. */
const FIRST_VERSION_NUMBER = 1;

const isName = Schema.is(PatchName);

/** A title or extension-free filename, normalized and bounded for this collision ordinal. */
export const deriveName = (source: string, ordinal = 1): string => {
  const normalized = source
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = ordinal === 1 ? "" : `-${ordinal}`;
  const base = (normalized.length < 3 ? "patch" : normalized)
    .slice(0, 32 - suffix.length)
    .replace(/-+$/, "");
  const candidate = `${base}${suffix}`;
  return isName(candidate) ? candidate : `patch${suffix}`;
};

/** An absolute address is independent of the patch's current sharing scope. */
export const address = (publicBaseUrl: string, companyHandle: string, name: string) =>
  `${publicBaseUrl.replace(/\/+$/, "")}/${companyHandle}/${name}`;

/**
 * A write named a patch the caller cannot write: unknown, another
 * user's, deleted, disabled or expired. One refusal for all five, so the
 * answer never says which.
 */
export class PatchUnavailable extends Schema.TaggedError<PatchUnavailable>()("PatchUnavailable", {
  patchId: Schema.String
}) {
  override get message() {
    return "Patch not found.";
  }
}

/** A create landed on an id that already exists. */
export class PatchConflict extends Schema.TaggedError<PatchConflict>()("PatchConflict", {
  patchId: Schema.String
}) {
  override get message() {
    return "Patch already exists.";
  }
}

export class NameTaken extends Schema.TaggedError<NameTaken>()("NameTaken", {
  name: PatchName
}) {
  override get message() {
    return `Patch name "${this.name}" is already taken.`;
  }
}

export interface Patch {
  readonly id: string;
  readonly companyId: string;
  readonly companyHandle: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly scope: typeof SharingScope.Type;
  readonly title: string;
  readonly currentVersionId: string | null;
  readonly repoOrg: string | null;
  readonly repoName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The retention clock's anchor: expired once this is past. */
  readonly expiresAt: string;
  readonly deletedAt: string | null;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
}

export interface PatchVersion {
  readonly id: string;
  readonly patchId: string;
  readonly versionNumber: number;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly createdByMachineTokenId: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly cliVersion: string | null;
  readonly gitBranch: string | null;
  readonly gitCommitSha: string | null;
  readonly originalFilename: string | null;
  readonly createdAt: string;
  readonly tier: number;
  readonly release: string;
  readonly manifestVersion: number;
  readonly wireVersion: number;
  readonly schemaRevision: number;
  readonly manifest: typeof Manifest.Type;
  readonly publishKey: string;
  readonly payloadDigest: string;
}

export class PublishKeyTaken extends Schema.TaggedError<PublishKeyTaken>()("PublishKeyTaken", {
  ownerUserId: Schema.String,
  /** The arbitrary client-supplied key is summarized, never echoed. */
  publishKey: Schema.Struct({ length: Schema.Int })
}) {
  override get message() {
    return `Publish key (${this.publishKey.length} characters) already recorded for owner ${this.ownerUserId}.`;
  }
}
export class PatchQuotaReached extends Schema.TaggedError<PatchQuotaReached>()(
  "PatchQuotaReached",
  {
    quota: Schema.Int
  }
) {
  override get message() {
    return `Patch quota reached: ${this.quota} live patches per user.`;
  }
}

/** The sweep already owns these bytes, or their publication lease has elapsed. */
export class PendingObjectExpired extends Schema.TaggedError<PendingObjectExpired>()(
  "PendingObjectExpired",
  { objectKey: Schema.String }
) {
  override get message() {
    return `Publication lease expired for ${this.objectKey}.`;
  }
}

export class HasPrimitives extends Schema.TaggedError<HasPrimitives>()("HasPrimitives", {
  patchId: Schema.String
}) {
  readonly code = "has_primitives";
  override get message() {
    return "This patch has provisioned tables or file stores; publish from its repo instead of a single HTML file.";
  }
}

/** A declaration never reveals whether its source is missing, private or unshared. */
export class PatchNotOpenable extends Schema.TaggedError<PatchNotOpenable>()("PatchNotOpenable", {
  patchId: Schema.String,
  table: Schema.String
}) {
  readonly code = "patch_not_openable" as const;
  override get message() {
    return `Shared table ${this.patchId}/${this.table} is not openable.`;
  }
}

export interface SharedTable {
  readonly id: string;
  readonly patchId: string;
  readonly table: string;
  readonly schemaRevision: number;
  readonly definition: typeof TableDefinition.Type;
}

export type DatabaseError =
  | CompanyDatabases.Busy
  | CompanyDatabases.CompanyDatabaseError
  | CompanyDatabases.CompanyDatabaseNotReady
  | CompanyDatabases.CompanyIdentityMismatch;

export type ResourceError = HasPrimitives | PatchNotOpenable | Tables.NotAdditive | DatabaseError;

export interface PublishTarget {
  readonly intent: "create" | "update";
  readonly patchId: string;
  readonly ownerUserId: string;
}

export interface PublishPreflight extends PublishTarget {
  readonly companyId: string;
  readonly manifest: typeof Manifest.Type;
  readonly filename: string | null;
}

const hasOwnedDefinitions = (manifest: typeof Manifest.Type) =>
  Object.keys(manifest.tables).length > 0 || Object.keys(manifest.files).length > 0;

/** File requests may carry --name; empty named repo manifests are not file requests. */
const isFileMode = (input: PublishPreflight) =>
  !hasOwnedDefinitions(input.manifest) &&
  (input.filename !== null ||
    (Object.keys(input.manifest.uses).length === 0 && input.manifest.name === undefined));

export interface RecordInput extends PublishTarget {
  readonly companyId: string;
  readonly versionId: string;
  readonly machineTokenId: string;
  /** Omitted creates are company-scoped; omitted updates retain the scope under the row lock. */
  readonly scope?: Patch["scope"] | undefined;
  readonly title: string;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly filename: string | null;
  readonly repoOrg: string | null;
  readonly repoName: string | null;
  readonly cliVersion: string | null;
  readonly gitBranch: string | null;
  readonly gitCommitSha: string | null;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly manifest: typeof Manifest.Type;
  readonly wireVersion: number;
  readonly publishKey: string;
  readonly payloadDigest: string;
  readonly publicBaseUrl: string;
  readonly warnings: ReadonlyArray<string>;
  readonly livePatchQuota?: number;
}

export interface Recorded extends PublishUpdated {
  readonly status: 200 | 201;
  /** PostgreSQL's persisted JSONB representation, sent unchanged on the wire. */
  readonly responseBody: string;
}

const Replay = Schema.Struct({
  payloadDigest: Schema.String,
  response: Schema.JsonObject,
  body: Schema.String,
  status: Schema.Literals([200, 201])
});

export class Patches extends Context.Service<
  Patches,
  {
    /**
     * How many patches this user owns that are still live — neither
     * deleted nor disabled. The durable half of the patch quota: recounted
     * from the database on every create, so a restart cannot reset it. An
     * expired patch still counts until the sweep takes its row.
     */
    readonly countLive: (ownerUserId: string) => Effect.Effect<number, SqlError>;
    readonly replay: (
      ownerUserId: string,
      publishKey: string
    ) => Effect.Effect<Option.Option<typeof Replay.Type>, SqlError>;
    /**
     * The publish contract's preflight, before any bytes are written: an
     * update needs a patch the caller may write, a create needs a free id.
     */
    readonly preflight: (
      input: PublishPreflight
    ) => Effect.Effect<
      void,
      PatchUnavailable | PatchConflict | NameTaken | ResourceError | SqlError
    >;
    readonly inventory: (
      patchId: string,
      ownerUserId: string
    ) => Effect.Effect<PatchInventory, PatchUnavailable | DatabaseError | SqlError>;
    /** Cumulative metadata from live same-company shared inventory. */
    readonly sharedTable: (
      patchId: string,
      table: string,
      companyId: string
    ) => Effect.Effect<SharedTable, PatchNotOpenable | DatabaseError | SqlError>;
    /** Durably reserves a fresh object key before any bytes can be written. */
    readonly prepareObject: (objectKey: string) => Effect.Effect<void, SqlError>;
    /**
     * Fences expired, unreferenced objects against publication. Claimed rows
     * remain eligible until deletion succeeds, so interrupted sweeps retry.
     */
    readonly claimObjects: (limit: number) => Effect.Effect<ReadonlyArray<string>, SqlError>;
    /** Forgets a claimed object only after its bytes have been deleted. */
    readonly completeObject: (objectKey: string) => Effect.Effect<void, SqlError>;
    /**
     * Records a publish whose bytes are already stored: the version row, the
     * patch row it creates or moves forward, and a fresh retention window,
     * in one transaction. Consumes the pending-object intent under a lock;
     * a sweep that claimed it first prevents the version from being recorded.
     * Re-checks the target, so the preflight's answer can still change here.
     */
    readonly record: (
      input: RecordInput
    ) => Effect.Effect<
      Recorded,
      | PatchUnavailable
      | PatchConflict
      | NameTaken
      | PublishKeyTaken
      | PatchQuotaReached
      | PendingObjectExpired
      | ResourceError
      | SqlError
    >;
    /** Changes an owned, available patch's audience without publishing or extending retention. */
    readonly setScope: (
      patchId: string,
      ownerUserId: string,
      scope: Patch["scope"]
    ) => Effect.Effect<
      { scope: Patch["scope"]; name: string; companyHandle: string },
      PatchUnavailable | SqlError
    >;
    /** A current name or a redirect to the destination patch's current name. */
    readonly resolveName: (
      companyHandle: string,
      name: string
    ) => Effect.Effect<
      Option.Option<{ patchId: string; name: string; current: boolean }>,
      SqlError
    >;
    /**
     * A patch in service and one of its versions — the current one, or the
     * numbered one asked for. Deleted, disabled and expired patches are
     * absent here, exactly as an unknown id is.
     */
    readonly find: (
      patchId: string,
      versionNumber?: number,
      versionId?: string
    ) => Effect.Effect<Option.Option<{ patch: Patch; version: PatchVersion }>, SqlError>;
    /**
     * Tops a served patch's clock up to the visit-extension window when less
     * than that remains. A no-op otherwise, including for a patch already
     * expired, deleted or disabled.
     */
    readonly recordVisit: (patchId: string) => Effect.Effect<void, SqlError>;
    /**
     * Ids the sweep may take right now — expired, the longest-expired first —
     * capped at `limit`. Deleted and disabled patches are included: the
     * sweep is what finally frees their storage.
     */
    readonly listExpired: (limit: number) => Effect.Effect<ReadonlyArray<string>, SqlError>;
    /**
     * Hard-deletes one expired patch and queues its version keys durably for
     * object deletion in the same transaction. Returns those keys for the
     * expiry event. `None` when the patch is no longer the sweep's to take:
     * already gone, or no longer expired.
     */
    readonly deleteExpired: (
      patchId: string
    ) => Effect.Effect<Option.Option<ReadonlyArray<string>>, SqlError>;
    /** Soft-deletes an owned patch; the row and its bytes go with the next sweep. `false` when unavailable. */
    readonly delete: (patchId: string, ownerUserId: string) => Effect.Effect<boolean, SqlError>;
  }
>()("@patchy/patches/Patches") {}

// Today's client hands back a Date; when it becomes epoch ms only these lines move.
const Stamp = Schema.Date;
const NullableStamp = Schema.NullOr(Schema.Date);

class PatchRow extends Schema.Class<PatchRow>("PatchRow")({
  id: Schema.String,
  companyId: Schema.String,
  companyHandle: Schema.String,
  name: PatchName,
  ownerUserId: Schema.String,
  scope: SharingScope,
  title: Schema.String,
  currentVersionId: Schema.NullOr(Schema.String),
  repoOrg: Schema.NullOr(Schema.String),
  repoName: Schema.NullOr(Schema.String),
  createdAt: Stamp,
  updatedAt: Stamp,
  expiresAt: Stamp,
  deletedAt: NullableStamp,
  disabledAt: NullableStamp,
  disabledReason: Schema.NullOr(Schema.String)
}) {}

class VersionRow extends Schema.Class<VersionRow>("VersionRow")({
  id: Schema.String,
  patchId: Schema.String,
  versionNumber: Schema.Int,
  objectKey: Schema.String,
  contentHash: Schema.String,
  fileSize: Schema.Int,
  createdByMachineTokenId: Schema.String,
  sourceIp: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  cliVersion: Schema.NullOr(Schema.String),
  gitBranch: Schema.NullOr(Schema.String),
  gitCommitSha: Schema.NullOr(Schema.String),
  originalFilename: Schema.NullOr(Schema.String),
  tier: Schema.Int,
  release: Schema.String,
  manifestVersion: Schema.Int,
  wireVersion: Schema.Int,
  schemaRevision: Schema.Int,
  manifest: Manifest,
  publishKey: Schema.String,
  payloadDigest: Schema.String,
  createdAt: Stamp
}) {}

class Id extends Schema.Class<Id>("Id")({ id: Schema.String }) {}
class Count extends Schema.Class<Count>("Count")({ count: Schema.Int }) {}
class NextVersion extends Schema.Class<NextVersion>("NextVersion")({ nextVersion: Schema.Int }) {}
class ObjectKey extends Schema.Class<ObjectKey>("ObjectKey")({ objectKey: Schema.String }) {}
class DeclaringPatches extends Schema.Class<DeclaringPatches>("DeclaringPatches")({
  table: Schema.String,
  count: Schema.Int
}) {}
class PatchTargetRow extends Schema.Class<PatchTargetRow>("PatchTargetRow")({
  scope: SharingScope,
  companyId: Schema.String,
  companyHandle: Schema.String,
  name: PatchName
}) {}
class NameRow extends Schema.Class<NameRow>("NameRow")({ name: PatchName }) {}
class ResolvedName extends Schema.Class<ResolvedName>("ResolvedName")({
  patchId: Schema.String,
  name: PatchName,
  current: Schema.Boolean
}) {}
class CompanyHandle extends Schema.Class<CompanyHandle>("CompanyHandle")({
  handle: Schema.String
}) {}
class UnnamedPatch extends Schema.Class<UnnamedPatch>("UnnamedPatch")({
  id: Schema.String,
  companyId: Schema.String,
  title: Schema.String
}) {}

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date === null ? null : date.toISOString());

const toPatch = (row: PatchRow): Patch => ({
  id: row.id,
  companyId: row.companyId,
  companyHandle: row.companyHandle,
  name: row.name,
  ownerUserId: row.ownerUserId,
  scope: row.scope,
  title: row.title,
  currentVersionId: row.currentVersionId,
  repoOrg: row.repoOrg,
  repoName: row.repoName,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  expiresAt: iso(row.expiresAt),
  deletedAt: isoOrNull(row.deletedAt),
  disabledAt: isoOrNull(row.disabledAt),
  disabledReason: row.disabledReason
});

const toVersion = (row: VersionRow): PatchVersion => ({
  id: row.id,
  patchId: row.patchId,
  versionNumber: row.versionNumber,
  objectKey: row.objectKey,
  contentHash: row.contentHash,
  fileSize: row.fileSize,
  createdByMachineTokenId: row.createdByMachineTokenId,
  sourceIp: row.sourceIp,
  userAgent: row.userAgent,
  cliVersion: row.cliVersion,
  gitBranch: row.gitBranch,
  gitCommitSha: row.gitCommitSha,
  originalFilename: row.originalFilename,
  tier: row.tier,
  release: row.release,
  manifestVersion: row.manifestVersion,
  wireVersion: row.wireVersion,
  schemaRevision: row.schemaRevision,
  manifest: row.manifest,
  publishKey: row.publishKey,
  payloadDigest: row.payloadDigest,
  createdAt: iso(row.createdAt)
});

/** A `SchemaError` on a row is a bug in the query or the schema, never a caller's fault. */
const dieOnSchemaError = { SchemaError: Effect.die } as const;

/** The columns of `patches`, aliased to the record's names. */
const PATCH_COLUMNS = `
  patches.id, patches.company_id AS "companyId",
  companies.handle AS "companyHandle", patches.name,
  patches.owner_user_id AS "ownerUserId", patches.scope, patches.title,
  patches.current_version_id AS "currentVersionId",
  patches.repo_org AS "repoOrg", patches.repo_name AS "repoName",
  patches.created_at AS "createdAt", patches.updated_at AS "updatedAt",
  patches.expires_at AS "expiresAt",
  patches.deleted_at AS "deletedAt", patches.disabled_at AS "disabledAt",
  patches.disabled_reason AS "disabledReason"`;

const VERSION_COLUMNS = `
  id, patch_id AS "patchId", version_number AS "versionNumber",
  object_key AS "objectKey", content_hash AS "contentHash", file_size AS "fileSize",
  created_by_machine_token_id AS "createdByMachineTokenId", source_ip AS "sourceIp",
  user_agent AS "userAgent", cli_version AS "cliVersion", git_branch AS "gitBranch",
  git_commit_sha AS "gitCommitSha", original_filename AS "originalFilename",
  tier, release, manifest_version AS "manifestVersion", wire_version AS "wireVersion",
  schema_revision AS "schemaRevision", manifest, publish_key AS "publishKey", payload_digest AS "payloadDigest",
  created_at AS "createdAt"`;

/** Seeds legacy patches' names from titles in creation order, without changing existing claims. */
export const backfillNames = Effect.fn("Patches.backfillNames")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const unnamed = SqlSchema.findAll({
    Request: Schema.Void,
    Result: UnnamedPatch,
    execute: () => sql`
      SELECT patches.id, patches.company_id AS "companyId", patches.title FROM patches
      WHERE patches.deleted_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM patch_names WHERE patch_names.patch_id = patches.id AND patch_names.current
      )
      ORDER BY patches.created_at, patches.id FOR UPDATE OF patches`
  });
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const patch of yield* unnamed(undefined)) {
        // Another seed may have completed while this one waited for the patch row.
        const current =
          yield* sql`SELECT 1 FROM patch_names WHERE patch_id = ${patch.id} AND current`;
        if (current.length > 0) continue;
        const baseName = deriveName(patch.title);
        let ordinal = 1;
        let name = baseName;
        while (true) {
          const claimed = yield* sql`
          INSERT INTO patch_names (company_id, name, patch_id, current)
          VALUES (${patch.companyId}, ${name}, ${patch.id}, true)
          ON CONFLICT (company_id, name) DO UPDATE
          SET patch_id = EXCLUDED.patch_id, current = true
          WHERE NOT patch_names.current
          RETURNING name`;
          if (claimed.length > 0) break;
          name = deriveName(baseName, ++ordinal);
        }
        yield* sql`UPDATE patches SET name = ${name} WHERE id = ${patch.id}`;
      }
    }).pipe(Effect.catchTags(dieOnSchemaError))
  );
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventoryStore = yield* Inventory.Inventory;
  const tables = yield* Tables.Tables;

  /** An instant on the Effect clock, as a value Postgres compares against `expires_at`. */
  const stamp = (millis: number) => sql`to_timestamp(${millis / 1_000})`;
  /** The clock's reading now, as that value. */
  const now = Effect.map(Clock.currentTimeMillis, stamp);

  /**
   * "Not expired" as one predicate: the anchor must not be past. Bound to
   * the clock reading passed in, so every query in one operation reads the
   * same instant.
   */
  const notExpired = (at: Statement.Fragment) => sql`(patches.expires_at >= ${at})`;

  /** A patch in service the user may write: theirs, and neither taken down nor expired. */
  const writable = (patchId: string, ownerUserId: string, at: Statement.Fragment) =>
    sql`patches.id = ${patchId} AND patches.owner_user_id = ${ownerUserId}
        AND patches.deleted_at IS NULL AND patches.disabled_at IS NULL AND ${notExpired(at)}`;

  const countLiveRow = SqlSchema.findOne({
    Request: Schema.String,
    Result: Count,
    execute: (ownerUserId) => sql`
      SELECT count(*)::int AS count
      FROM patches
      WHERE patches.owner_user_id = ${ownerUserId}
        AND patches.deleted_at IS NULL
        AND patches.disabled_at IS NULL`
  });

  const findPatch = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, nowMillis: Schema.Number }),
    Result: PatchRow,
    execute: ({ nowMillis, patchId }) => sql`
      SELECT ${sql.unsafe(PATCH_COLUMNS)}
      FROM patches JOIN companies ON companies.id = patches.company_id
      WHERE patches.id = ${patchId}
        AND patches.deleted_at IS NULL
        AND patches.disabled_at IS NULL
        AND ${notExpired(stamp(nowMillis))}`
  });

  const findVersionByNumber = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, versionNumber: Schema.Number }),
    Result: VersionRow,
    execute: ({ patchId, versionNumber }) => sql`
      SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM patch_versions
      WHERE patch_id = ${patchId} AND version_number = ${versionNumber}`
  });

  const findVersionById = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, versionId: Schema.String }),
    Result: VersionRow,
    execute: ({ patchId, versionId }) => sql`
      SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM patch_versions
      WHERE id = ${versionId} AND patch_id = ${patchId}`
  });

  const resolveNameRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyHandle: Schema.String,
      name: Schema.String,
      nowMillis: Schema.Number
    }),
    Result: ResolvedName,
    execute: ({ companyHandle, name, nowMillis }) => sql`
      SELECT patches.id AS "patchId", patches.name, patch_names.current
      FROM patch_names
      JOIN companies ON companies.id = patch_names.company_id
      JOIN patches ON patches.id = patch_names.patch_id
      WHERE companies.handle = ${companyHandle} AND patch_names.name = ${name}
        AND patches.deleted_at IS NULL AND patches.disabled_at IS NULL
        AND ${notExpired(stamp(nowMillis))}`
  });

  const companyHandleRow = SqlSchema.findOne({
    Request: Schema.String,
    Result: CompanyHandle,
    execute: (companyId) => sql`SELECT handle FROM companies WHERE id = ${companyId}`
  });

  const claimName = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String, name: PatchName }),
    Result: NameRow,
    execute: ({ companyId, patchId, name }) => sql`
      INSERT INTO patch_names (company_id, name, patch_id, current)
      VALUES (${companyId}, ${name}, ${patchId}, true)
      ON CONFLICT (company_id, name) DO UPDATE
      SET patch_id = EXCLUDED.patch_id, current = true
      WHERE NOT patch_names.current
      RETURNING name`
  });

  const listExpiredRows = SqlSchema.findAll({
    Request: Schema.Struct({ nowMillis: Schema.Number, limit: Schema.Number }),
    Result: Id,
    execute: ({ limit, nowMillis }) => sql`
      SELECT id FROM patches
      WHERE NOT ${notExpired(stamp(nowMillis))}
      ORDER BY expires_at ASC
      LIMIT ${limit}`
  });

  const nextVersionNumber = SqlSchema.findOne({
    Request: Schema.String,
    Result: NextVersion,
    execute: (patchId) => sql`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS "nextVersion"
      FROM patch_versions WHERE patch_id = ${patchId}`
  });

  const objectKeysOf = SqlSchema.findAll({
    Request: Schema.String,
    Result: ObjectKey,
    execute: (patchId) =>
      sql`SELECT object_key AS "objectKey" FROM patch_versions WHERE patch_id = ${patchId}`
  });

  const lockTarget = SqlSchema.findOneOption({
    Request: Schema.Struct({
      patchId: Schema.String,
      ownerUserId: Schema.String,
      nowMillis: Schema.Number
    }),
    Result: PatchTargetRow,
    execute: ({ patchId, ownerUserId, nowMillis }) => sql`
      SELECT patches.scope, patches.name, patches.company_id AS "companyId",
        companies.handle AS "companyHandle"
      FROM patches JOIN companies ON companies.id = patches.company_id
      WHERE ${writable(patchId, ownerUserId, stamp(nowMillis))}
      FOR UPDATE OF patches`
  });

  const replayRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ ownerUserId: Schema.String, publishKey: Schema.String }),
    Result: Replay,
    execute: ({ ownerUserId, publishKey }) => sql`
      SELECT payload_digest AS "payloadDigest", publish_response AS response,
        publish_response::text AS body, publish_status AS status
      FROM patch_versions WHERE owner_user_id = ${ownerUserId} AND publish_key = ${publishKey}`
  });
  const replay = Effect.fn("Patches.replay")((ownerUserId: string, publishKey: string) =>
    replayRow({ ownerUserId, publishKey }).pipe(Effect.catchTags(dieOnSchemaError))
  );
  const countLive = Effect.fn("Patches.countLive")((ownerUserId: string) =>
    countLiveRow(ownerUserId).pipe(
      Effect.map((row) => row.count),
      // `count(*)` always answers one row; no row is a bug, not a state.
      Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
    )
  );
  const find = Effect.fn("Patches.find")(function* (
    patchId: string,
    versionNumber?: number,
    versionId?: string
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const patch = yield* findPatch({ patchId, nowMillis });
    if (Option.isNone(patch)) return Option.none();
    const selectedId = versionId ?? patch.value.currentVersionId;
    const version =
      versionId === undefined && versionNumber !== undefined
        ? yield* findVersionByNumber({ patchId, versionNumber })
        : selectedId === null
          ? Option.none()
          : yield* findVersionById({ patchId, versionId: selectedId });
    return Option.map(version, (row) => ({ patch: toPatch(patch.value), version: toVersion(row) }));
  }, Effect.catchTags(dieOnSchemaError));

  const checkTarget = Effect.fn("Patches.checkTarget")(function* (target: PublishTarget) {
    if (target.intent === "update") {
      const rows =
        yield* sql`SELECT 1 FROM patches WHERE ${writable(target.patchId, target.ownerUserId, yield* now)}`;
      if (rows.length === 0) return yield* new PatchUnavailable({ patchId: target.patchId });
      return;
    }
    const rows = yield* sql`SELECT 1 FROM patches WHERE id = ${target.patchId}`;
    if (rows.length > 0) return yield* new PatchConflict({ patchId: target.patchId });
  });

  // Probe without starting a company transaction. A platform version is not
  // evidence of absence: company DDL may have committed before platform failure.
  const readInventory = Effect.fn("Patches.readInventory")((companyId: string, patchId: string) =>
    databases
      .withCompany(companyId)(
        Effect.gen(function* () {
          if (!(yield* inventoryStore.exists(patchId))) return null;
          return yield* inventoryStore.read(patchId);
        })
      )
      .pipe(
        Effect.catchTags({
          CompanyDatabaseNotReady: (error) =>
            error.status === null ? Effect.succeed(null) : Effect.fail(error)
        })
      )
  );

  const sharedTable = Effect.fn("Patches.sharedTable")(function* (
    patchId: string,
    table: string,
    companyId: string
  ) {
    // Never nest platform patch locks: source liveness is read before the company inventory lock.
    const source = yield* find(patchId);
    if (Option.isNone(source) || source.value.patch.companyId !== companyId)
      return yield* new PatchNotOpenable({ patchId, table });
    const snapshot = yield* readInventory(companyId, patchId);
    if (snapshot === null || !snapshot.tables.some((entry) => entry.name === table && entry.shared))
      return yield* new PatchNotOpenable({ patchId, table });
    return {
      id: sharedTableId(patchId, table),
      patchId,
      table,
      schemaRevision: snapshot.schemaRevision,
      definition: Tables.inventoryManifest(snapshot).tables[table]!
    } satisfies SharedTable;
  });

  const resolveDeclarations = Effect.fn("Patches.resolveDeclarations")(function* (
    manifest: typeof Manifest.Type,
    companyId: string
  ) {
    const warnings: string[] = [];
    for (const declaration of Object.values(manifest.uses)) {
      if (declaration.kind !== "sharedTable") continue;
      if (declaration.id !== sharedTableId(declaration.patchId, declaration.table))
        return yield* new PatchNotOpenable({
          patchId: declaration.patchId,
          table: declaration.table
        });
      const source = yield* sharedTable(declaration.patchId, declaration.table, companyId);
      if (declaration.revision < source.schemaRevision)
        warnings.push(
          `Shared table \`${source.id}\`: declared schema revision ${declaration.revision} is behind source schema revision ${source.schemaRevision}.`
        );
    }
    return warnings;
  });

  const declaringPatchRows = SqlSchema.findAll({
    Request: Schema.Struct({
      patchId: Schema.String,
      companyId: Schema.String,
      nowMillis: Schema.Number
    }),
    Result: DeclaringPatches,
    execute: ({ patchId, companyId, nowMillis }) => sql`
      SELECT declaration.value->>'table' AS "table", count(DISTINCT patches.id)::int AS count
      FROM patches
      JOIN patch_versions ON patch_versions.patch_id = patches.id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      WHERE patches.company_id = ${companyId}
        AND patches.deleted_at IS NULL AND patches.disabled_at IS NULL
        AND ${notExpired(stamp(nowMillis))}
        AND declaration.value->>'kind' = 'sharedTable'
        AND declaration.value->>'patchId' = ${patchId}
        AND declaration.value->>'id' = ${patchId} || '/' || (declaration.value->>'table')
      GROUP BY declaration.value->>'table'`
  });

  const preflight = Effect.fn("Patches.preflight")(function* (input: PublishPreflight) {
    yield* checkTarget(input);
    if (input.manifest.name !== undefined) {
      const occupied = yield* sql`
        SELECT 1 FROM patch_names WHERE company_id = ${input.companyId}
          AND name = ${input.manifest.name} AND current AND patch_id <> ${input.patchId}`;
      if (occupied.length > 0) return yield* new NameTaken({ name: input.manifest.name });
    }
    yield* resolveDeclarations(input.manifest, input.companyId);
    if (hasOwnedDefinitions(input.manifest)) {
      yield* databases.ensureReady(input.companyId);
    }
    const { companyId, snapshot } =
      input.intent === "create"
        ? { companyId: input.companyId, snapshot: null }
        : yield* sql.withTransaction(
            Effect.gen(function* () {
              const locked = yield* lockTarget({
                patchId: input.patchId,
                ownerUserId: input.ownerUserId,
                nowMillis: yield* Clock.currentTimeMillis
              });
              if (Option.isNone(locked))
                return yield* new PatchUnavailable({ patchId: input.patchId });
              return {
                companyId: locked.value.companyId,
                snapshot: yield* readInventory(locked.value.companyId, input.patchId)
              };
            }).pipe(Effect.catchTags(dieOnSchemaError))
          );
    if (snapshot !== null && isFileMode(input)) {
      return yield* new HasPrimitives({ patchId: input.patchId });
    }
    yield* tables.diff(input.manifest, snapshot);
    if (snapshot !== null) {
      yield* databases.withCompany(companyId)(
        tables.validate(input.patchId, input.manifest, snapshot)
      );
    }
  });

  const inventory = Effect.fn("Patches.inventory")((patchId: string, ownerUserId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const locked = yield* lockTarget({
          patchId,
          ownerUserId,
          nowMillis: yield* Clock.currentTimeMillis
        });
        if (Option.isNone(locked)) return yield* new PatchUnavailable({ patchId });
        const snapshot = yield* readInventory(locked.value.companyId, patchId);
        return new PatchInventory(
          snapshot === null
            ? { schemaRevision: 0, tables: {}, files: {} }
            : { schemaRevision: snapshot.schemaRevision, ...Tables.inventoryManifest(snapshot) }
        );
      }).pipe(Effect.catchTags(dieOnSchemaError))
    )
  );

  const provision = Effect.fn("Patches.provision")(function* (input: RecordInput) {
    const hasDefinitions = hasOwnedDefinitions(input.manifest);
    if (input.intent === "create" && !hasDefinitions) {
      return yield* tables.diff(input.manifest, null);
    }
    return yield* databases
      .withCompany(input.companyId)(
        Effect.gen(function* () {
          if (!hasDefinitions && !(yield* inventoryStore.exists(input.patchId))) {
            return yield* tables.diff(input.manifest, null);
          }
          return yield* databases.withPatchLock(input.patchId)(
            Effect.gen(function* () {
              if (isFileMode(input)) return yield* new HasPrimitives({ patchId: input.patchId });
              return yield* tables.provision(input.patchId, input.manifest);
            })
          );
        })
      )
      .pipe(
        Effect.catchTags({
          CompanyDatabaseNotReady: (error) =>
            !hasDefinitions && error.status === null
              ? tables.diff(input.manifest, null)
              : Effect.fail(error)
        })
      );
  });

  const prepareObject = Effect.fn("Patches.prepareObject")(function* (objectKey: string) {
    const expiresAt = stamp(
      (yield* Clock.currentTimeMillis) + Duration.toMillis(PENDING_OBJECT_LEASE)
    );
    yield* sql`
      INSERT INTO pending_patch_objects (object_key, expires_at)
      VALUES (${objectKey}, ${expiresAt})`;
  });

  const claimObjectRows = SqlSchema.findAll({
    Request: Schema.Struct({ nowMillis: Schema.Number, limit: Schema.Number }),
    Result: ObjectKey,
    execute: ({ nowMillis, limit }) => sql`
      WITH candidates AS (
        SELECT object_key FROM pending_patch_objects
        WHERE expires_at <= ${stamp(nowMillis)}
          AND NOT EXISTS (
            SELECT 1 FROM patch_versions
            WHERE patch_versions.object_key = pending_patch_objects.object_key
          )
        ORDER BY expires_at, object_key
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE pending_patch_objects SET claimed = true
      FROM candidates
      WHERE pending_patch_objects.object_key = candidates.object_key
      RETURNING pending_patch_objects.object_key AS "objectKey"`
  });
  const claimObjects = Effect.fn("Patches.claimObjects")(function* (limit: number) {
    if (limit <= 0) return [];
    const rows = yield* claimObjectRows({ nowMillis: yield* Clock.currentTimeMillis, limit });
    return rows.map((row) => row.objectKey);
  }, Effect.catchTags(dieOnSchemaError));

  const completeObject = Effect.fn("Patches.completeObject")(function* (objectKey: string) {
    yield* sql`DELETE FROM pending_patch_objects WHERE object_key = ${objectKey} AND claimed`;
  });

  const record = Effect.fn("Patches.record")((input: RecordInput) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SET LOCAL statement_timeout = '60s'`;
          const millis = yield* Clock.currentTimeMillis;
          // DELETE holds the intent's row lock until commit. A concurrent sweep
          // skips it; rollback restores it; a lost commit reply cannot orphan
          // live bytes because the version and intent change atomically.
          const pending = yield* sql`
            DELETE FROM pending_patch_objects
            WHERE object_key = ${input.objectKey} AND NOT claimed
              AND expires_at > ${stamp(millis)}
            RETURNING object_key`;
          if (pending.length === 0)
            return yield* new PendingObjectExpired({ objectKey: input.objectKey });
          // A publish — first version or fifth — restarts the whole window.
          const expiresAt = stamp(millis + Duration.toMillis(RETENTION_WINDOW));
          let versionNumber: number;
          let scope: Patch["scope"] = input.scope ?? "company";
          let companyId = input.companyId;
          let companyHandle: string;
          let name: string;
          let rename = false;

          if (input.intent === "update") {
            // The row lock serialises concurrent updates of one patch: the
            // version number is allocated after it, so each waits its turn and
            // then sees the committed version before it.
            const locked = yield* lockTarget({
              patchId: input.patchId,
              ownerUserId: input.ownerUserId,
              nowMillis: millis
            });
            if (Option.isNone(locked))
              return yield* new PatchUnavailable({ patchId: input.patchId });
            scope = input.scope ?? locked.value.scope;
            companyId = locked.value.companyId;
            companyHandle = locked.value.companyHandle;
            name = input.manifest.name ?? locked.value.name;
            rename = name !== locked.value.name;
            versionNumber = (yield* nextVersionNumber(input.patchId)).nextVersion;
          } else {
            // Serialise quota accounting across distinct creates by the same owner.
            yield* sql`SELECT id FROM users WHERE id = ${input.ownerUserId} FOR UPDATE`;
            if (
              input.livePatchQuota !== undefined &&
              (yield* countLive(input.ownerUserId)) >= input.livePatchQuota
            ) {
              return yield* new PatchQuotaReached({ quota: input.livePatchQuota });
            }
            versionNumber = FIRST_VERSION_NUMBER;
            companyHandle = (yield* companyHandleRow(companyId)).handle;
            name =
              input.manifest.name ??
              deriveName(
                input.filename === null ? input.title : input.filename.replace(/\.[^.]*$/, "")
              );
            const created = yield* sql`
            INSERT INTO patches (id, company_id, owner_user_id, scope, title, name, current_version_id, repo_org, repo_name, expires_at)
            VALUES (${input.patchId}, ${companyId}, ${input.ownerUserId}, ${scope},
                    ${input.title}, ${name}, ${input.versionId}, ${input.repoOrg}, ${input.repoName}, ${expiresAt})
            ON CONFLICT (id) DO NOTHING
            RETURNING id`;
            if (created.length === 0) return yield* new PatchConflict({ patchId: input.patchId });
          }
          if (input.intent === "create" || rename) {
            const baseName = name;
            let ordinal = 1;
            while (Option.isNone(yield* claimName({ companyId, patchId: input.patchId, name }))) {
              if (input.manifest.name !== undefined) return yield* new NameTaken({ name });
              name = deriveName(baseName, ++ordinal);
            }
          }
          if (rename) {
            // Claim before retiring: opposing renames must refuse occupied names,
            // not each hold their source name while waiting for the other's.
            yield* sql`UPDATE patch_names SET current = false
              WHERE patch_id = ${input.patchId} AND current AND name <> ${name}`;
          }
          const declarationWarnings = yield* resolveDeclarations(input.manifest, companyId);
          const resources = yield* provision({ ...input, companyId });
          const declaringPatches = resources.sharing.some(
            (table) => input.manifest.tables[table]!.shared !== true
          )
            ? new Map(
                (yield* declaringPatchRows({
                  patchId: input.patchId,
                  companyId,
                  nowMillis: yield* Clock.currentTimeMillis
                })).map((row) => [row.table, row.count])
              )
            : new Map<string, number>();
          const sharingWarnings = resources.sharing.map((table) =>
            input.manifest.tables[table]!.shared === true
              ? `\`${table}\` is now shared.`
              : `\`${table}\` is no longer shared; ${declaringPatches.get(table) ?? 0} declaring patches are affected.`
          );
          const publicUrl = address(input.publicBaseUrl, companyHandle, name);
          const response = new (input.intent === "create" ? PublishCreated : PublishUpdated)({
            ok: true,
            patchId: input.patchId,
            versionId: input.versionId,
            versionNumber,
            title: input.title,
            scope,
            name,
            address: publicUrl,
            publicUrl,
            tier: input.manifest.tier,
            schemaRevision: resources.schemaRevision,
            provisioned: resources.provisioned,
            unused: resources.unused,
            warnings: [
              ...input.warnings,
              ...declarationWarnings,
              ...resources.warnings,
              ...sharingWarnings
            ]
          });
          const status = input.intent === "create" ? (201 as const) : (200 as const);
          const responseJson =
            input.intent === "create"
              ? encodePublishCreated(response)
              : encodePublishUpdated(response);

          const [inserted] = yield* sql`
          INSERT INTO patch_versions (
            id, patch_id, version_number, object_key, content_hash, file_size,
            created_by_machine_token_id, source_ip, user_agent, cli_version,
            git_branch, git_commit_sha, original_filename,
            owner_user_id, tier, release, manifest_version, wire_version, schema_revision,
            manifest, publish_key, payload_digest, publish_response, publish_status
          ) VALUES (
            ${input.versionId}, ${input.patchId}, ${versionNumber}, ${input.objectKey},
            ${input.contentHash}, ${input.fileSize}, ${input.machineTokenId}, ${input.sourceIp},
            ${input.userAgent}, ${input.cliVersion}, ${input.gitBranch}, ${input.gitCommitSha},
            ${input.filename}, ${input.ownerUserId}, ${input.manifest.tier}, ${input.manifest.release},
            ${input.manifest.manifestVersion}, ${input.wireVersion}, ${resources.schemaRevision},
            ${encodeManifest(input.manifest)}::jsonb, ${input.publishKey}, ${input.payloadDigest},
            ${responseJson}::jsonb, ${status}
          ) ON CONFLICT (owner_user_id, publish_key) DO NOTHING
          RETURNING publish_response::text AS "responseBody"`.pipe(
            Effect.flatMap(decodeResponseBodies)
          );
          if (inserted === undefined)
            return yield* new PublishKeyTaken({
              ownerUserId: input.ownerUserId,
              publishKey: { length: input.publishKey.length }
            });
          yield* sql`
          UPDATE patches
          SET current_version_id = ${input.versionId}, title = ${input.title}, scope = ${scope},
              name = ${name},
              repo_org = COALESCE(${input.repoOrg}, repo_org),
              repo_name = COALESCE(${input.repoName}, repo_name),
              updated_at = now(), expires_at = ${expiresAt}
          WHERE id = ${input.patchId}`;

          return { ...response, status, responseBody: inserted.responseBody } satisfies Recorded;
        }).pipe(Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die }))
      )
      .pipe(Effect.timeout("60 seconds"), Effect.catchTags({ TimeoutError: Effect.die }))
  );

  const setScopeRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      patchId: Schema.String,
      ownerUserId: Schema.String,
      scope: SharingScope,
      nowMillis: Schema.Number
    }),
    Result: PatchTargetRow,
    execute: ({ patchId, ownerUserId, scope, nowMillis }) => sql`
      UPDATE patches
      SET scope = ${scope}, updated_at = now()
      FROM companies
      WHERE ${writable(patchId, ownerUserId, stamp(nowMillis))}
        AND companies.id = patches.company_id
      RETURNING patches.scope, patches.name, patches.company_id AS "companyId",
        companies.handle AS "companyHandle"`
  });
  const setScope = Effect.fn("Patches.setScope")(function* (
    patchId: string,
    ownerUserId: string,
    scope: Patch["scope"]
  ) {
    const row = yield* setScopeRow({
      patchId,
      ownerUserId,
      scope,
      nowMillis: yield* Clock.currentTimeMillis
    });
    if (Option.isNone(row)) return yield* new PatchUnavailable({ patchId });
    return { scope: row.value.scope, name: row.value.name, companyHandle: row.value.companyHandle };
  }, Effect.catchTags(dieOnSchemaError));

  const resolveName = Effect.fn("Patches.resolveName")(function* (
    companyHandle: string,
    name: string
  ) {
    return yield* resolveNameRow({
      companyHandle,
      name,
      nowMillis: yield* Clock.currentTimeMillis
    });
  }, Effect.catchTags(dieOnSchemaError));

  // One predicate says both halves of the visit rule: `expires_at` below the
  // topped-up anchor is exactly "less than the visit-extension window
  // remains", and it is also exactly "this move does not shorten the clock".
  // The not-expired term keeps a visit from reviving an expired patch.
  const recordVisit = Effect.fn("Patches.recordVisit")(function* (patchId: string) {
    const millis = yield* Clock.currentTimeMillis;
    const at = stamp(millis);
    const toppedUp = stamp(millis + Duration.toMillis(VISIT_EXTENSION_WINDOW));
    yield* sql`
      UPDATE patches
      SET expires_at = ${toppedUp}
      WHERE patches.id = ${patchId}
        AND patches.deleted_at IS NULL
        AND patches.disabled_at IS NULL
        AND ${notExpired(at)}
        AND patches.expires_at < ${toppedUp}`;
  });

  const listExpired = Effect.fn("Patches.listExpired")(function* (limit: number) {
    if (limit <= 0) return [];
    const nowMillis = yield* Clock.currentTimeMillis;
    const rows = yield* listExpiredRows({ nowMillis, limit }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    return rows.map((row) => row.id);
  });

  const deleteExpired = Effect.fn("Patches.deleteExpired")((patchId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        // Re-check under a row lock so a patch can only be taken once and
        // only while its retention clock is expired.
        const target = yield* sql`
          SELECT id FROM patches
          WHERE patches.id = ${patchId} AND NOT ${notExpired(yield* now)}
          FOR UPDATE`;
        if (target.length === 0) return Option.none();

        const keys = yield* objectKeysOf(patchId);
        yield* sql`
          INSERT INTO pending_patch_objects (object_key, expires_at, claimed)
          SELECT object_key, ${yield* now}, true FROM patch_versions
          WHERE patch_id = ${patchId}`;
        // Foreign keys decide the order: versions name the patch, so the patch goes last.
        yield* sql`DELETE FROM patch_versions WHERE patch_id = ${patchId}`;
        yield* sql`DELETE FROM patches WHERE id = ${patchId}`;
        return Option.some(keys.map((row) => row.objectKey));
      }).pipe(Effect.catchTags(dieOnSchemaError))
    )
  );

  const delete_ = Effect.fn("Patches.delete")((patchId: string, ownerUserId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`
          UPDATE patches
          SET deleted_at = now(), updated_at = now()
          WHERE id = ${patchId}
            AND owner_user_id = ${ownerUserId}
            AND deleted_at IS NULL
          RETURNING id`;
        if (rows.length === 0) return false;
        yield* sql`DELETE FROM patch_names WHERE patch_id = ${patchId}`;
        return true;
      })
    )
  );

  return Patches.of({
    countLive,
    replay,
    preflight,
    inventory,
    sharedTable,
    prepareObject,
    claimObjects,
    completeObject,
    record,
    setScope,
    resolveName,
    find,
    recordVisit,
    listExpired,
    deleteExpired,
    delete: delete_
  });
});

/** Over the Postgres client. */
export const layer = Layer.effect(Patches, make);
