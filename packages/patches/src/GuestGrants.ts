/** Patch-scoped guest grants. Callers hold the patch row lock for writes. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { newInternalId } from "@patchy/core";

const EndReason = Schema.Literals(["revoked", "public", "reclaimed", "guest_ended"]);
export type EndReason = typeof EndReason.Type;

export class Grant extends Schema.Class<Grant>("PatchGuestGrant")({
  id: Schema.String,
  companyId: Schema.String,
  patchId: Schema.String,
  guestId: Schema.String,
  grantedAt: Schema.Date,
  endedAt: Schema.NullOr(Schema.Date),
  endReason: Schema.NullOr(EndReason)
}) {}

export class GuestUnavailable extends Schema.TaggedError<GuestUnavailable>()(
  "GrantGuestUnavailable",
  { companyId: Schema.String, guestId: Schema.String }
) {
  override get message() {
    return "This guest relationship is not active in the patch's company.";
  }
}

export class GuestDeactivated extends Schema.TaggedError<GuestDeactivated>()(
  "GrantGuestDeactivated",
  { companyId: Schema.String, guestId: Schema.String }
) {
  override get message() {
    return "This guest relationship is deactivated.";
  }
}

export class AlreadyGranted extends Schema.TaggedError<AlreadyGranted>()("AlreadyGranted", {
  patchId: Schema.String,
  guestId: Schema.String
}) {
  override get message() {
    return "This guest already has a grant to the patch.";
  }
}

export interface Ref {
  readonly companyId: string;
  readonly patchId: string;
  readonly guestId: string;
}

export type Access = "active" | "deactivated" | "revoked" | "ended" | "unavailable";
export interface Lookup {
  readonly grant: Grant;
  readonly access: Access;
}

const columns = `id, company_id AS "companyId", patch_id AS "patchId",
  guest_id AS "guestId", granted_at AS "grantedAt", ended_at AS "endedAt",
  end_reason AS "endReason"`;
const dieOnSchemaError = { SchemaError: Effect.die } as const;

/** The patch's row lock is held by Patches before this is called. */
export const grant = Effect.fn("GuestGrants.grant")(function* (input: Ref) {
  const sql = yield* SqlClient.SqlClient;
  // Lock the guest relationship too: deactivation and member conversion must
  // commit before or after creation, never between its check and insert.
  const guest = yield* sql`SELECT deactivated_at, ended_at FROM company_guests
    WHERE id = ${input.guestId} AND company_id = ${input.companyId} FOR UPDATE`;
  if (guest.length === 0 || guest[0]!.ended_at !== null) return yield* new GuestUnavailable(input);
  if (guest[0]!.deactivated_at !== null) return yield* new GuestDeactivated(input);
  const insert = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      patchId: Schema.String,
      guestId: Schema.String,
      id: Schema.String
    }),
    Result: Grant,
    execute: ({ companyId, patchId, guestId, id }) =>
      sql.unsafe(
        `INSERT INTO patch_guest_grants (id, company_id, patch_id, guest_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING ${columns}`,
        [id, companyId, patchId, guestId]
      )
  });
  const inserted = yield* insert({ ...input, id: newInternalId("grt") }).pipe(
    Effect.catchTags(dieOnSchemaError)
  );
  if (Option.isNone(inserted)) return yield* new AlreadyGranted(input);
  return inserted.value;
});

/** A revoked grant remains terminal; a later explicit share creates a new ID. */
export const revoke = Effect.fn("GuestGrants.revoke")(function* (input: Ref) {
  const sql = yield* SqlClient.SqlClient;
  const row = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      patchId: Schema.String,
      guestId: Schema.String
    }),
    Result: Grant,
    execute: ({ companyId, patchId, guestId }) =>
      sql.unsafe(
        `UPDATE patch_guest_grants SET ended_at = now(), end_reason = 'revoked'
         WHERE company_id = $1 AND patch_id = $2 AND guest_id = $3 AND ended_at IS NULL
         RETURNING ${columns}`,
        [companyId, patchId, guestId]
      )
  });
  return yield* row(input).pipe(Effect.catchTags(dieOnSchemaError), Effect.map(Option.getOrNull));
});

/** Called in the same transaction as public transition or permanent reclamation. */
export const endForPatch = Effect.fn("GuestGrants.endForPatch")(function* (
  patchId: string,
  reason: "public" | "reclaimed"
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE patch_guest_grants SET ended_at = now(), end_reason = ${reason}
    WHERE patch_id = ${patchId} AND ended_at IS NULL`;
});

/** Read-only storage decision; serving admission is a later ticket. */
export const lookup = Effect.fn("GuestGrants.lookup")(function* (input: Ref) {
  const sql = yield* SqlClient.SqlClient;
  const row = SqlSchema.findOneOption({
    Request: Schema.Struct({
      companyId: Schema.String,
      patchId: Schema.String,
      guestId: Schema.String
    }),
    Result: Schema.Struct({
      ...Grant.fields,
      deactivated: Schema.Boolean,
      patchOpen: Schema.Boolean
    }),
    execute: ({ companyId, patchId, guestId }) =>
      sql.unsafe(
        `SELECT g.id, g.company_id AS "companyId", g.patch_id AS "patchId",
          g.guest_id AS "guestId", g.granted_at AS "grantedAt",
          g.ended_at AS "endedAt", g.end_reason AS "endReason",
          guest.deactivated_at IS NOT NULL AS deactivated,
          (patches.id IS NOT NULL AND patches.scope = 'company'
            AND patches.deleted_at IS NULL AND patches.retired_at IS NULL
            AND patches.disabled_at IS NULL AND patches.current_version_id IS NOT NULL)
            AS "patchOpen"
         FROM patch_guest_grants g
         JOIN company_guests guest ON guest.id = g.guest_id AND guest.company_id = g.company_id
         LEFT JOIN patches ON patches.id = g.patch_id AND patches.company_id = g.company_id
         WHERE g.company_id = $1 AND g.patch_id = $2 AND g.guest_id = $3
         ORDER BY g.grant_number DESC LIMIT 1`,
        [companyId, patchId, guestId]
      )
  });
  const found = yield* row(input).pipe(Effect.catchTags(dieOnSchemaError));
  if (Option.isNone(found)) return null;
  const { deactivated, patchOpen, ...fields } = found.value;
  const grant = new Grant(fields);
  const access: Access =
    grant.endReason === "revoked"
      ? "revoked"
      : grant.endedAt !== null
        ? "ended"
        : deactivated
          ? "deactivated"
          : patchOpen
            ? "active"
            : "unavailable";
  return { grant, access } satisfies Lookup;
});
