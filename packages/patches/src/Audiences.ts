/** Patches owns audience authority. Callers consume this decision, never a role-based bypass. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { PatchAudience } from "@patchy/api";
import { Teams } from "@patchy/companies";

/** Temporary assembly barrier. Hosting must not enable this until #1287–#1291 are complete. */
export const Activation = Context.Reference<boolean>("@patchy/patches/AudienceActivation", {
  defaultValue: () => false
});
export class AudienceRequired extends Schema.TaggedError<AudienceRequired>()(
  "AudienceRequired",
  {}
) {
  override get message() {
    return "Choose who can open this patch before its first publish.";
  }
}
export class AudienceInactive extends Schema.TaggedError<AudienceInactive>()(
  "AudienceInactive",
  {}
) {
  override get message() {
    return "Team and company-guest audiences are unavailable until access enforcement is complete.";
  }
}
export class InvalidAudienceTeams extends Schema.TaggedError<InvalidAudienceTeams>()(
  "InvalidAudienceTeams",
  {}
) {
  override get message() {
    return "Choose existing teams in this company that you can access.";
  }
}
export class InvalidAudienceGuests extends Schema.TaggedError<InvalidAudienceGuests>()(
  "InvalidAudienceGuests",
  {}
) {
  override get message() {
    return "Choose active guests invited into this company space.";
  }
}
export class AudienceExcludesOwner extends Schema.TaggedError<AudienceExcludesOwner>()(
  "AudienceExcludesOwner",
  {}
) {
  override get message() {
    return "Choose an audience the owner can open.";
  }
}
export class AudienceScopeMismatch extends Schema.TaggedError<AudienceScopeMismatch>()(
  "AudienceScopeMismatch",
  {}
) {
  override get message() {
    return "The sharing scope must match the audience.";
  }
}
export type InvalidAudience =
  | AudienceRequired
  | AudienceInactive
  | InvalidAudienceTeams
  | InvalidAudienceGuests
  | AudienceExcludesOwner
  | AudienceScopeMismatch;
export const company = (scope: "company" | "public" = "company"): PatchAudience => ({
  members: { kind: scope },
  guests: { kind: "specific", userIds: [] }
});
export const scopeOf = (audience: PatchAudience) =>
  audience.members.kind === "public" ? ("public" as const) : ("company" as const);
export const encode = Schema.encodeSync(Schema.fromJsonString(PatchAudience));
const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      companyId: Schema.String,
      audience: PatchAudience,
      active: Schema.Boolean
    })
  )
);
const schemaErrors = { SchemaError: Effect.die } as const;
const restricted = (audience: PatchAudience) =>
  audience.members.kind === "teams" || audience.guests.kind === "all";

/** One membership read for an entire company discovery; ownership and role confer no grant. */
export const forMember = Effect.fn("Audiences.forMember")(function* (
  companyId: string,
  userId: string
) {
  const sql = yield* SqlClient.SqlClient;
  const active =
    yield* sql`SELECT id FROM users WHERE id = ${userId} AND company_id = ${companyId} AND deactivated_at IS NULL`;
  const teamIds = new Set(active.length ? yield* Teams.memberships(companyId, userId) : []);
  const enabled = yield* Activation;
  return (audience: PatchAudience) =>
    active.length > 0 &&
    (!restricted(audience) || enabled) &&
    (audience.members.kind !== "teams" || audience.members.teamIds.some((id) => teamIds.has(id)));
});

/** Authoritative current audience, also usable by downstream Runtime/CLI/MCP adapters. */
export const canOpen = Effect.fn("Audiences.canOpen")(function* (
  patchId: string,
  companyId: string,
  userId: string
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql`SELECT id, company_id AS "companyId", audience, disabled_at IS NULL AS active FROM patches WHERE id = ${patchId}`.pipe(
      Effect.flatMap(decodeRows),
      Effect.catchTags(schemaErrors)
    );
  const row = rows[0];
  if (!row || !row.active || row.companyId !== companyId) return false;
  return (yield* forMember(companyId, userId))(row.audience);
});

