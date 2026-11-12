/**
 * Who may open a patch, decided here and only here. Companies owns who is on which team and the
 * team rule every audience shares; callers load those facts and ask `admits`. Guest grants are
 * separate and add to an audience.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  MAX_AUDIENCE_TEAMS,
  type PatchAudience,
  type ReportedAudience,
  type SharingScope
} from "@patchy/api";
import { Teams } from "@patchy/companies";

export class InvalidAudienceTeams extends Schema.TaggedError<InvalidAudienceTeams>()(
  "InvalidAudienceTeams",
  { cause: Schema.optionalKey(Schema.Defect()) }
) {
  override get message() {
    return `Choose 1 to ${MAX_AUDIENCE_TEAMS} existing teams in this company.`;
  }
}
export class AudienceExcludesOwner extends Schema.TaggedError<AudienceExcludesOwner>()(
  "AudienceExcludesOwner",
  {}
) {
  override get message() {
    return "Choose an audience its owner can open: Company, Public, or a team they are on.";
  }
}
/** A request naming only a scope, as clients before team audiences send, for a team patch. */
export class UpgradeRequired extends Schema.TaggedError<UpgradeRequired>()("UpgradeRequired", {
  patchId: Schema.String
}) {
  override get message() {
    return "This patch is open to selected teams, which this client can't describe. Nothing was changed.";
  }
}
export type InvalidAudience = InvalidAudienceTeams | AudienceExcludesOwner;

/** A person as admission reads them: whether they are active, and their recorded teams. */
export interface Person {
  readonly active: boolean;
  readonly teamIds: readonly string[];
}

/**
 * Whether a person may open a patch with this audience: they are active, and `Teams.admits` lets
 * them in by their teams. Company, lifecycle and credential checks surround it.
 */
export const admits = (audience: PatchAudience, person: Person | undefined) =>
  person !== undefined && person.active && Teams.admits(audience, person.teamIds);

/** Each team once, in id order, as a stored audience reads back. */
export const normal = (audience: PatchAudience): PatchAudience =>
  audience.kind === "teams"
    ? { kind: "teams", teamIds: [...new Set(audience.teamIds)].sort() }
    : audience;

/** The audience as a client released before team audiences reads it. */
export const scopeOf = (audience: PatchAudience): typeof SharingScope.Type =>
  audience.kind === "public" ? "public" : "company";

/** The audience a `patches` row stores: its scope column, and its team rows for `teams`. */
export const stored = (scope: "company" | "public" | "teams", teamIds: readonly string[]) =>
  scope === "teams"
    ? ({ kind: "teams", teamIds } satisfies PatchAudience)
    : ({ kind: scope } satisfies PatchAudience);

/** With each team's name, in name order, as responses and the owner's history report it. */
export const report = (
  audience: PatchAudience,
  names: ReadonlyMap<string, string>
): ReportedAudience =>
  audience.kind === "teams"
    ? {
        kind: "teams",
        teams: audience.teamIds
          .map((id) => ({ id, name: names.get(id) ?? id }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      }
    : audience;

/** Whether `after` leaves out someone `before` admitted: a dependant's readers may lose it. */
export const narrows = (before: PatchAudience, after: PatchAudience) =>
  after.kind === "teams" &&
  (before.kind !== "teams" || before.teamIds.some((id) => !after.teamIds.includes(id)));

/**
 * Whether the audience may be saved for this owner: named teams exist and number at most the
 * cap, and it includes the owner. A deactivated owner's recorded teams count, so an admin can
 * still change a deactivated owner's patch. Anyone who may set an audience may name any team.
 */
export const check = (
  audience: PatchAudience,
  owner: Person | undefined,
  existing: ReadonlySet<string>
) => {
  if (audience.kind === "teams") {
    const teamIds = new Set(audience.teamIds);
    if (
      teamIds.size === 0 ||
      teamIds.size > MAX_AUDIENCE_TEAMS ||
      [...teamIds].some((id) => !existing.has(id))
    )
      return Effect.fail(new InvalidAudienceTeams());
  }
  if (owner === undefined || !admits(audience, { ...owner, active: true }))
    return Effect.fail(new AudienceExcludesOwner());
  return Effect.void;
};

/** Every patch whose audience names the team, in any lifecycle state. */
export const patchesUsingTeam = Effect.fn("Audiences.patchesUsingTeam")(function* (
  companyId: string,
  teamId: string
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly patchId: string }>`SELECT patch_id AS "patchId"
    FROM patch_audience_teams WHERE company_id = ${companyId} AND team_id = ${teamId}`;
  return rows.map((row) => row.patchId);
});
