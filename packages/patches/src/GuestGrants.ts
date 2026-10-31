/**
 * Guests: people at another company whom a company shares one patch with. A grant names the
 * person and the patch; revoking it keeps the row, ended, so history still names them, and
 * sharing again restores it. Whether guests may open a patch at all is `unavailable`, the one
 * rule every door and surface asks, answered as `@patchy/api`'s `GuestReason`; the service reads
 * the facts it takes, connections' blocks included. Share, remove and list are the owner's and
 * admins' acts, checked as every lifecycle act is.
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
import { GuestReason, guestReasonText, Manifest, PatchState, SharingScope } from "@patchy/api";
import { Users } from "@patchy/companies";
import { ConnectionStore } from "@patchy/integrations";
import * as Patches from "./Patches.js";

/** What publish warns, and Share refuses with, when guests can't open a version. */
export const warning = (reason: GuestReason) =>
  `Guests can't open this patch. ${guestReasonText(reason)}`;

/**
 * Nobody signs in to Patchy with this email, or their account is deactivated: one answer, so
 * Share never tells another company's state.
 */
export class NotOnPatchy extends Schema.TaggedError<NotOnPatchy>()("NotOnPatchy", {
  email: Schema.String
}) {
  override get message() {
    return `${this.email} isn't on Patchy yet.`;
  }
}

/** The email is someone's in the patch's own company, who opens it as a member. */
export class AlreadyMember extends Schema.TaggedError<AlreadyMember>()("AlreadyMember", {
  email: Schema.String
}) {
  override get message() {
    return `${this.email} is already in this company.`;
  }
}

/** The patch's current version is one its guests can't open. */
export class GuestsUnavailable extends Schema.TaggedError<GuestsUnavailable>()(
  "GuestsUnavailable",
  { reason: GuestReason }
) {
  override get message() {
    return warning(this.reason);
  }
}

/** What eligibility reads of a version: its tier and what it declares. */
type Version = Pick<Patches.PatchVersion, "tier"> & {
  readonly manifest: Pick<Patches.PatchVersion["manifest"], "uses">;
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
  patch: Pick<Patches.Patch, "state">,
  version: Version,
  blocked: ReadonlySet<string>
): Option.Option<GuestReason> => {
  if (patch.state === "retired") return Option.some({ code: "retired" });
  if (patch.state === "deleted") return Option.some({ code: "deleted" });
  if (version.tier !== 1 && version.tier !== 2)
    return Option.some({ code: "tier", tier: version.tier });
  for (const [alias, use] of Object.entries(version.manifest.uses)) {
    if (use.kind === "sharedTable" || use.kind === "sharedStore")
      return Option.some({
        code: "shared_source",
        kind: use.kind === "sharedTable" ? "table" : "store",
        alias
      });
    if (use.kind !== "members" && blocked.has(use.id))
      return Option.some({ code: "connection_blocked", integration: use.kind, handle: use.handle });
  }
  return Option.none();
};

/**
 * Whether this version admits the patch's guests: only its current version, while available.
 * `loaded` is what the caller's own read of the version said of the patch, so a publish landing
 * after that read can't turn away a guest the read admits.
 */
export const admitsGuests = (
  loaded: Pick<Patches.Patch, "state"> & { readonly current: boolean },
  version: Version,
  blocked: ReadonlySet<string>
) => loaded.current && Option.isNone(unavailable(loaded, version, blocked));

/** Someone at another company, read from their own account. */
export const Person = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  email: Schema.String,
  companyName: Schema.String
});
export type Person = typeof Person.Type;

/** A patch's guest, and when they were added. */
export const Guest = Schema.Struct({ ...Person.fields, grantedAt: Schema.Date });
export type Guest = typeof Guest.Type;

/** A person as every surface names them: by their name, or their email's when it's blank. */
const named = <A extends Person>(person: A): A => ({ ...person, name: Users.displayName(person) });

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

class HolderRow extends Schema.Class<HolderRow>("HolderRow")({
  userId: Schema.String,
  active: Schema.Boolean
}) {}