/** Validate before upload, then again under the publication/sharing transaction's company lock. */
export const validate = Effect.fn("Audiences.validate")(
  function* (input: {
    readonly audience: PatchAudience;
    readonly companyId: string;
    readonly actorId: string;
    readonly ownerId: string;
    readonly scope?: "company" | "public" | undefined;
    readonly previous?: PatchAudience;
  }) {
    const { audience, companyId, actorId, ownerId } = input;
    if (input.scope !== undefined && input.scope !== scopeOf(audience))
      return yield* new AudienceScopeMismatch();
    if (restricted(audience) && !(yield* Activation)) return yield* new AudienceInactive();
    const sql = yield* SqlClient.SqlClient;
    const actor =
      yield* sql`SELECT id FROM users WHERE id = ${actorId} AND company_id = ${companyId} AND deactivated_at IS NULL`;
    if (!actor.length) return yield* new AudienceExcludesOwner();
    const previousTeams =
      input.previous?.members.kind === "teams" ? input.previous.members.teamIds : [];
    const newTeams =
      audience.members.kind === "teams"
        ? audience.members.teamIds.filter((id) => !previousTeams.includes(id))
        : [];
    if (newTeams.length) {
      const teams = yield* Teams.list({ companyId, actorId });
      const allowed = new Set(teams.map((t) => t.id));
      if (newTeams.some((id) => !allowed.has(id))) return yield* new InvalidAudienceTeams();
      const admins =
        yield* sql`SELECT id FROM users WHERE id = ${actorId} AND (role = 'admin' OR is_regular_admin)`;
      if (!admins.length) {
        const memberships = new Set(yield* Teams.memberships(companyId, actorId));
        if (newTeams.some((id) => !memberships.has(id))) return yield* new InvalidAudienceTeams();
      }
    }
    if (!(yield* forMember(companyId, ownerId))(audience))
      return yield* new AudienceExcludesOwner();
    const ids =
      audience.guests.kind === "all" ? audience.guests.excludedUserIds : audience.guests.userIds;
    const previousIds =
      input.previous?.guests.kind === audience.guests.kind
        ? input.previous.guests.kind === "specific"
          ? input.previous.guests.userIds
          : input.previous.guests.excludedUserIds
        : [];
    for (const userId of new Set(ids.filter((id) => !previousIds.includes(id)))) {
      const guests =
        yield* sql`SELECT g.user_id FROM company_patch_guests g JOIN users u ON u.id = g.user_id WHERE g.company_id = ${companyId} AND g.user_id = ${userId} AND g.removed_at IS NULL AND u.deactivated_at IS NULL AND u.company_id <> ${companyId}`;
      if (!guests.length) return yield* new InvalidAudienceGuests();
    }
  },
  Effect.catchTags({ RoleForbidden: () => Effect.fail(new AudienceExcludesOwner()) })
);

/** Called inside the patch transaction. Revision, references and wake commit together. */
export const save = Effect.fn("Audiences.save")(function* (
  patchId: string,
  companyId: string,
  audience: PatchAudience,
  actorId: string
) {
  const sql = yield* SqlClient.SqlClient;
  const changed =
    yield* sql`UPDATE patches SET audience = ${encode(audience)}::jsonb, audience_revision = audience_revision + 1 WHERE id = ${patchId} AND audience IS DISTINCT FROM ${encode(audience)}::jsonb RETURNING id`;
  if (!changed.length) return;
  yield* sql`DELETE FROM patch_audience_teams WHERE patch_id = ${patchId}`;
  if (audience.members.kind === "teams")
    for (const teamId of new Set(audience.members.teamIds)) {
      yield* sql`INSERT INTO patch_audience_teams(patch_id, company_id, team_id) VALUES (${patchId}, ${companyId}, ${teamId})`;
    }
  // Keep the existing named-grant history and attribution when changing the audience.
  if (audience.guests.kind === "specific") {
    yield* sql`UPDATE patch_guest_grants SET revoked_at = now() WHERE patch_id = ${patchId} AND revoked_at IS NULL AND NOT (user_id = ANY(${[...audience.guests.userIds]}::text[]))`;
    for (const userId of new Set(audience.guests.userIds)) {
      yield* sql`INSERT INTO patch_guest_grants(patch_id, company_id, user_id, granted_by, granted_at)
        VALUES (${patchId}, ${companyId}, ${userId}, ${actorId}, now())
        ON CONFLICT(patch_id, user_id) DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at WHERE patch_guest_grants.revoked_at IS NOT NULL`;
    }
  }
  yield* sql`SELECT pg_notify('patchy_runtime_wakes', json_build_object('keys', ARRAY[${`patch:${patchId}`}])::text)`;
});
/** Patches-owned reference knowledge for Hosting's later guarded team deletion. */
export const references = Effect.fn("Audiences.references")(function* (
  companyId: string,
  teamId: string
) {
  const sql = yield* SqlClient.SqlClient;
  return (
    (yield* sql`SELECT patch_id FROM patch_audience_teams WHERE company_id = ${companyId} AND team_id = ${teamId} LIMIT 1`)
      .length > 0
  );
});
