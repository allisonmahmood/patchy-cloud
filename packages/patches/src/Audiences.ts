/** Patches owns audience authority. Callers consume this decision, never a role-based bypass. */
import * as Clock from "effect/Clock";
import { AudienceActivation } from "@patchy/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { PatchAudience } from "@patchy/api";
import { Teams } from "@patchy/companies";
import type { Patch } from "./Patches.js";

/** Temporary assembly barrier. Hosting must not enable this until #1287–#1291 are complete. */
export const Activation = AudienceActivation;
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
const restricted = (audience: PatchAudience) =>
  audience.members.kind === "teams" || audience.guests.kind === "all";

const admits = (audience: PatchAudience, teamIds: ReadonlySet<string>, enabled: boolean) =>
  (!restricted(audience) || enabled) &&
  (audience.members.kind !== "teams" || audience.members.teamIds.some((id) => teamIds.has(id)));

/** One Companies batch supplies current eligibility for all candidate owners. */
export const forPeople = Effect.fn("Audiences.forPeople")(function* (
  companyId: string,
  userIds: readonly string[]
) {
  const enabled = yield* Activation;
  const facts = yield* Teams.membershipFacts(companyId, userIds);
  const people = new Map(facts.map((fact) => [fact.userId, new Set(fact.teamIds)]));
  return (userId: string, audience: PatchAudience) => {
    const teams = people.get(userId);
    return teams !== undefined && admits(audience, teams, enabled);
  };
});

/** Reuse current authentication; Company/Public need no membership query. */
export const forAuthenticatedMember = Effect.fn("Audiences.forAuthenticatedMember")(function* (
  companyId: string,
  userId: string,
  audiences: readonly PatchAudience[]
) {
  const enabled = yield* Activation;
  const needsTeams = enabled && audiences.some((audience) => audience.members.kind === "teams");
  const teamIds = new Set(needsTeams ? yield* Teams.memberships(companyId, userId) : []);
  return (audience: PatchAudience) => admits(audience, teamIds, enabled);
});

/** One current-person lookup and at most one membership lookup for the whole result set. */
export const forMember = Effect.fn("Audiences.forMember")(function* (
  companyId: string,
  userId: string,
  audiences: readonly PatchAudience[]
) {
  const sql = yield* SqlClient.SqlClient;
  const active =
    yield* sql`SELECT id FROM users WHERE id = ${userId} AND company_id = ${companyId} AND deactivated_at IS NULL`;
  if (!active.length) return () => false;
  return yield* forAuthenticatedMember(companyId, userId, audiences);
});

/** Evaluate the current patch already loaded by the caller; never reload that patch. */
export const canOpen = Effect.fn("Audiences.canOpen")(function* (
  patch: Pick<Patch, "companyId" | "audience" | "disabledAt">,
  companyId: string,
  userId: string
) {
  if (patch.disabledAt !== null || patch.companyId !== companyId) return false;
  return (yield* forMember(companyId, userId, [patch.audience]))(patch.audience);
});