/** A patch shared with a person, and why they can't open it now, if they can't. */
export interface Shared {
  readonly patchId: string;
  readonly name: string;
  readonly title: string;
  readonly tier: number;
  readonly company: { readonly handle: string; readonly name: string };
  readonly grantedAt: Date;
  readonly unavailable: Option.Option<GuestReason>;
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

/** A version as eligibility reads it. */
class VersionRow extends Schema.Class<VersionRow>("VersionRow")({
  tier: Schema.Int,
  uses: Manifest.fields.uses
}) {}

/** A patch with an active grant, as publish reads it. */
class GrantedPatchRow extends Schema.Class<GrantedPatchRow>("GrantedPatchRow")({
  state: PatchState,
  scope: SharingScope
}) {}

type Failure = SqlError | ConnectionStore.ConnectionStorageFailed;
/** Who may manage the patch decides, as for every lifecycle act. */
type Refusal = Patches.PatchUnavailable | Patches.NotOwner;

/**
 * `grant` and `revoke` write what their caller decided; `share`, `remove` and `list` are the owner's
 * and admins' acts, which check who may act, who may receive a grant and when.
 */
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
    /**
     * Which of these people hold a grant to one of the company's patches, `true` while their
     * grant on this patch is active: the guests the patch's member directory resolves.
     */
    readonly holders: (
      patch: { readonly companyId: string; readonly patchId: string },
      userIds: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyMap<string, boolean>, SqlError>;
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
      readonly state: Patches.Patch["state"];
      readonly current: boolean;
      readonly version: Version;
    }) => Effect.Effect<Option.Option<Host>, Failure>;
    /**
     * The company's live, company-only patches with an active grant that guests can't open now,
     * by patch id, with why: what the card and Needs attention warn of. Two reads, however many.
     */
    readonly unavailableToGuests: (
      companyId: string
    ) => Effect.Effect<ReadonlyMap<string, GuestReason>, Failure>;
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
    }) => Effect.Effect<Option.Option<GuestReason>, Failure>;
    /**
     * Shares a live patch with the person who signs in with `email`, as its owner or an admin.
     * Sharing with a guest again changes nothing; sharing with a removed one adds them back.
     */
    readonly share: (input: {
      readonly patchId: string;
      readonly actor: Patches.Actor;
      readonly email: string;
    }) => Effect.Effect<
      { readonly patch: Patches.Patch; readonly guest: Guest },
      Refusal | Patches.WrongState | GuestsUnavailable | NotOnPatchy | AlreadyMember | Failure
    >;
    /**
     * Stops sharing the patch with one guest, named by email or user id, as its owner or an admin,
     * in any state. `removed` says whether they were a guest.
     */
    readonly remove: (input: {
      readonly patchId: string;
      readonly actor: Patches.Actor;
      readonly guest: string;
    }) => Effect.Effect<
      { readonly patch: Patches.Patch; readonly removed: boolean },
      Refusal | SqlError
    >;
    /** The patch's guests, as `guests` lists them, for its owner or an admin. */
    readonly list: (input: {
      readonly patchId: string;
      readonly actor: Patches.Actor;
    }) => Effect.Effect<
      { readonly patch: Patches.Patch; readonly guests: ReadonlyArray<Guest> },
      Refusal | SqlError
    >;
    /**
     * The people this company has shared any patch with, active accounts only, most recent first:
     * what Share suggests.
     */
    readonly sharedBefore: (companyId: string) => Effect.Effect<ReadonlyArray<Person>, SqlError>;
  }
