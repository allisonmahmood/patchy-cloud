/** Patches owns the audience decision. Membership and role facts belong to Companies. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { PatchAudience, SharingScope } from "@patchy/api";
import { Teams } from "@patchy/companies";
import type { Patch } from "./Patches.js";

export class InvalidAudienceTeams extends Schema.TaggedError<InvalidAudienceTeams>()(
  "InvalidAudienceTeams",
  {}
) {
  override get message() {
    return "Choose existing teams in this company that you can access.";
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
export type InvalidAudience = InvalidAudienceTeams | AudienceExcludesOwner;
export const company = (scope: typeof SharingScope.Type = "company"): PatchAudience => ({
  members: scope === "teams" ? { kind: "teams", teamIds: [] } : { kind: scope }
});
export const scopeOf = (audience: PatchAudience) => audience.members.kind;
/** The only member audience predicate. Account, tenant and lifecycle checks surround it. */
export const admits = (audience: PatchAudience, viewerTeams: ReadonlySet<string>) =>
  audience.members.kind !== "teams" || audience.members.teamIds.some((id) => viewerTeams.has(id));

export const forAuthenticatedMember = Effect.fn("Audiences.forAuthenticatedMember")(function* (
  companyId: string,
  userId: string,
  audiences: readonly PatchAudience[]
) {
  const teamIds = new Set(
    audiences.some((a) => a.members.kind === "teams")
      ? yield* Teams.memberships(companyId, userId)
      : []
  );
  return (audience: PatchAudience) => admits(audience, teamIds);
});
export const forPeople = Effect.fn("Audiences.forPeople")(function* (
  companyId: string,
  userIds: readonly string[]
) {
  const facts = yield* Teams.people(companyId, userIds);
  const people = new Map(facts.map((person) => [person.id, person]));
  return (userId: string, audience: PatchAudience) => {
    const person = people.get(userId);
    return person !== undefined && person.active && admits(audience, new Set(person.teamIds));
  };
});
export const forMember = Effect.fn("Audiences.forMember")(function* (
  companyId: string,
  userId: string
) {
  const facts = yield* Teams.people(companyId, [userId]);
  const viewer = facts[0];
  const teamIds = new Set(viewer?.teamIds ?? []);
  return (audience: PatchAudience) =>
    viewer !== undefined && viewer.active && admits(audience, teamIds);
});
export const canOpen = Effect.fn("Audiences.canOpen")(function* (
  patch: Pick<Patch, "companyId" | "audience" | "disabledAt">,
  companyId: string,
  userId: string
) {
  if (patch.disabledAt !== null || patch.companyId !== companyId) return false;
  return (yield* forMember(companyId, userId))(patch.audience);
});
/** Recheck the actor and owner under the caller's transaction, including inactive-owner repairs. */
export const validate = Effect.fn("Audiences.validate")(function* (input: {
  readonly audience: PatchAudience;
  readonly companyId: string;
  readonly actorId: string;
  readonly ownerId: string;
  readonly previous?: PatchAudience;
}) {
  const { audience, companyId, actorId, ownerId } = input;
  const people = yield* Teams.people(companyId, [actorId, ownerId]);
  const actor = people.find((p) => p.id === actorId);
  const owner = people.find((p) => p.id === ownerId);
  if (!actor?.active || !owner) return yield* new AudienceExcludesOwner();
  if (audience.members.kind !== "teams") return;
  if (!audience.members.teamIds.length) return yield* new InvalidAudienceTeams();
  const previous = input.previous?.members.kind === "teams" ? input.previous.members.teamIds : [];
  const newTeams = audience.members.teamIds.filter((id) => !previous.includes(id));
  const existing = new Set(
    (yield* Teams.list({ companyId, actorId }).pipe(
      Effect.catchTags({ RoleForbidden: () => Effect.fail(new AudienceExcludesOwner()) })
    )).map((t) => t.id)
  );
  if (
    newTeams.some(
      (id) => !existing.has(id) || (actor.role === "member" && !actor.teamIds.includes(id))
    )
  )
    return yield* new InvalidAudienceTeams();
  if (!admits(audience, new Set(owner.teamIds))) return yield* new AudienceExcludesOwner();
});
/** Scope and relational team grants commit together. Guest grants are independent and untouched. */
export const save = Effect.fn("Audiences.save")(function* (
  patchId: string,
  companyId: string,
  audience: PatchAudience
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE patches SET scope = ${scopeOf(audience)} WHERE id = ${patchId}`;
  yield* sql`DELETE FROM patch_audience_teams WHERE patch_id = ${patchId}`;
  if (audience.members.kind === "teams")
    yield* sql`INSERT INTO patch_audience_teams(patch_id, company_id, team_id)
      SELECT ${patchId}, ${companyId}, id FROM unnest(${[...new Set(audience.members.teamIds)]}::text[]) id`;
});
