/**
 * Guests: people at another company whom a company shares one patch with. A grant names the
 * person and the patch; revoking it keeps the row, ended, so history still names them, and
 * sharing again restores it. Whether guests may open a patch at all is `unavailable`, the one
 * rule every door and surface asks; the service reads the facts it takes, connections' blocks
 * included, and `describe` words its answer.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Integration, Manifest, PatchState, SharingScope } from "@patchy/api";
import { ConnectionStore } from "@patchy/integrations";
import type { Patch, PatchVersion } from "./Patches.js";

/**
 * Why a patch's guests can't open it, as codes with their facts; `describe` words them. A guest
 * may see the reason, so they can pass it on. An operator-disabled patch needs none: it is absent
 * at every door and in every list.
 */
export const Reason = Schema.TaggedUnion({
  Retired: {},
  Deleted: {},
  /** Guests open tier 1 and tier 2 patches. */
  Tier: { tier: Schema.Int },
  /** The version reads another patch's shared table or store, which only its company may read. */
  SharedSource: { kind: Schema.Literals(["table", "store"]), alias: Schema.String },
  /** The version uses a connection an admin blocked guests from. */
  ConnectionBlocked: { integration: Integration, handle: Schema.String }
});
export type Reason = typeof Reason.Type;

/** A reason in words, the same for the owner, an admin, a publishing agent and the guest. */
export const describe = Reason.match({
  Retired: () => "It's retired.",
  Deleted: () => "It's deleted.",
  Tier: ({ tier }) => `Guests open tier 1 and tier 2 patches, and this one is tier ${tier}.`,
  SharedSource: ({ kind, alias }) =>
    `It reads ${alias}, another patch's shared ${kind}, which only its company can read. Remove ${alias} from the patch to let guests in.`,
  ConnectionBlocked: ({ integration, handle }) =>
    `It uses ${integration}/${handle}, which blocks guests. Allow guests on that connection, or remove it from the patch.`
});

/** What publish warns when a patch with guests publishes a version they can't open. */
export const warning = (reason: Reason) => `Guests can't open this patch. ${describe(reason)}`;

/** What eligibility reads of a version: its tier and what it declares. */
type Version = Pick<PatchVersion, "tier"> & {
  readonly manifest: Pick<PatchVersion["manifest"], "uses">;
};
type Uses = Version["manifest"]["uses"];

/** The connections a version declares, by id: the ones whose blocks `unavailable` reads. */
const connectionIds = (uses: Uses) =>
  Object.values(uses).flatMap((use) =>
    use.kind === "sharedTable" || use.kind === "sharedStore" || use.kind === "members"
      ? []
      : [use.id]
  );

/**
 * Why guests can't open this patch at this version, or none when they can. `blocked` holds the
 * connections an admin blocked guests from, as `ConnectionStore.blockingGuests` answers for the
 * version's; the first declaration in alias order that guests can't use is the reason. The member
 * directory doesn't count against it: a guest reads it as a member does.
 */
export const unavailable = (
  patch: Pick<Patch, "state">,
  version: Version,
  blocked: ReadonlySet<string>
): Option.Option<Reason> => {
  if (patch.state === "retired") return Option.some(Reason.cases.Retired.make({}));
  if (patch.state === "deleted") return Option.some(Reason.cases.Deleted.make({}));
  if (version.tier !== 1 && version.tier !== 2)
    return Option.some(Reason.cases.Tier.make({ tier: version.tier }));
  for (const [alias, use] of Object.entries(version.manifest.uses)) {
    if (use.kind === "sharedTable" || use.kind === "sharedStore")
      return Option.some(
        Reason.cases.SharedSource.make({
          kind: use.kind === "sharedTable" ? "table" : "store",
          alias
        })
      );
    if (use.kind !== "members" && blocked.has(use.id))
      return Option.some(
        Reason.cases.ConnectionBlocked.make({ integration: use.kind, handle: use.handle })
      );
  }
  return Option.none();
};

