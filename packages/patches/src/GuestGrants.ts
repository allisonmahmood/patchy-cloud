/**
 * Guests: people at another company whom a company shares one patch with. A grant names the
 * person and the patch; revoking it keeps the row, ended, so history still names them, and
 * sharing again restores it. Whether guests may open a patch at all is `unavailable`, the one
 * rule every door and surface asks.
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
import { PatchState } from "@patchy/api";
import type { Patch, PatchVersion } from "./Patches.js";

/**
 * Why a patch's guests can't open it, as codes with their facts: whoever shows one words it.
 * A guest may see the reason, so they can pass it on. An operator-disabled patch needs none: it
 * is absent at every door and in every list.
 */
export const Reason = Schema.TaggedUnion({
  Retired: {},
  Deleted: {},
  /** Guests open tier 1 pages. */
  Tier: { tier: Schema.Int }
});
export type Reason = typeof Reason.Type;

/** Why guests can't open this patch at this version, or none when they can. */
export const unavailable = (
  patch: Pick<Patch, "state">,
  version: Pick<PatchVersion, "tier">
): Option.Option<Reason> => {
  if (patch.state === "retired") return Option.some(Reason.cases.Retired.make({}));
  if (patch.state === "deleted") return Option.some(Reason.cases.Deleted.make({}));
  if (version.tier !== 1) return Option.some(Reason.cases.Tier.make({ tier: version.tier }));
  return Option.none();
};

/** Whether this version admits the patch's guests: only its current version, while available. */
export const admitsGuests = (
  patch: Pick<Patch, "state" | "currentVersionId">,
  version: Pick<PatchVersion, "id" | "tier">
) => patch.currentVersionId === version.id && Option.isNone(unavailable(patch, version));

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
  tier: Schema.Int
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
    readonly sharedWith: (userId: string) => Effect.Effect<ReadonlyArray<Shared>, SqlError>;
    /** The patch's company, while this person holds an active grant to it. */
    readonly host: (input: {
      readonly patchId: string;
      readonly companyId: string;
      readonly userId: string;
    }) => Effect.Effect<Option.Option<Host>, SqlError>;
  }
>()("@patchy/patches/GuestGrants") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;

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
        c.name AS "companyName", g.granted_at AS "grantedAt",
        CASE WHEN p.retired_at IS NOT NULL THEN 'retired' ELSE 'live' END AS state, v.tier
      FROM patch_guest_grants g
      JOIN patches p ON p.id = g.patch_id
      JOIN patch_versions v ON v.id = p.current_version_id
      JOIN companies c ON c.id = g.company_id
      WHERE g.user_id = ${userId} AND g.revoked_at IS NULL
        AND p.deleted_at IS NULL AND p.disabled_at IS NULL
      ORDER BY c.name, p.name`
  });
  const hostRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      patchId: Schema.String,
      companyId: Schema.String,
      userId: Schema.String
    }),
    Result: Host,
    execute: ({ patchId, companyId, userId }) => sql`
      SELECT c.id, c.handle, c.name FROM patch_guest_grants g
      JOIN companies c ON c.id = g.company_id
      WHERE g.patch_id = ${patchId} AND g.company_id = ${companyId}
        AND g.user_id = ${userId} AND g.revoked_at IS NULL`
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
    return rows.map((row): Shared => ({
      patchId: row.patchId,
      name: row.name,
      title: row.title,
      company: { handle: row.companyHandle, name: row.companyName },
      grantedAt: row.grantedAt,
      unavailable: unavailable({ state: row.state }, { tier: row.tier })
    }));
  }, Effect.catchTags(dieOnSchemaError));
  const host = Effect.fn("GuestGrants.host")(
    (input: { readonly patchId: string; readonly companyId: string; readonly userId: string }) =>
      hostRow(input),
    Effect.catchTags(dieOnSchemaError)
  );
  return GuestGrants.of({ grant, revoke, guests, sharedWith, host });
});

export const layer = Layer.effect(GuestGrants, make);
