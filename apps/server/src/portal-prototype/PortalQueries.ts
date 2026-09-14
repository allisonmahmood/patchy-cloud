/**
 * THROWAWAY (prototype #241): the one inventory behind the portal pages and
 * `patchy list`. Plain SQL over `SqlClient`, decoded through `SqlSchema`, all
 * of it company-scoped by the caller's company id. Mutations are guarded by
 * the row's revision (`updated_at` at millisecond precision) and answer
 * whether they hit; a miss is the stale-action case the pages render as 409.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Manifest, SharingScope, PatchName } from "@patchy/api";

const Stamp = Schema.Date;
const NullableStamp = Schema.NullOr(Schema.Date);

export type State = "live" | "retired" | "deleted";

/** Deleted patches leave in 30 days; the card and the index count them down. */
export const DELETE_WINDOW_DAYS = 30;

export class PatchRow extends Schema.Class<PatchRow>("PortalPatchRow")({
  id: Schema.String,
  name: PatchName,
  title: Schema.String,
  description: Schema.String,
  scope: SharingScope,
  companyHandle: Schema.String,
  ownerId: Schema.String,
  ownerName: Schema.String,
  ownerDeactivatedAt: NullableStamp,
  retiredAt: NullableStamp,
  retiredByName: Schema.NullOr(Schema.String),
  deletedAt: NullableStamp,
  deletedByName: Schema.NullOr(Schema.String),
  descriptionUpdatedAt: NullableStamp,
  descriptionUpdatedByName: Schema.NullOr(Schema.String),
  reassignedAt: NullableStamp,
  reassignedByName: Schema.NullOr(Schema.String),
  currentVersionId: Schema.NullOr(Schema.String),
  currentVersionNumber: Schema.NullOr(Schema.Int),
  tier: Schema.NullOr(Schema.Int),
  schemaRevision: Schema.NullOr(Schema.Int),
  publishedAt: NullableStamp,
  publisherName: Schema.NullOr(Schema.String),
  updatedAt: Stamp,
  /** `updated_at` as epoch milliseconds, computed in SQL so no clock parsing is involved. */
  revision: Schema.Number
}) {}

export const stateOf = (row: PatchRow): State =>
  row.deletedAt !== null ? "deleted" : row.retiredAt !== null ? "retired" : "live";

export class Dependant extends Schema.Class<Dependant>("PortalDependant")({
  table: Schema.String,
  patchId: Schema.String,
  name: Schema.String,
  ownerName: Schema.String
}) {}

export class BrokenSource extends Schema.Class<BrokenSource>("PortalBrokenSource")({
  alias: Schema.String,
  sourceId: Schema.String,
  sourceName: Schema.NullOr(Schema.String),
  state: Schema.Literals(["retired", "deleted", "missing"])
}) {}

export class VersionRow extends Schema.Class<VersionRow>("PortalVersionRow")({
  id: Schema.String,
  versionNumber: Schema.Int,
  createdAt: Stamp,
  publisherName: Schema.String,
  current: Schema.Boolean
}) {}

export class Member extends Schema.Class<Member>("PortalMember")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  role: Schema.Literals(["member", "admin"])
}) {}

class ManifestRow extends Schema.Class<ManifestRow>("PortalManifestRow")({ manifest: Manifest }) {}

const dieOnSchemaError = { SchemaError: Effect.die } as const;

/** The patch row with its actors and current version, aliased to the record's names. */
const PATCH_SELECT = `
  SELECT patches.id, patches.name, patches.title, patches.description, patches.scope,
    companies.handle AS "companyHandle",
    owner.id AS "ownerId", owner.name AS "ownerName", owner.deactivated_at AS "ownerDeactivatedAt",
    patches.retired_at AS "retiredAt", retired_by.name AS "retiredByName",
    patches.deleted_at AS "deletedAt", deleted_by.name AS "deletedByName",
    patches.description_updated_at AS "descriptionUpdatedAt",
    described_by.name AS "descriptionUpdatedByName",
    patches.reassigned_at AS "reassignedAt", reassigned_by.name AS "reassignedByName",
    patches.current_version_id AS "currentVersionId",
    current.version_number AS "currentVersionNumber", current.tier,
    current.schema_revision AS "schemaRevision",
    current.created_at AS "publishedAt", publisher.name AS "publisherName",
    patches.updated_at AS "updatedAt",
    floor(extract(epoch FROM patches.updated_at) * 1000)::float8 AS revision
  FROM patches
  JOIN companies ON companies.id = patches.company_id
  JOIN users AS owner ON owner.id = patches.owner_user_id
  LEFT JOIN users AS retired_by ON retired_by.id = patches.retired_by
  LEFT JOIN users AS deleted_by ON deleted_by.id = patches.deleted_by
  LEFT JOIN users AS described_by ON described_by.id = patches.description_updated_by
  LEFT JOIN users AS reassigned_by ON reassigned_by.id = patches.reassigned_by
  LEFT JOIN patch_versions AS current ON current.id = patches.current_version_id
  LEFT JOIN users AS publisher ON publisher.id = current.owner_user_id`;