/**
 * Whether this version admits the patch's guests: only its current version, while available.
 * `loaded` is what the caller's own read of the version said of the patch, so a publish landing
 * after that read can't turn away a guest the read admits.
 */
export const admitsGuests = (
  loaded: Pick<Patch, "state"> & { readonly current: boolean },
  version: Version,
  blocked: ReadonlySet<string>
) => loaded.current && Option.isNone(unavailable(loaded, version, blocked));

/** A patch's guest: who they are and where they're from, read from their own account. */
export class Guest extends Schema.Class<Guest>("Guest")({
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  companyName: Schema.String,
  grantedAt: Schema.Date
}) {}

class SharedRow extends Schema.Class<SharedRow>("SharedRow")({
  patchId: Schema.String,
  name: Schema.String,
  title: Schema.String,
  companyHandle: Schema.String,
  companyName: Schema.String,
  grantedAt: Schema.Date,
  state: PatchState,
  tier: Schema.Int,
  uses: Manifest.fields.uses
}) {}

class RevokedRow extends Schema.Class<RevokedRow>("RevokedRow")({ userId: Schema.String }) {}

/** A patch shared with a person, and why they can't open it now, if they can't. */
export interface Shared {
  readonly patchId: string;
  readonly name: string;
  readonly title: string;
  readonly company: { readonly handle: string; readonly name: string };
  readonly grantedAt: Date;
  readonly unavailable: Option.Option<Reason>;
}

class Host extends Schema.Class<Host>("Host")({
  id: Schema.String,
  handle: Schema.String,
  name: Schema.String
}) {}

/** A live, company-only patch with an active grant, at its current version. */
class SharedPatchRow extends Schema.Class<SharedPatchRow>("SharedPatchRow")({
  patchId: Schema.String,
  state: PatchState,
  tier: Schema.Int,
  uses: Manifest.fields.uses
}) {}

/** A patch with an active grant, as publish reads it. */
class GrantedPatchRow extends Schema.Class<GrantedPatchRow>("GrantedPatchRow")({
  state: PatchState,
  scope: SharingScope
}) {}

type Failure = SqlError | ConnectionStore.ConnectionStorageFailed;

/** Grants are written by their callers' checks: Share decides who may receive one and when. */
export class GuestGrants extends Context.Service<
  GuestGrants,
  {
    /**
     * Gives a person access to a patch as `grantedBy`, or restores an ended grant. A grant that is
     * already active keeps who granted it and when.
     */
    readonly grant: (input: {
      readonly patchId: string;
      readonly userId: string;
      readonly grantedBy: string;
    }) => Effect.Effect<void, SqlError>;
    /** Ends a person's grant, keeping it. True when one was active. */
    readonly revoke: (input: {
      readonly patchId: string;
      readonly userId: string;
    }) => Effect.Effect<boolean, SqlError>;
    /** A patch's guests with active grants, deactivated accounts included, oldest grant first. */
    readonly guests: (patchId: string) => Effect.Effect<ReadonlyArray<Guest>, SqlError>;
    /** The patches shared with a person, by company and name; deleted ones are absent. */
    readonly sharedWith: (userId: string) => Effect.Effect<ReadonlyArray<Shared>, Failure>;
    /**
     * The patch's company, while this person holds an active grant to it and guests can open this
     * version: the doors' one question. The patch's state and whether the version is current come
     * from the caller's read, which loaded the version; the grant and the version's connection
     * blocks are read now, the blocks only for a grant holder and in one read.
     */
    readonly host: (input: {
      readonly patchId: string;
      readonly userId: string;
      readonly state: Patch["state"];
      readonly current: boolean;
      readonly version: Version;
    }) => Effect.Effect<Option.Option<Host>, Failure>;
    /**
     * The company's live, company-only patches with an active grant that guests can't open now,
     * by patch id, with why: what the card and Needs attention warn of. Two reads, however many.
     */
    readonly unavailableToGuests: (
      companyId: string
    ) => Effect.Effect<ReadonlyMap<string, Reason>, Failure>;
    /**
     * Why the patch's guests couldn't open this version as it publishes, at `scope` when the
     * publish changes it: what publish warns of. None while nobody holds an active grant, or once
     * it's public.
     */
    readonly unavailableAfterPublish: (input: {
      readonly patchId: string;
      readonly companyId: string;
      readonly scope: typeof SharingScope.Type | undefined;
      readonly version: Version;
    }) => Effect.Effect<Option.Option<Reason>, Failure>;
  }
