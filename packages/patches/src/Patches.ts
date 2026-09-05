/**
 * Patches and their versions: every row the capability keeps, read and
 * written here and nowhere else. Rows are decoded through `SqlSchema` in this
 * module only, so a client type change lands in one place.
 *
 * The retention clock lives in these queries. Every patch carries one expiry
 * anchor and three rules act on it: an upload resets the anchor to the full
 * retention window; a visit with less than the visit-extension window
 * remaining moves the anchor to exactly that window out — never shorter,
 * never reviving an expired patch; the clock check is `expires_at < now`, and
 * nothing else. Visits top up the clock regardless of the creating machine
 * token's state.
 *
 * The clock is Effect's, read as `Clock.currentTimeMillis`, so a test winds
 * it. Only the retention anchor reads it: `created_at`, `updated_at`,
 * `deleted_at` and `disabled_at` stay on SQL `now()`.
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
import { SharingScope } from "@patchy/api";

/** The window an upload gives a patch. */
export const RETENTION_WINDOW = Duration.days(90);

/** What a visit tops the remaining time up to, when less than this remains. */
export const VISIT_EXTENSION_WINDOW = Duration.days(30);

/** The first upload starts a patch's version sequence. */
const FIRST_VERSION_NUMBER = 1;

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

export interface Patch {
  readonly id: string;
  readonly companyId: string;
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
}

export interface UploadTarget {
  readonly intent: "create" | "update";
  readonly patchId: string;
  readonly ownerUserId: string;
}

export interface RecordInput extends UploadTarget {
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
}

export interface Recorded {
  readonly patchId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly title: string;
  readonly scope: Patch["scope"];
}

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
    /**
     * The upload contract's preflight, before any bytes are written: an
     * update needs a patch the caller may write, a create needs a free id.
     */
    readonly checkTarget: (
      target: UploadTarget
    ) => Effect.Effect<void, PatchUnavailable | PatchConflict | SqlError>;
    /**
     * Records an upload whose bytes are already stored: the version row, the
     * patch row it creates or moves forward, and a fresh retention window,
     * in one transaction. Re-checks the target under a row lock, so the
     * answer `checkTarget` gave can still change here.
     */
    readonly record: (
      input: RecordInput
    ) => Effect.Effect<Recorded, PatchUnavailable | PatchConflict | SqlError>;
    /** Changes an owned, available patch's audience without publishing or extending retention. */
    readonly setScope: (
      patchId: string,
      ownerUserId: string,
      scope: Patch["scope"]
    ) => Effect.Effect<Patch["scope"], PatchUnavailable | SqlError>;
    /**
     * A patch in service and one of its versions — the current one, or the
     * numbered one asked for. Deleted, disabled and expired patches are
     * absent here, exactly as an unknown id is.
     */
    readonly find: (
      patchId: string,
      versionNumber?: number
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
     * Hard-deletes one expired patch — its versions, then its row — and
     * answers with the object keys those versions held, so the caller can
     * delete the bytes behind them. `None` when the patch is no longer the
     * sweep's to take: already gone, or no longer expired.
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
  createdAt: Stamp
}) {}

class Id extends Schema.Class<Id>("Id")({ id: Schema.String }) {}
class Count extends Schema.Class<Count>("Count")({ count: Schema.Int }) {}
class NextVersion extends Schema.Class<NextVersion>("NextVersion")({ nextVersion: Schema.Int }) {}
class ObjectKey extends Schema.Class<ObjectKey>("ObjectKey")({ objectKey: Schema.String }) {}
class ScopeRow extends Schema.Class<ScopeRow>("ScopeRow")({ scope: SharingScope }) {}

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date === null ? null : date.toISOString());

const toPatch = (row: PatchRow): Patch => ({
  id: row.id,
  companyId: row.companyId,
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
  createdAt: iso(row.createdAt)
});

/** A `SchemaError` on a row is a bug in the query or the schema, never a caller's fault. */
const dieOnSchemaError = { SchemaError: Effect.die } as const;