>()("@patchy/patches/GuestGrants") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* ConnectionStore.ConnectionStore;
  const patches = yield* Patches.Patches;
  const users = yield* Users.Users;
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
  const activeGuests = sql`SELECT g.user_id AS "userId", u.name, u.email,
      c.name AS "companyName", g.granted_at AS "grantedAt"
    FROM patch_guest_grants g
    JOIN users u ON u.id = g.user_id
    JOIN companies c ON c.id = u.company_id
    WHERE g.revoked_at IS NULL`;
  const patchGuests = SqlSchema.findAll({
    Request: Schema.String,
    Result: Guest,
    execute: (patchId) => sql`${activeGuests} AND g.patch_id = ${patchId}
      ORDER BY g.granted_at, g.user_id`
  });
  const patchGuest = SqlSchema.findOne({
    Request: Schema.Struct({ patchId: Schema.String, userId: Schema.String }),
    Result: Guest,
    execute: ({ patchId, userId }) => sql`${activeGuests}
      AND g.patch_id = ${patchId} AND g.user_id = ${userId}`
  });
  const currentVersion = SqlSchema.findOne({
    Request: Schema.String,
    Result: VersionRow,
    execute: (patchId) => sql`
      SELECT v.tier, v.manifest->'uses' AS uses
      FROM patches p JOIN patch_versions v ON v.id = p.current_version_id
      WHERE p.id = ${patchId}`
  });
  const recentPeople = SqlSchema.findAll({
    Request: Schema.String,
    Result: Person,
    execute: (companyId) => sql`
      SELECT u.id AS "userId", u.name, u.email, c.name AS "companyName"
      FROM (SELECT user_id, max(granted_at) AS at FROM patch_guest_grants
        WHERE company_id = ${companyId} GROUP BY user_id) g
      JOIN users u ON u.id = g.user_id AND u.deactivated_at IS NULL
      JOIN companies c ON c.id = u.company_id
      ORDER BY g.at DESC, u.id
      LIMIT 50`
  });
  const holderRows = SqlSchema.findAll({
    Request: Schema.Struct({
      companyId: Schema.String,
      patchId: Schema.String,
      userIds: Schema.Array(Schema.String)
    }),
    Result: HolderRow,
    execute: ({ companyId, patchId, userIds }) => sql`
      SELECT user_id AS "userId", bool_or(patch_id = ${patchId} AND revoked_at IS NULL) AS active
      FROM patch_guest_grants
      WHERE company_id = ${companyId} AND ${sql.in("user_id", userIds)}
      GROUP BY user_id`
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
    (patchId: string) => Effect.map(patchGuests(patchId), (rows) => rows.map(named)),
    Effect.catchTags(dieOnSchemaError)
  );
  const holders = Effect.fn("GuestGrants.holders")(function* (
    { companyId, patchId }: { readonly companyId: string; readonly patchId: string },
    userIds: ReadonlyArray<string>
  ) {
    if (userIds.length === 0) return new Map<string, boolean>();
    const rows = yield* holderRows({ companyId, patchId, userIds: [...new Set(userIds)] });
    return new Map(rows.map(({ userId, active }) => [userId, active]));
  }, Effect.catchTags(dieOnSchemaError));
  const sharedWith = Effect.fn("GuestGrants.sharedWith")(function* (userId: string) {
    const rows = yield* sharedRows(userId);
    const blocked = yield* blockedAmong(rows.map(versionOf));
    return rows.map((row): Shared => ({
      patchId: row.patchId,
      name: row.name,
      title: row.title,
      tier: row.tier,
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
    readonly state: Patches.Patch["state"];
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
  const share = Effect.fn("GuestGrants.share")(
    function* ({
      patchId,
      actor,
      email
    }: {
      readonly patchId: string;
      readonly actor: Patches.Actor;
      readonly email: string;
    }) {
      const patch = yield* patches.manage(patchId, actor);
      if (patch.state !== "live") return yield* new Patches.WrongState({ state: patch.state });
      const version = versionOf(yield* currentVersion(patch.id));
      const reason = unavailable(patch, version, yield* blockedAmong([version]));
      if (Option.isSome(reason)) return yield* new GuestsUnavailable({ reason: reason.value });
      const address = email.trim();
      const person = yield* users.findByEmail(address);
      if (person === null || person.deactivatedAt !== null)
        return yield* new NotOnPatchy({ email: address });
      if (person.companyId === patch.companyId) return yield* new AlreadyMember({ email: address });
      yield* grant({ patchId: patch.id, userId: person.id, grantedBy: actor.userId });
      return { patch, guest: named(yield* patchGuest({ patchId: patch.id, userId: person.id })) };
    },
    sql.withTransaction,
    Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
  );
  const remove = Effect.fn("GuestGrants.remove")(function* ({
    patchId,
    actor,
    guest
  }: {
    readonly patchId: string;
    readonly actor: Patches.Actor;
    readonly guest: string;
  }) {
    const patch = yield* patches.manage(patchId, actor);
    const named = guest.trim();
    const userId = named.includes("@") ? (yield* users.findByEmail(named))?.id : named;
    return {
      patch,
      removed: userId !== undefined && (yield* revoke({ patchId: patch.id, userId }))
    };
  }, sql.withTransaction);
  const list = Effect.fn("GuestGrants.list")(function* (input: {
    readonly patchId: string;
    readonly actor: Patches.Actor;
  }) {
    const patch = yield* patches.manage(input.patchId, input.actor);
    return { patch, guests: yield* guests(patch.id) };
  }, sql.withTransaction);
  const sharedBefore = Effect.fn("GuestGrants.sharedBefore")(
    (companyId: string) => Effect.map(recentPeople(companyId), (rows) => rows.map(named)),
    Effect.catchTags(dieOnSchemaError)
  );
  return GuestGrants.of({
    grant,
    revoke,
    guests,
    holders,
    sharedWith,
    host,
    unavailableToGuests,
    unavailableAfterPublish,
    share,
    remove,
    list,
    sharedBefore
  });
});

export const layer = Layer.effect(GuestGrants, make);