>()("@patchy/patches/GuestGrants") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* ConnectionStore.ConnectionStore;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  /** A row's current version, as the rule reads it. */
  const versionOf = (row: { readonly tier: number; readonly uses: Uses }): Version => ({
    tier: row.tier,
    manifest: { uses: row.uses }
  });
  /** Which of these versions' connections block guests, in one read. */
  const blockedAmong = (versions: ReadonlyArray<Version>) =>
    connections.blockingGuests([
      ...new Set(versions.flatMap((version) => connectionIds(version.manifest.uses)))
    ]);
  // A patch is in one state: deleted, then retired, else live; disabled ones are never asked.
  const state = sql`CASE WHEN p.deleted_at IS NOT NULL THEN 'deleted'
    WHEN p.retired_at IS NOT NULL THEN 'retired' ELSE 'live' END`;
  const granted = sql`EXISTS (SELECT 1 FROM patch_guest_grants g
    WHERE g.patch_id = p.id AND g.revoked_at IS NULL)`;

  const revoked = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, userId: Schema.String, at: Schema.Number }),
    Result: RevokedRow,
    execute: ({ patchId, userId, at }) => sql`
      UPDATE patch_guest_grants SET revoked_at = to_timestamp(${at / 1_000})
      WHERE patch_id = ${patchId} AND user_id = ${userId} AND revoked_at IS NULL
      RETURNING user_id AS "userId"`
  });
  const patchGuests = SqlSchema.findAll({
    Request: Schema.String,
    Result: Guest,
    execute: (patchId) => sql`
      SELECT g.user_id AS "userId", u.name, u.email, c.name AS "companyName",
        g.granted_at AS "grantedAt"
      FROM patch_guest_grants g
      JOIN users u ON u.id = g.user_id
      JOIN companies c ON c.id = u.company_id
      WHERE g.patch_id = ${patchId} AND g.revoked_at IS NULL
      ORDER BY g.granted_at, g.user_id`
  });
  const sharedRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: SharedRow,
    execute: (userId) => sql`
      SELECT p.id AS "patchId", p.name, p.title, c.handle AS "companyHandle",
        c.name AS "companyName", g.granted_at AS "grantedAt", ${state} AS state, v.tier,
        v.manifest->'uses' AS uses
      FROM patch_guest_grants g
      JOIN patches p ON p.id = g.patch_id
      JOIN patch_versions v ON v.id = p.current_version_id
      JOIN companies c ON c.id = g.company_id
      WHERE g.user_id = ${userId} AND g.revoked_at IS NULL
        AND p.deleted_at IS NULL AND p.disabled_at IS NULL
      ORDER BY c.name, p.name`
  });
  const hostRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, userId: Schema.String }),
    Result: Host,
    execute: ({ patchId, userId }) => sql`
      SELECT c.id, c.handle, c.name
      FROM patch_guest_grants g JOIN companies c ON c.id = g.company_id
      WHERE g.patch_id = ${patchId} AND g.user_id = ${userId} AND g.revoked_at IS NULL`
  });
  const sharedPatchRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: SharedPatchRow,
    execute: (companyId) => sql`
      SELECT p.id AS "patchId", ${state} AS state, v.tier, v.manifest->'uses' AS uses
      FROM patches p JOIN patch_versions v ON v.id = p.current_version_id
      WHERE p.company_id = ${companyId} AND p.scope = 'company'
        AND p.retired_at IS NULL AND p.deleted_at IS NULL AND p.disabled_at IS NULL
        AND ${granted}`
  });
  const grantedPatchRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ patchId: Schema.String, companyId: Schema.String }),
    Result: GrantedPatchRow,
    execute: ({ patchId, companyId }) => sql`
      SELECT ${state} AS state, p.scope FROM patches p
      WHERE p.id = ${patchId} AND p.company_id = ${companyId} AND ${granted}`
  });

  const grant = Effect.fn("GuestGrants.grant")(function* ({
    patchId,
    userId,
    grantedBy
  }: {
    readonly patchId: string;
    readonly userId: string;
    readonly grantedBy: string;
  }) {
    const at = yield* Clock.currentTimeMillis;
    yield* sql`
      INSERT INTO patch_guest_grants (patch_id, company_id, user_id, granted_by, granted_at)
      SELECT id, company_id, ${userId}, ${grantedBy}, to_timestamp(${at / 1_000})
      FROM patches WHERE id = ${patchId}
      ON CONFLICT (patch_id, user_id) DO UPDATE SET granted_by = EXCLUDED.granted_by,
        granted_at = EXCLUDED.granted_at, revoked_at = NULL
      WHERE patch_guest_grants.revoked_at IS NOT NULL`;
  });
  const revoke = Effect.fn("GuestGrants.revoke")(function* (input: {
    readonly patchId: string;
    readonly userId: string;
  }) {
    const at = yield* Clock.currentTimeMillis;
    return Option.isSome(yield* revoked({ ...input, at }));
  }, Effect.catchTags(dieOnSchemaError));
  const guests = Effect.fn("GuestGrants.guests")(
    (patchId: string) => patchGuests(patchId),
    Effect.catchTags(dieOnSchemaError)
  );
  const sharedWith = Effect.fn("GuestGrants.sharedWith")(function* (userId: string) {
    const rows = yield* sharedRows(userId);
    const blocked = yield* blockedAmong(rows.map(versionOf));
    return rows.map((row): Shared => ({
      patchId: row.patchId,
      name: row.name,
      title: row.title,
      company: { handle: row.companyHandle, name: row.companyName },
      grantedAt: row.grantedAt,
      unavailable: unavailable(row, versionOf(row), blocked)
    }));
  }, Effect.catchTags(dieOnSchemaError));
  const host = Effect.fn("GuestGrants.host")(function* ({
    state,
    current,
    version,
    ...grant
  }: {
    readonly patchId: string;
    readonly userId: string;
    readonly state: Patch["state"];
    readonly current: boolean;
    readonly version: Version;
  }) {
    const found = yield* hostRow(grant);
    if (Option.isNone(found)) return Option.none();
    return admitsGuests({ state, current }, version, yield* blockedAmong([version]))
      ? found
      : Option.none();
  }, Effect.catchTags(dieOnSchemaError));
  const unavailableToGuests = Effect.fn("GuestGrants.unavailableToGuests")(function* (
    companyId: string
  ) {
    const rows = yield* sharedPatchRows(companyId);
    const blocked = yield* blockedAmong(rows.map(versionOf));
    return new Map(
      rows.flatMap((row) => {
        const reason = unavailable(row, versionOf(row), blocked);
        return Option.isSome(reason) ? [[row.patchId, reason.value] as const] : [];
      })
    );
  }, Effect.catchTags(dieOnSchemaError));
  const unavailableAfterPublish = Effect.fn("GuestGrants.unavailableAfterPublish")(function* ({
    scope,
    version,
    ...patch
  }: {
    readonly patchId: string;
    readonly companyId: string;
    readonly scope: typeof SharingScope.Type | undefined;
    readonly version: Version;
  }) {
    const found = yield* grantedPatchRow(patch);
    if (Option.isNone(found) || (scope ?? found.value.scope) === "public") return Option.none();
    return unavailable(found.value, version, yield* blockedAmong([version]));
  }, Effect.catchTags(dieOnSchemaError));
  return GuestGrants.of({
    grant,
    revoke,
    guests,
    sharedWith,
    host,
    unavailableToGuests,
    unavailableAfterPublish
  });
});

export const layer = Layer.effect(GuestGrants, make);
