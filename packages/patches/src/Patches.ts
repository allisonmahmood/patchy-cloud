/**
 * Patches and their versions: every row the capability keeps, read and
 * written here and nowhere else. Rows are decoded through `SqlSchema` in this
 * module only, so a client type change lands in one place.
 *
 * The retention clock lives in these queries. Every patch carries one expiry
 * anchor and four rules act on it: an upload resets the anchor to the full
 * retention window; a visit with less than the visit-extension window
 * remaining moves the anchor to exactly that window out — never shorter,
 * never reviving an expired patch; the clock check is `expires_at < now`, and
 * nothing else; a pinned patch is never expired, however far past its anchor
 * now is. One thing outside this module stops the visit rule: revoking a
 * patch's creating token freezes its top-ups, so the clock only runs down.
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

/** The window an upload gives a patch. */
export const RETENTION_WINDOW = Duration.days(90);

/** What a visit tops the remaining time up to, when less than this remains. */
export const VISIT_EXTENSION_WINDOW = Duration.days(30);

/** A patch's creating token is the one recorded on its first version. */
const FIRST_VERSION_NUMBER = 1;

/**
 * An update named a patch the caller cannot write: unknown, another
 * principal's, deleted, disabled or expired. One refusal for all five, so the
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
  readonly accountId: string;
  readonly title: string;
  readonly currentVersionId: string | null;
  readonly repoOrg: string | null;
  readonly repoName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The retention clock's anchor: expired once this is past, unless `pinnedAt` holds it. */
  readonly expiresAt: string;
  /** When an operator pinned this patch, or `null` for an ordinary one. */
  readonly pinnedAt: string | null;
  readonly deletedAt: string | null;
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
}

/**
 * A patch as the moderation loop sees it: the record plus the token that
 * created it, which is what revocation acts on. Fixed at the first version,
 * so a later update by another token never changes who a takedown resolves
 * to. Nullable only for a row that has lost its first version — a corrupt
 * store — where the loop reports what it found rather than inventing a culprit.
 */
export interface ModeratedPatch extends Patch {
  readonly createdByApiTokenId: string | null;
}

export interface PatchVersion {
  readonly id: string;
  readonly patchId: string;
  readonly versionNumber: number;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly fileSize: number;
  readonly createdByApiTokenId: string;
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
  readonly accountId: string;
}

export interface RecordInput extends UploadTarget {
  readonly versionId: string;
  readonly apiTokenId: string;
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
}

export interface ModerationOptions {
  /** The operator's reach, granted by the `admin` scope: any principal's patch, not only the caller's. */
  readonly canModerateAnyPrincipal: boolean;
}

export class Patches extends Context.Service<
  Patches,
  {
    /**
     * How many patches this token created that are still live — neither
     * deleted nor disabled. The durable half of the patch quota: recounted
     * from the database on every create, so a restart cannot reset it. An
     * expired patch still counts until the sweep takes its row.
     */
    readonly countLive: (apiTokenId: string) => Effect.Effect<number, SqlError>;
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
     * The moderation loop's first step, the one that turns a URL into a
     * culprit. Deliberately unlike `find`: a disabled, deleted or expired
     * patch is still answered, because the operator is asked about pages
     * that are already off as often as pages that are on.
     */
    readonly findForModeration: (
      patchId: string
    ) => Effect.Effect<Option.Option<ModeratedPatch>, SqlError>;
    /**
     * The second step: everything else that principal is holding, newest
     * first, at most `limit` rows, deleted patches excluded — a deleted patch
     * is a resolved one, and excluding it is what lets the list drain as the
     * operator works it. `truncated` says the principal holds more.
     */
    readonly listByPrincipal: (
      principalId: string,
      limit: number
    ) => Effect.Effect<{ patches: ReadonlyArray<ModeratedPatch>; truncated: boolean }, SqlError>;
    /**
     * Tops a served patch's clock up to the visit-extension window when less
     * than that remains. A no-op otherwise, including for a patch already
     * expired, deleted or disabled, and for one whose creating token is
     * revoked — from that moment its clock only runs down.
     */
    readonly recordVisit: (patchId: string) => Effect.Effect<void, SqlError>;
    /**
     * Pins or unpins. The two directions are deliberately not symmetric:
     * pinning answers `false` unless the patch is in service, because a pin
     * on a taken-down patch would exempt storage nobody can reach from the
     * sweep; unpinning answers `true` for any row still there, so a pin can
     * never be stuck on a patch the operator has since taken down.
     */
    readonly setPinned: (patchId: string, pinned: boolean) => Effect.Effect<boolean, SqlError>;
    /**
     * Ids the sweep may take right now — expired and unpinned, the
     * longest-expired first — capped at `limit`. Deleted and disabled patches
     * are included: the sweep is what finally frees their storage.
     */
    readonly listExpired: (limit: number) => Effect.Effect<ReadonlyArray<string>, SqlError>;
    /**
     * Hard-deletes one expired patch — its versions, then its row — and
     * answers with the object keys those versions held, so the caller can
     * delete the bytes behind them. `None` when the patch is no longer the
     * sweep's to take: already gone, or pinned since it was listed.
     */
    readonly deleteExpired: (
      patchId: string
    ) => Effect.Effect<Option.Option<ReadonlyArray<string>>, SqlError>;
    /**
     * Takes a patch out of service, ending any pin on it: moderation outranks
     * an exemption, so neither this nor `delete` can leave content the sweep
     * may never take. `false` when there was nothing the caller may disable.
     */
    readonly disable: (
      patchId: string,
      accountId: string,
      reason: string,
      options: ModerationOptions
    ) => Effect.Effect<boolean, SqlError>;
    /** Soft-deletes; the row and its bytes go with the next sweep. `false` when nothing was there to delete. */
    readonly delete: (
      patchId: string,
      accountId: string,
      options: ModerationOptions
    ) => Effect.Effect<boolean, SqlError>;
  }