/** The columns of `patches`, aliased to the record's names. */
const PATCH_COLUMNS = `
  patches.id, patches.company_id AS "companyId",
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
  created_at AS "createdAt"`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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
      FROM patches
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
    Request: Schema.String,
    Result: VersionRow,
    execute: (id) => sql`SELECT ${sql.unsafe(VERSION_COLUMNS)} FROM patch_versions WHERE id = ${id}`
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
    Result: ScopeRow,
    execute: ({ patchId, ownerUserId, nowMillis }) => sql`
      SELECT scope FROM patches
      WHERE ${writable(patchId, ownerUserId, stamp(nowMillis))}
      FOR UPDATE`
  });

  const countLive = Effect.fn("Patches.countLive")((ownerUserId: string) =>
    countLiveRow(ownerUserId).pipe(
      Effect.map((row) => row.count),
      // `count(*)` always answers one row; no row is a bug, not a state.
      Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
    )
  );

  const checkTarget = Effect.fn("Patches.checkTarget")(function* (target: UploadTarget) {
    if (target.intent === "update") {
      const rows =
        yield* sql`SELECT 1 FROM patches WHERE ${writable(target.patchId, target.ownerUserId, yield* now)}`;
      if (rows.length === 0) return yield* new PatchUnavailable({ patchId: target.patchId });
      return;
    }
    const rows = yield* sql`SELECT 1 FROM patches WHERE id = ${target.patchId}`;
    if (rows.length > 0) return yield* new PatchConflict({ patchId: target.patchId });
  });

  const record = Effect.fn("Patches.record")((input: RecordInput) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const millis = yield* Clock.currentTimeMillis;
        // An upload — first version or fifth — restarts the whole window.
        const expiresAt = stamp(millis + Duration.toMillis(RETENTION_WINDOW));
        let versionNumber: number;
        let scope: Patch["scope"] = input.scope ?? "company";

        if (input.intent === "update") {
          // The row lock serialises concurrent updates of one patch: the
          // version number is allocated after it, so each waits its turn and
          // then sees the committed version before it.
          const locked = yield* lockTarget({
            patchId: input.patchId,
            ownerUserId: input.ownerUserId,
            nowMillis: millis
          });
          if (Option.isNone(locked)) return yield* new PatchUnavailable({ patchId: input.patchId });
          scope = input.scope ?? locked.value.scope;
          versionNumber = (yield* nextVersionNumber(input.patchId)).nextVersion;
        } else {
          versionNumber = FIRST_VERSION_NUMBER;
          const created = yield* sql`
            INSERT INTO patches (id, company_id, owner_user_id, scope, title, current_version_id, repo_org, repo_name, expires_at)
            VALUES (${input.patchId}, ${input.companyId}, ${input.ownerUserId}, ${scope},
                    ${input.title}, ${input.versionId}, ${input.repoOrg}, ${input.repoName}, ${expiresAt})
            ON CONFLICT (id) DO NOTHING
            RETURNING id`;
          if (created.length === 0) return yield* new PatchConflict({ patchId: input.patchId });
        }

        yield* sql`
          INSERT INTO patch_versions (
            id, patch_id, version_number, object_key, content_hash, file_size,
            created_by_machine_token_id, source_ip, user_agent, cli_version,
            git_branch, git_commit_sha, original_filename
          ) VALUES (
            ${input.versionId}, ${input.patchId}, ${versionNumber}, ${input.objectKey},
            ${input.contentHash}, ${input.fileSize}, ${input.machineTokenId}, ${input.sourceIp},
            ${input.userAgent}, ${input.cliVersion}, ${input.gitBranch}, ${input.gitCommitSha},
            ${input.filename}
          )`;
        yield* sql`
          UPDATE patches
          SET current_version_id = ${input.versionId}, title = ${input.title}, scope = ${scope},
              repo_org = COALESCE(${input.repoOrg}, repo_org),
              repo_name = COALESCE(${input.repoName}, repo_name),
              updated_at = now(), expires_at = ${expiresAt}
          WHERE id = ${input.patchId}`;

        return {
          patchId: input.patchId,
          versionId: input.versionId,
          versionNumber,
          title: input.title,
          scope
        } satisfies Recorded;
      }).pipe(Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die }))
    )
  );

  const setScope = Effect.fn("Patches.setScope")(function* (
    patchId: string,
    ownerUserId: string,
    scope: Patch["scope"]
  ) {
    const rows = yield* sql`
      UPDATE patches
      SET scope = ${scope}, updated_at = now()
      WHERE ${writable(patchId, ownerUserId, yield* now)}
      RETURNING id`;
    if (rows.length === 0) return yield* new PatchUnavailable({ patchId });
    return scope;
  });

  const find = Effect.fn("Patches.find")(function* (patchId: string, versionNumber?: number) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const patch = yield* findPatch({ patchId, nowMillis });
    if (Option.isNone(patch)) return Option.none();
    const version =
      versionNumber === undefined
        ? patch.value.currentVersionId === null
          ? Option.none()
          : yield* findVersionById(patch.value.currentVersionId)
        : yield* findVersionByNumber({ patchId, versionNumber });
    return Option.map(version, (row) => ({ patch: toPatch(patch.value), version: toVersion(row) }));
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
        // Foreign keys decide the order: versions name the patch, so the patch goes last.
        yield* sql`DELETE FROM patch_versions WHERE patch_id = ${patchId}`;
        yield* sql`DELETE FROM patches WHERE id = ${patchId}`;
        return Option.some(keys.map((row) => row.objectKey));
      }).pipe(Effect.catchTags(dieOnSchemaError))
    )
  );

  const delete_ = Effect.fn("Patches.delete")(function* (patchId: string, ownerUserId: string) {
    const rows = yield* sql`
      UPDATE patches
      SET deleted_at = now(), updated_at = now()
      WHERE id = ${patchId}
        AND owner_user_id = ${ownerUserId}
        AND deleted_at IS NULL
      RETURNING id`;
    return rows.length > 0;
  });

  return Patches.of({
    countLive,
    checkTarget,
    record,
    setScope,
    find,
    recordVisit,
    listExpired,
    deleteExpired,
    delete: delete_
  });
});

/** Over the Postgres client. */
export const layer = Layer.effect(Patches, make);