export interface Revisioned {
  readonly patchId: string;
  readonly revision: number;
}

export class PortalQueries extends Context.Service<
  PortalQueries,
  {
    /** Every patch of the company, operator takedowns excluded, by name. */
    readonly list: (companyId: string) => Effect.Effect<ReadonlyArray<PatchRow>, SqlError>;
    readonly byId: (
      companyId: string,
      patchId: string
    ) => Effect.Effect<Option.Option<PatchRow>, SqlError>;
    /** The patch behind a current name, whatever its state; names stay reserved through deletion. */
    readonly byName: (
      companyId: string,
      name: string
    ) => Effect.Effect<Option.Option<PatchRow>, SqlError>;
    /** Live same-company patches whose current version reads a shared table of this patch. */
    readonly dependants: (
      companyId: string,
      patchId: string
    ) => Effect.Effect<ReadonlyArray<Dependant>, SqlError>;
    /** This patch's own shared-table uses whose source is off or gone. */
    readonly brokenSources: (
      companyId: string,
      patchId: string
    ) => Effect.Effect<ReadonlyArray<BrokenSource>, SqlError>;
    readonly versions: (patchId: string) => Effect.Effect<ReadonlyArray<VersionRow>, SqlError>;
    readonly currentManifest: (
      patchId: string
    ) => Effect.Effect<Option.Option<typeof Manifest.Type>, SqlError>;
    /** Active users of the company, filtered over name and email when `q` is given. */
    readonly members: (
      companyId: string,
      q: string
    ) => Effect.Effect<ReadonlyArray<Member>, SqlError>;
    readonly retire: (input: Revisioned & { actorId: string }) => Effect.Effect<boolean, SqlError>;
    readonly delete: (input: Revisioned & { actorId: string }) => Effect.Effect<boolean, SqlError>;
    readonly restore: (input: Revisioned) => Effect.Effect<boolean, SqlError>;
    readonly rollback: (
      input: Revisioned & { versionId: string }
    ) => Effect.Effect<boolean, SqlError>;
    readonly setScope: (
      input: Revisioned & { scope: typeof SharingScope.Type }
    ) => Effect.Effect<boolean, SqlError>;
    /** Stamps the actor only when the text actually changed; an unchanged save still hits. */
    readonly setDescription: (
      input: Revisioned & { description: string; actorId: string }
    ) => Effect.Effect<boolean, SqlError>;
    readonly reassign: (
      input: Revisioned & { targetUserId: string; actorId: string }
    ) => Effect.Effect<boolean, SqlError>;
  }