const decodePeople = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      admin: Schema.Boolean
    })
  )
);

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
    const people = yield* sql`SELECT id, (role = 'admin' OR is_regular_admin) AS admin FROM users
      WHERE id = ANY(${[actorId, ownerId]}::text[]) AND company_id = ${companyId} AND deactivated_at IS NULL`.pipe(
      Effect.flatMap(decodePeople),
      Effect.catchTags({ SchemaError: Effect.die })
    );
    const actor = people.find((person) => person.id === actorId);
    if (!actor || !people.some((person) => person.id === ownerId))
      return yield* new AudienceExcludesOwner();
    const previousTeams =
      input.previous?.members.kind === "teams" ? input.previous.members.teamIds : [];
    const newTeams =
      audience.members.kind === "teams"
        ? audience.members.teamIds.filter((id) => !previousTeams.includes(id))
        : [];
    const actorTeams = new Set(
      audience.members.kind === "teams" &&
        (actorId === ownerId || (!actor.admin && newTeams.length))
        ? yield* Teams.memberships(companyId, actorId)
        : []
    );
    if (newTeams.length) {
      const teams = new Set((yield* Teams.list({ companyId, actorId })).map((team) => team.id));
      if (newTeams.some((id) => !teams.has(id) || (!actor.admin && !actorTeams.has(id))))
        return yield* new InvalidAudienceTeams();
    }
    if (audience.members.kind === "teams") {
      const ownerTeams =
        actorId === ownerId ? actorTeams : new Set(yield* Teams.memberships(companyId, ownerId));
      if (!audience.members.teamIds.some((id) => ownerTeams.has(id)))
        return yield* new AudienceExcludesOwner();
    }
    const ids =
      audience.guests.kind === "all" ? audience.guests.excludedUserIds : audience.guests.userIds;
    const previousIds =
      input.previous?.guests.kind === audience.guests.kind
        ? input.previous.guests.kind === "specific"
          ? input.previous.guests.userIds
          : input.previous.guests.excludedUserIds
        : [];
    const selected = [...new Set(ids.filter((id) => !previousIds.includes(id)))];
    if (selected.length) {
      const guests =
        yield* sql`SELECT g.user_id FROM company_patch_guests g JOIN users u ON u.id = g.user_id
        WHERE g.company_id = ${companyId} AND g.user_id = ANY(${selected}::text[])
          AND g.removed_at IS NULL AND u.deactivated_at IS NULL AND u.company_id <> ${companyId}`;
      if (guests.length !== selected.length) return yield* new InvalidAudienceGuests();
    }
  },
  Effect.catchTags({ RoleForbidden: () => Effect.fail(new AudienceExcludesOwner()) })
);

const decodeLocked = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      companyId: Schema.String,
      audience: PatchAudience,
      allowed: Schema.optionalKey(Schema.Boolean)
    })
  )
);
const schemaErrors = { SchemaError: Effect.die } as const;
const notify = (patchId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) =>
      sql`SELECT pg_notify('patchy_runtime_wakes', json_build_object('keys', ARRAY[${`patch:${patchId}`}])::text)`
  );

/** The sole audience writer: references, named-grant history, revision and wake commit together. */
export const save = Effect.fn("Audiences.save")(function* (
  patchId: string,
  companyId: string,
  audience: PatchAudience,
  actorId: string
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  const encoded = encode(audience);
  const changed =
    yield* sql`UPDATE patches SET audience = ${encoded}::jsonb, audience_revision = audience_revision + 1
    WHERE id = ${patchId} AND audience IS DISTINCT FROM ${encoded}::jsonb RETURNING id`;
  if (!changed.length) return false;
  yield* sql`DELETE FROM patch_audience_teams WHERE patch_id = ${patchId}`;
  if (audience.members.kind === "teams") {
    yield* sql`INSERT INTO patch_audience_teams(patch_id, company_id, team_id)
      SELECT ${patchId}, ${companyId}, id FROM unnest(${[...new Set(audience.members.teamIds)]}::text[]) id`;
  }
  if (audience.guests.kind === "specific") {
    const ids = [...new Set(audience.guests.userIds)];
    yield* sql`UPDATE patch_guest_grants SET revoked_at = to_timestamp(${at / 1_000})
      WHERE patch_id = ${patchId} AND revoked_at IS NULL AND NOT (user_id = ANY(${ids}::text[]))`;
    if (ids.length)
      yield* sql`INSERT INTO patch_guest_grants(patch_id, company_id, user_id, granted_by, granted_at)
      SELECT ${patchId}, ${companyId}, id, ${actorId}, to_timestamp(${at / 1_000}) FROM unnest(${ids}::text[]) id
      ON CONFLICT(patch_id, user_id) DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by,
        granted_at = EXCLUDED.granted_at WHERE patch_guest_grants.revoked_at IS NOT NULL`;
  }
  yield* notify(patchId);
  return true;
});