>()("@patchy/patches/Patches") {}

// Today's client hands back a Date; when it becomes epoch ms only these lines move.
const Stamp = Schema.Date;
const NullableStamp = Schema.NullOr(Schema.Date);

class PatchRow extends Schema.Class<PatchRow>("PatchRow")({
  id: Schema.String,
  accountId: Schema.String,
  title: Schema.String,
  currentVersionId: Schema.NullOr(Schema.String),
  repoOrg: Schema.NullOr(Schema.String),
  repoName: Schema.NullOr(Schema.String),
  createdAt: Stamp,
  updatedAt: Stamp,
  expiresAt: Stamp,
  pinnedAt: NullableStamp,
  deletedAt: NullableStamp,
  disabledAt: NullableStamp,
  disabledReason: Schema.NullOr(Schema.String)
}) {}

class ModeratedPatchRow extends Schema.Class<ModeratedPatchRow>("ModeratedPatchRow")({
  ...PatchRow.fields,
  createdByApiTokenId: Schema.NullOr(Schema.String)
}) {}

class VersionRow extends Schema.Class<VersionRow>("VersionRow")({
  id: Schema.String,
  patchId: Schema.String,
  versionNumber: Schema.Int,
  objectKey: Schema.String,
  contentHash: Schema.String,
  fileSize: Schema.Int,
  createdByApiTokenId: Schema.String,
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

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date === null ? null : date.toISOString());

const toPatch = (row: PatchRow): Patch => ({
  id: row.id,
  accountId: row.accountId,
  title: row.title,
  currentVersionId: row.currentVersionId,
  repoOrg: row.repoOrg,
  repoName: row.repoName,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  expiresAt: iso(row.expiresAt),
  pinnedAt: isoOrNull(row.pinnedAt),
  deletedAt: isoOrNull(row.deletedAt),
  disabledAt: isoOrNull(row.disabledAt),
  disabledReason: row.disabledReason
});

const toModeratedPatch = (row: ModeratedPatchRow): ModeratedPatch => ({
  ...toPatch(row),
  createdByApiTokenId: row.createdByApiTokenId
});

const toVersion = (row: VersionRow): PatchVersion => ({
  id: row.id,
  patchId: row.patchId,
  versionNumber: row.versionNumber,
  objectKey: row.objectKey,
  contentHash: row.contentHash,
  fileSize: row.fileSize,
  createdByApiTokenId: row.createdByApiTokenId,
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
  patches.id, patches.account_id AS "accountId", patches.title,
  patches.current_version_id AS "currentVersionId",
  patches.repo_org AS "repoOrg", patches.repo_name AS "repoName",
  patches.created_at AS "createdAt", patches.updated_at AS "updatedAt",
  patches.expires_at AS "expiresAt", patches.pinned_at AS "pinnedAt",
  patches.deleted_at AS "deletedAt", patches.disabled_at AS "disabledAt",
  patches.disabled_reason AS "disabledReason"`;

const VERSION_COLUMNS = `
  id, patch_id AS "patchId", version_number AS "versionNumber",
  object_key AS "objectKey", content_hash AS "contentHash", file_size AS "fileSize",
  created_by_api_token_id AS "createdByApiTokenId", source_ip AS "sourceIp",
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
   * "Not expired" as one predicate: a pin exempts the patch outright, and
   * otherwise the anchor must not be past. Bound to the clock reading passed
   * in, so every query in one operation reads the same instant.
   */
  const notExpired = (at: Statement.Fragment) =>
    sql`(patches.pinned_at IS NOT NULL OR patches.expires_at >= ${at})`;

  /** A patch in service the principal may write: theirs, and neither taken down nor expired. */
  const writable = (patchId: string, accountId: string, at: Statement.Fragment) =>
    sql`patches.id = ${patchId} AND patches.account_id = ${accountId}
        AND patches.deleted_at IS NULL AND patches.disabled_at IS NULL AND ${notExpired(at)}`;

  const countLiveRow = SqlSchema.findOne({
    Request: Schema.String,
    Result: Count,
    execute: (apiTokenId) => sql`
      SELECT count(*)::int AS count
      FROM patches
      JOIN patch_versions ON patch_versions.patch_id = patches.id
        AND patch_versions.version_number = ${FIRST_VERSION_NUMBER}
      WHERE patch_versions.created_by_api_token_id = ${apiTokenId}
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

  // The join is outer so a patch always answers, even with its first version somehow missing.
  const moderatedSelect = sql`
    SELECT ${sql.unsafe(PATCH_COLUMNS)}, first_version.created_by_api_token_id AS "createdByApiTokenId"
    FROM patches
    LEFT JOIN patch_versions AS first_version
      ON first_version.patch_id = patches.id
      AND first_version.version_number = ${FIRST_VERSION_NUMBER}`;

  const findModerated = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ModeratedPatchRow,
    execute: (patchId) => sql`${moderatedSelect} WHERE patches.id = ${patchId}`
  });

  // One row past the limit is how truncation is detected without a count.
  const listModerated = SqlSchema.findAll({
    Request: Schema.Struct({ principalId: Schema.String, limit: Schema.Number }),
    Result: ModeratedPatchRow,
    execute: ({ limit, principalId }) => sql`
      ${moderatedSelect}
      WHERE patches.account_id = ${principalId} AND patches.deleted_at IS NULL
      ORDER BY patches.created_at DESC, patches.id DESC
      LIMIT ${limit + 1}`
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

  const countLive = Effect.fn("Patches.countLive")((apiTokenId: string) =>
    countLiveRow(apiTokenId).pipe(
      Effect.map((row) => row.count),
      // `count(*)` always answers one row; no row is a bug, not a state.
      Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
    )
  );

  const checkTarget = Effect.fn("Patches.checkTarget")(function* (target: UploadTarget) {
    if (target.intent === "update") {
      const rows =
        yield* sql`SELECT 1 FROM patches WHERE ${writable(target.patchId, target.accountId, yield* now)}`;
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
        const at = stamp(millis);
        // An upload — first version or fifth — restarts the whole window.
        const expiresAt = stamp(millis + Duration.toMillis(RETENTION_WINDOW));
        let versionNumber: number;

        if (input.intent === "update") {
          // The row lock serialises concurrent updates of one patch: the
          // version number is allocated after it, so each waits its turn and
          // then sees the committed version before it.
          const locked = yield* sql`
            SELECT id FROM patches WHERE ${writable(input.patchId, input.accountId, at)} FOR UPDATE`;
          if (locked.length === 0) return yield* new PatchUnavailable({ patchId: input.patchId });
          versionNumber = (yield* nextVersionNumber(input.patchId)).nextVersion;
        } else {
          versionNumber = FIRST_VERSION_NUMBER;
          const created = yield* sql`
            INSERT INTO patches (id, account_id, title, current_version_id, repo_org, repo_name, expires_at)
            VALUES (${input.patchId}, ${input.accountId}, ${input.title}, ${input.versionId},
                    ${input.repoOrg}, ${input.repoName}, ${expiresAt})
            ON CONFLICT (id) DO NOTHING
            RETURNING id`;
          if (created.length === 0) return yield* new PatchConflict({ patchId: input.patchId });
        }

        yield* sql`
          INSERT INTO patch_versions (
            id, patch_id, version_number, object_key, content_hash, file_size,
            created_by_api_token_id, source_ip, user_agent, cli_version,
            git_branch, git_commit_sha, original_filename
          ) VALUES (
            ${input.versionId}, ${input.patchId}, ${versionNumber}, ${input.objectKey},
            ${input.contentHash}, ${input.fileSize}, ${input.apiTokenId}, ${input.sourceIp},
            ${input.userAgent}, ${input.cliVersion}, ${input.gitBranch}, ${input.gitCommitSha},
            ${input.filename}
          )`;
        yield* sql`
          UPDATE patches
          SET current_version_id = ${input.versionId}, title = ${input.title},
              repo_org = COALESCE(${input.repoOrg}, repo_org),
              repo_name = COALESCE(${input.repoName}, repo_name),
              updated_at = now(), expires_at = ${expiresAt}
          WHERE id = ${input.patchId}`;

        return {
          patchId: input.patchId,
          versionId: input.versionId,
          versionNumber,
          title: input.title
        } satisfies Recorded;
      }).pipe(Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die }))
    )
  );

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

  const findForModeration = Effect.fn("Patches.findForModeration")((patchId: string) =>
    findModerated(patchId).pipe(
      Effect.map(Option.map(toModeratedPatch)),
      Effect.catchTags(dieOnSchemaError)
    )
  );

  const listByPrincipal = Effect.fn("Patches.listByPrincipal")(
    (principalId: string, limit: number) =>
      listModerated({ principalId, limit: Math.max(0, limit) }).pipe(
        Effect.map((rows) => ({
          patches: rows.slice(0, Math.max(0, limit)).map(toModeratedPatch),
          truncated: rows.length > Math.max(0, limit)
        })),
        Effect.catchTags(dieOnSchemaError)
      )
  );

  // One predicate says both halves of the visit rule: `expires_at` below the
  // topped-up anchor is exactly "less than the visit-extension window
  // remains", and it is also exactly "this move does not shorten the clock".
  // The not-expired term keeps a visit from reviving an expired patch — and,
  // because a pin means not expired, keeps topping a pinned patch up. The
  // NOT EXISTS is the revocation freeze.
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
        AND patches.expires_at < ${toppedUp}
        AND NOT EXISTS (
          SELECT 1 FROM patch_versions
          JOIN api_tokens ON api_tokens.id = patch_versions.created_by_api_token_id
          WHERE patch_versions.patch_id = patches.id
            AND patch_versions.version_number = ${FIRST_VERSION_NUMBER}
            AND api_tokens.revoked_at IS NOT NULL
        )`;
  });

  const setPinned = Effect.fn("Patches.setPinned")(function* (patchId: string, pinned: boolean) {
    const rows = pinned
      ? yield* sql`
          UPDATE patches SET pinned_at = ${yield* now}
          WHERE id = ${patchId} AND deleted_at IS NULL AND disabled_at IS NULL
          RETURNING id`
      : yield* sql`UPDATE patches SET pinned_at = NULL WHERE id = ${patchId} RETURNING id`;
    return rows.length > 0;
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
        // The row lock plus the re-check is what makes a concurrent pin safe:
        // a pin either lands before this and the patch is no longer expired,
        // or it waits here and finds nothing left to pin.
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

  const disable = Effect.fn("Patches.disable")(function* (
    patchId: string,
    accountId: string,
    reason: string,
    options: ModerationOptions
  ) {
    const rows = yield* sql`
      UPDATE patches
      SET disabled_at = now(), disabled_reason = ${reason}, updated_at = now(), pinned_at = NULL
      WHERE id = ${patchId}
        AND (account_id = ${accountId} OR ${options.canModerateAnyPrincipal})
        AND deleted_at IS NULL
      RETURNING id`;
    return rows.length > 0;
  });

  const delete_ = Effect.fn("Patches.delete")(function* (
    patchId: string,
    accountId: string,
    options: ModerationOptions
  ) {
    const rows = yield* sql`
      UPDATE patches
      SET deleted_at = now(), updated_at = now(), pinned_at = NULL
      WHERE id = ${patchId}
        AND (account_id = ${accountId} OR ${options.canModerateAnyPrincipal})
        AND deleted_at IS NULL
      RETURNING id`;
    return rows.length > 0;
  });

  return Patches.of({
    countLive,
    checkTarget,
    record,
    find,
    findForModeration,
    listByPrincipal,
    recordVisit,
    setPinned,
    listExpired,
    deleteExpired,
    disable,
    delete: delete_
  });
});

/** Over the Postgres client. */
export const layer = Layer.effect(Patches, make);