>()("@patchy/server/portal-prototype/PortalQueries") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: PatchRow,
    execute: (companyId) => sql`
      ${sql.unsafe(PATCH_SELECT)}
      WHERE patches.company_id = ${companyId} AND patches.disabled_at IS NULL
      ORDER BY patches.name, patches.id`
  });

  const byIdRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String }),
    Result: PatchRow,
    execute: ({ companyId, patchId }) => sql`
      ${sql.unsafe(PATCH_SELECT)}
      WHERE patches.company_id = ${companyId} AND patches.id = ${patchId}
        AND patches.disabled_at IS NULL`
  });

  const byNameRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ companyId: Schema.String, name: Schema.String }),
    Result: PatchRow,
    execute: ({ companyId, name }) => sql`
      ${sql.unsafe(PATCH_SELECT)}
      JOIN patch_names ON patch_names.patch_id = patches.id AND patch_names.current
      WHERE patches.company_id = ${companyId} AND patch_names.name = ${name}
        AND patches.disabled_at IS NULL
      ORDER BY (patches.deleted_at IS NULL) DESC, (patches.retired_at IS NULL) DESC
      LIMIT 1`
  });

  const dependantRows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String }),
    Result: Dependant,
    execute: ({ companyId, patchId }) => sql`
      SELECT declaration.value->>'table' AS "table", patches.id AS "patchId", patches.name,
        owner.name AS "ownerName"
      FROM patches
      JOIN patch_versions ON patch_versions.id = patches.current_version_id
      JOIN users AS owner ON owner.id = patches.owner_user_id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      WHERE patches.company_id = ${companyId}
        AND patches.deleted_at IS NULL AND patches.retired_at IS NULL
        AND patches.disabled_at IS NULL
        AND declaration.value->>'kind' = 'sharedTable'
        AND declaration.value->>'patchId' = ${patchId}
      ORDER BY declaration.value->>'table', patches.name`
  });

  const brokenSourceRows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, patchId: Schema.String }),
    Result: BrokenSource,
    execute: ({ companyId, patchId }) => sql`
      SELECT declaration.key AS alias, declaration.value->>'patchId' AS "sourceId",
        source.name AS "sourceName",
        CASE WHEN source.id IS NULL THEN 'missing'
             WHEN source.deleted_at IS NOT NULL THEN 'deleted'
             ELSE 'retired' END AS state
      FROM patches
      JOIN patch_versions ON patch_versions.id = patches.current_version_id
      CROSS JOIN LATERAL jsonb_each(patch_versions.manifest->'uses') AS declaration
      LEFT JOIN patches AS source ON source.id = declaration.value->>'patchId'
        AND source.company_id = patches.company_id AND source.disabled_at IS NULL
      WHERE patches.id = ${patchId} AND patches.company_id = ${companyId}
        AND declaration.value->>'kind' = 'sharedTable'
        AND (source.id IS NULL OR source.deleted_at IS NOT NULL OR source.retired_at IS NOT NULL)
      ORDER BY declaration.key`
  });

  const versionRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: VersionRow,
    execute: (patchId) => sql`
      SELECT patch_versions.id, patch_versions.version_number AS "versionNumber",
        patch_versions.created_at AS "createdAt", publisher.name AS "publisherName",
        (patch_versions.id = patches.current_version_id) AS current
      FROM patch_versions
      JOIN patches ON patches.id = patch_versions.patch_id
      JOIN users AS publisher ON publisher.id = patch_versions.owner_user_id
      WHERE patch_versions.patch_id = ${patchId}
      ORDER BY patch_versions.version_number DESC`
  });

  const manifestRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ManifestRow,
    execute: (patchId) => sql`
      SELECT patch_versions.manifest FROM patches
      JOIN patch_versions ON patch_versions.id = patches.current_version_id
      WHERE patches.id = ${patchId}`
  });

  const memberRows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, pattern: Schema.String }),
    Result: Member,
    execute: ({ companyId, pattern }) => sql`
      SELECT id, name, email, role FROM users
      WHERE company_id = ${companyId} AND deactivated_at IS NULL
        AND (name ILIKE ${pattern} OR email ILIKE ${pattern})
      ORDER BY name, email`
  });

  /**
   * Actor stamps are on the Effect clock, as the retention anchor is, so a
   * test can wind them; `updated_at` stays on SQL `now()` and is only ever
   * compared with itself.
   */
  const stamp = Effect.map(
    Clock.currentTimeMillis,
    (millis) => sql`to_timestamp(${millis / 1_000})`
  );

  /** The revision guard every mutation carries: the row as the form saw it. */
  const atRevision = ({ patchId, revision }: Revisioned) =>
    sql`patches.id = ${patchId}
        AND floor(extract(epoch FROM patches.updated_at) * 1000) = ${revision}`;

  const hit = (rows: ReadonlyArray<unknown>) => rows.length > 0;

  const retire = Effect.fn("PortalQueries.retire")(function* (
    input: Revisioned & { actorId: string }
  ) {
    return hit(
      yield* sql`
      UPDATE patches SET retired_at = ${yield* stamp}, retired_by = ${input.actorId}, updated_at = now()
      WHERE ${atRevision(input)} AND patches.retired_at IS NULL AND patches.deleted_at IS NULL
      RETURNING id`
    );
  });

  const delete_ = Effect.fn("PortalQueries.delete")(function* (
    input: Revisioned & { actorId: string }
  ) {
    return hit(
      yield* sql`
      UPDATE patches SET deleted_at = ${yield* stamp}, deleted_by = ${input.actorId}, updated_at = now()
      WHERE ${atRevision(input)} AND patches.deleted_at IS NULL
      RETURNING id`
    );
  });

  const restore = Effect.fn("PortalQueries.restore")(function* (input: Revisioned) {
    return hit(
      yield* sql`
      UPDATE patches SET retired_at = NULL, retired_by = NULL, deleted_at = NULL,
        deleted_by = NULL, updated_at = now()
      WHERE ${atRevision(input)}
        AND (patches.retired_at IS NOT NULL OR patches.deleted_at IS NOT NULL)
      RETURNING id`
    );
  });

  const rollback = Effect.fn("PortalQueries.rollback")(function* (
    input: Revisioned & { versionId: string }
  ) {
    return hit(
      yield* sql`
      UPDATE patches SET current_version_id = ${input.versionId}, updated_at = now()
      WHERE ${atRevision(input)} AND patches.deleted_at IS NULL AND patches.retired_at IS NULL
        AND EXISTS (SELECT 1 FROM patch_versions
          WHERE patch_versions.id = ${input.versionId} AND patch_versions.patch_id = patches.id)
      RETURNING id`
    );
  });

  const setScope = Effect.fn("PortalQueries.setScope")(function* (
    input: Revisioned & { scope: typeof SharingScope.Type }
  ) {
    return hit(
      yield* sql`
      UPDATE patches SET scope = ${input.scope}, updated_at = now()
      WHERE ${atRevision(input)} AND patches.deleted_at IS NULL AND patches.retired_at IS NULL
      RETURNING id`
    );
  });

  // The right-hand `description` is the old value: Postgres evaluates SET
  // expressions against the row before the update.
  const setDescription = Effect.fn("PortalQueries.setDescription")(function* (
    input: Revisioned & { description: string; actorId: string }
  ) {
    return hit(
      yield* sql`
      UPDATE patches SET
        description = ${input.description},
        description_updated_by = CASE WHEN description = ${input.description}
          THEN description_updated_by ELSE ${input.actorId} END,
        description_updated_at = CASE WHEN description = ${input.description}
          THEN description_updated_at ELSE ${yield* stamp} END,
        updated_at = CASE WHEN description = ${input.description} THEN updated_at ELSE now() END
      WHERE ${atRevision(input)} AND patches.deleted_at IS NULL
      RETURNING id`
    );
  });

  const reassign = Effect.fn("PortalQueries.reassign")(function* (
    input: Revisioned & { targetUserId: string; actorId: string }
  ) {
    return hit(
      yield* sql`
      UPDATE patches SET owner_user_id = ${input.targetUserId},
        reassigned_by = ${input.actorId}, reassigned_at = ${yield* stamp}, updated_at = now()
      WHERE ${atRevision(input)} AND patches.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM users WHERE users.id = ${input.targetUserId}
          AND users.company_id = patches.company_id AND users.deactivated_at IS NULL)
      RETURNING id`
    );
  });

  const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

  return PortalQueries.of({
    list: Effect.fn("PortalQueries.list")(
      (companyId: string) => listRows(companyId),
      Effect.catchTags(dieOnSchemaError)
    ),
    byId: Effect.fn("PortalQueries.byId")(
      (companyId: string, patchId: string) => byIdRow({ companyId, patchId }),
      Effect.catchTags(dieOnSchemaError)
    ),
    byName: Effect.fn("PortalQueries.byName")(
      (companyId: string, name: string) => byNameRow({ companyId, name }),
      Effect.catchTags(dieOnSchemaError)
    ),
    dependants: Effect.fn("PortalQueries.dependants")(
      (companyId: string, patchId: string) => dependantRows({ companyId, patchId }),
      Effect.catchTags(dieOnSchemaError)
    ),
    brokenSources: Effect.fn("PortalQueries.brokenSources")(
      (companyId: string, patchId: string) => brokenSourceRows({ companyId, patchId }),
      Effect.catchTags(dieOnSchemaError)
    ),
    versions: Effect.fn("PortalQueries.versions")(
      (patchId: string) => versionRows(patchId),
      Effect.catchTags(dieOnSchemaError)
    ),
    currentManifest: Effect.fn("PortalQueries.currentManifest")(
      (patchId: string) =>
        Effect.map(
          manifestRow(patchId),
          Option.map((row) => row.manifest)
        ),
      Effect.catchTags(dieOnSchemaError)
    ),
    members: Effect.fn("PortalQueries.members")(
      (companyId: string, q: string) =>
        memberRows({ companyId, pattern: `%${escapeLike(q.trim())}%` }),
      Effect.catchTags(dieOnSchemaError)
    ),
    retire,
    delete: delete_,
    restore,
    rollback,
    setScope,
    setDescription,
    reassign
  });
});

export const layer = Layer.effect(PortalQueries, make);