/** Guest adapters use the same writer as publish and sharing, under the patch row lock. */
export const changeGuest = Effect.fn("Audiences.changeGuest")(function* (input: {
  readonly patchId: string;
  readonly userId: string;
  readonly added: boolean;
  readonly actorId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const assembled = yield* Activation;
  const rows =
    yield* sql`SELECT id, company_id AS "companyId", audience, patch_guest_allowed(patches, ${input.userId}, ${assembled}, true) AS allowed FROM patches WHERE id = ${input.patchId} FOR UPDATE`.pipe(
      Effect.flatMap(decodeLocked),
      Effect.catchTags(schemaErrors)
    );
  const patch = rows[0];
  if (!patch) return false;
  if (input.added) {
    yield* sql`INSERT INTO company_patch_guests(company_id, user_id, added_by)
      VALUES (${patch.companyId}, ${input.userId}, ${input.actorId})
      ON CONFLICT(company_id, user_id) DO UPDATE SET removed_at = NULL, added_by = EXCLUDED.added_by
        WHERE company_patch_guests.removed_at IS NOT NULL`;
  }
  const { guests } = patch.audience;
  const previous = guests.kind === "specific" ? guests.userIds : guests.excludedUserIds;
  const include = guests.kind === "specific" ? input.added : !input.added;
  const ids = include
    ? [...new Set([...previous, input.userId])]
    : previous.filter((id) => id !== input.userId);
  const audience = {
    ...patch.audience,
    guests:
      guests.kind === "specific"
        ? { kind: "specific" as const, userIds: ids }
        : { kind: "all" as const, excludedUserIds: ids }
  };
  const changed =
    input.added || patch.allowed
      ? yield* save(patch.id, patch.companyId, audience, input.actorId)
      : false;
  // Explicit shares through an inherited all-guests audience still retain their attribution.
  const at = yield* Clock.currentTimeMillis;
  if (guests.kind === "all" && input.added) {
    yield* sql`INSERT INTO patch_guest_grants(patch_id, company_id, user_id, granted_by, granted_at)
      VALUES (${patch.id}, ${patch.companyId}, ${input.userId}, ${input.actorId}, to_timestamp(${at / 1_000}))
      ON CONFLICT(patch_id, user_id) DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by,
        granted_at = EXCLUDED.granted_at WHERE patch_guest_grants.revoked_at IS NOT NULL`;
  }
  if (!input.added) {
    const ended = yield* sql`UPDATE patch_guest_grants SET revoked_at = to_timestamp(${at / 1_000})
      WHERE patch_id = ${patch.id} AND user_id = ${input.userId} AND revoked_at IS NULL RETURNING user_id`;
    return changed || ended.length > 0;
  }
  return changed;
});

/** End company membership and every named grant without leaving a second audience write path. */
export const removeCompanyGuest = Effect.fn("Audiences.removeCompanyGuest")(function* (input: {
  readonly companyId: string;
  readonly userId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const patches = yield* sql`SELECT id, company_id AS "companyId", audience FROM patches
    WHERE company_id = ${input.companyId} AND audience->'guests'->>'kind' = 'specific'
      AND audience->'guests'->'userIds' ? ${input.userId} ORDER BY id FOR UPDATE`.pipe(
    Effect.flatMap(decodeLocked),
    Effect.catchTags(schemaErrors)
  );
  for (const patch of patches) {
    if (patch.audience.guests.kind !== "specific") continue;
    yield* save(
      patch.id,
      patch.companyId,
      {
        ...patch.audience,
        guests: {
          kind: "specific",
          userIds: patch.audience.guests.userIds.filter((id) => id !== input.userId)
        }
      },
      input.userId
    );
  }
  const at = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE company_patch_guests SET removed_at = to_timestamp(${at / 1_000})
    WHERE company_id = ${input.companyId} AND user_id = ${input.userId} AND removed_at IS NULL`;
  yield* sql`UPDATE patch_guest_grants SET revoked_at = to_timestamp(${at / 1_000})
    WHERE company_id = ${input.companyId} AND user_id = ${input.userId} AND revoked_at IS NULL`;
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
