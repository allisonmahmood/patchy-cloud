import * as Context from "effect/Context";
import type { SqlError } from "effect/sql/SqlError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Cryptography } from "@patchy/core";
import { lockAdministrator, Role, RoleForbidden, UserNotFound } from "./Users.js";

export class Team extends Schema.Class<Team>("Team")({
  id: Schema.String,
  companyId: Schema.String,
  name: Schema.String,
  createdAt: Schema.Date,
  deletedAt: Schema.NullOr(Schema.Date)
}) {}
export class MembershipChange extends Schema.Class<MembershipChange>("MembershipChange")({
  revision: Schema.String,
  teamId: Schema.String,
  userId: Schema.String,
  actorId: Schema.String,
  added: Schema.Boolean,
  createdAt: Schema.Date
}) {}
export class InvalidTeamName extends Schema.TaggedError<InvalidTeamName>()("InvalidTeamName", {
  length: Schema.Int
}) {
  override get message() {
    return "Use a team name between 1 and 100 characters.";
  }
}
export class TeamNameTaken extends Schema.TaggedError<TeamNameTaken>()("TeamNameTaken", {
  companyId: Schema.String
}) {
  override get message() {
    return "A team with that name already exists.";
  }
}
export class TeamNotFound extends Schema.TaggedError<TeamNotFound>()("TeamNotFound", {
  teamId: Schema.String
}) {
  override get message() {
    return "Team not found.";
  }
}
/** Hosting supplies cross-capability reference knowledge. Missing assembly refuses deletion. */
export const References = Context.Reference<
  (companyId: string, teamId: string) => Effect.Effect<boolean, SqlError, SqlClient.SqlClient>
>("@patchy/companies/Teams/References", { defaultValue: () => () => Effect.succeed(true) });
export class TeamInUse extends Schema.TaggedError<TeamInUse>()("TeamInUse", {
  teamId: Schema.String
}) {
  override get message() {
    return "This team is used by patches or connections. Change their audiences before deleting it.";
  }
}
export interface Viewer {
  readonly companyId: string;
  readonly actorId: string;
}
export interface TeamRef extends Viewer {
  readonly teamId: string;
}
const decodeTeams = Schema.decodeUnknownEffect(Schema.Array(Team));
const schemaError = { SchemaError: Effect.die } as const;
const ref = Schema.Struct({ companyId: Schema.String, teamId: Schema.String });
const find = SqlSchema.findOneOption({
  Request: ref,
  Result: Team,
  execute: ({ companyId, teamId }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT id, company_id AS "companyId", name, created_at AS "createdAt", deleted_at AS "deletedAt" FROM company_teams WHERE company_id = ${companyId} AND id = ${teamId}`
    )
});
// Active, recorded memberships are the sole source of team admission.
const effectiveMemberships = (
  sql: SqlClient.SqlClient,
  companyId: string,
  selection: { readonly userIds?: readonly string[]; readonly teamId?: string } = {}
) => sql`
  SELECT m.company_id, m.team_id, m.user_id FROM company_team_members m
  JOIN users u ON u.company_id = m.company_id AND u.id = m.user_id
  JOIN company_teams t ON t.company_id = m.company_id AND t.id = m.team_id AND t.deleted_at IS NULL
  WHERE m.company_id = ${companyId} AND u.deactivated_at IS NULL
    ${selection.userIds ? sql`AND m.user_id = ANY(${selection.userIds}::text[])` : sql``}
    ${selection.teamId ? sql`AND m.team_id = ${selection.teamId}` : sql``}
`;

// Both directory and roster queries apply this decision in their own SQL snapshot.
const visibleTeams = (sql: SqlClient.SqlClient, viewer: Viewer) => sql`
  SELECT t.id, t.company_id, t.name, t.created_at, t.deleted_at FROM company_teams t
  JOIN users u ON u.company_id = t.company_id AND u.id = ${viewer.actorId}
  WHERE t.company_id = ${viewer.companyId} AND u.deactivated_at IS NULL AND t.deleted_at IS NULL
  AND (u.role IN ('admin', 'super_admin') OR EXISTS (
    SELECT 1 FROM (${effectiveMemberships(sql, viewer.companyId, { userIds: [viewer.actorId] })}) m WHERE m.team_id = t.id
  ))`;
const listRows = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, actorId: Schema.String }),
  Result: Team,
  execute: (viewer) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT id, company_id AS "companyId", name, created_at AS "createdAt", deleted_at AS "deletedAt" FROM (${visibleTeams(sql, viewer)}) visible ORDER BY lower(name), id`
    )
});
const active = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
  Result: Schema.Struct({ id: Schema.String, role: Role }),
  execute: ({ companyId, userId }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT id, role FROM users WHERE company_id = ${companyId} AND id = ${userId} AND deactivated_at IS NULL`
    )
});
const memberRows = SqlSchema.findOneOption({
  Request: Schema.Struct({ ...ref.fields, actorId: Schema.String }),
  Result: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  execute: (input) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`
        SELECT ARRAY(
          SELECT m.user_id FROM (${effectiveMemberships(sql, input.companyId, { teamId: input.teamId })}) m
          ORDER BY m.user_id
        ) AS ids
        FROM (${visibleTeams(sql, input)}) visible WHERE visible.id = ${input.teamId}`
    )
});
const membershipRows = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
  Result: Schema.Struct({ id: Schema.String }),
  execute: ({ companyId, userId }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT team_id AS id FROM (${effectiveMemberships(sql, companyId, { userIds: [userId] })}) m WHERE user_id = ${userId} ORDER BY team_id`
    )
});
const changeRows = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, after: Schema.String }),
  Result: MembershipChange,
  execute: ({ companyId, after }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT revision::text, team_id AS "teamId", user_id AS "userId", actor_id AS "actorId", added, created_at AS "createdAt" FROM company_team_changes WHERE company_id = ${companyId} AND revision > ${after}::bigint ORDER BY revision LIMIT 100`
    )
});
const requireViewer = Effect.fn("Teams.requireViewer")(function* (viewer: Viewer) {
  const rows = yield* active({ companyId: viewer.companyId, userId: viewer.actorId }).pipe(
    Effect.catchTags(schemaError)
  );
  if (rows.length === 0) return yield* new RoleForbidden(viewer);
});
const requireTeam = Effect.fn("Teams.requireTeam")(function* (input: TeamRef) {
  const team = yield* find(input).pipe(Effect.catchTags(schemaError));
  if (Option.isNone(team) || team.value.deletedAt !== null)
    return yield* new TeamNotFound({ teamId: input.teamId });
  return team.value;
});
// NOTIFY is transactional in PostgreSQL: even an enclosing transaction/savepoint must commit.
// Reuse the directory revision and members wake; there is no independent permission bus.
const advanceRevision = SqlSchema.findAll({
  Request: Schema.String,
  Result: Schema.Struct({ revision: Schema.String }),
  execute: (companyId) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`INSERT INTO companies_directory(company_id, revision) VALUES (${companyId}, 1) ON CONFLICT(company_id) DO UPDATE SET revision = companies_directory.revision + 1 RETURNING revision::text`
    )
});
const changed = Effect.fn("Teams.changed")(function* (companyId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* advanceRevision(companyId).pipe(Effect.catchTags(schemaError));
  const revision = rows[0]!.revision;
  yield* sql`SELECT pg_notify('patchy_runtime_wakes', json_build_object('keys', ARRAY[${`members:${companyId}`}])::text)`;
  return revision;
});
const nameOf = Effect.fn("Teams.nameOf")(function* (value: string) {
  const name = value.trim().replace(/\s+/gu, " ");
  const length = Array.from(name).length;
  if (length < 1 || length > 100) return yield* new InvalidTeamName({ length });
  return name;
});
export const list = Effect.fn("Teams.list")(function* (viewer: Viewer) {
  yield* requireViewer(viewer);
  return yield* listRows(viewer).pipe(Effect.catchTags(schemaError));
});
export const create = Effect.fn("Teams.create")(function* (
  input: Viewer & { readonly name: string }
) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Cryptography.Cryptography;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* lockAdministrator(input);
      const name = yield* nameOf(input.name);
      const id = yield* crypto.internalId("team");
      const rows =
        yield* sql`INSERT INTO company_teams(id, company_id, name) VALUES (${id}, ${input.companyId}, ${name}) ON CONFLICT DO NOTHING RETURNING id`;
      if (rows.length === 0) return yield* new TeamNameTaken({ companyId: input.companyId });
      yield* changed(input.companyId);
      return yield* requireTeam({ ...input, teamId: id });
    })
  );
});
export const rename = Effect.fn("Teams.rename")(function* (
  input: TeamRef & { readonly name: string }
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* lockAdministrator(input);
      const team = yield* requireTeam(input);
      const name = yield* nameOf(input.name);
      if (name === team.name) return team;
      const duplicates =
        yield* sql`SELECT id FROM company_teams WHERE company_id = ${input.companyId} AND lower(name) = lower(${name}) AND id <> ${input.teamId}`;
      if (duplicates.length) return yield* new TeamNameTaken({ companyId: input.companyId });
      yield* sql`UPDATE company_teams SET name = ${name} WHERE company_id = ${input.companyId} AND id = ${input.teamId}`;
      yield* changed(input.companyId);
      return yield* requireTeam(input);
    })
  );
});
export const members = Effect.fn("Teams.members")(function* (input: TeamRef) {
  yield* requireViewer(input);
  const roster = yield* memberRows(input).pipe(Effect.catchTags(schemaError));
  if (Option.isNone(roster)) return yield* new TeamNotFound({ teamId: input.teamId });
  return roster.value.ids;
});
/** Shared by rendered controls and the locked write path; super admins can leave their recorded memberships. */
export const canRemoveMembership = (
  actor: { readonly id: string; readonly role: Role },
  target: { readonly id: string; readonly role: Role }
) =>
  (actor.role === "super_admin" || target.role !== "super_admin") &&
  (actor.role === "super_admin" ||
    (actor.role === "admin" && (target.role === "member" || actor.id === target.id)));

/** One submission is atomic. Only effective edits record attribution, advance authority and wake readers. */
export const setMemberships = Effect.fn("Teams.setMemberships")(function* (
  input: TeamRef & { readonly userIds: readonly string[]; readonly added: boolean }
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const actorRole = yield* lockAdministrator(input);
      yield* requireTeam(input);
      let count = 0;
      for (const userId of new Set(input.userIds)) {
        const target = yield* active({ companyId: input.companyId, userId }).pipe(
          Effect.catchTags(schemaError)
        );
        if (target.length === 0)
          return yield* new UserNotFound({ companyId: input.companyId, userId });
        if (
          !input.added &&
          !canRemoveMembership({ id: input.actorId, role: actorRole }, target[0]!)
        )
          return yield* new RoleForbidden(input);
        const rows = input.added
          ? yield* sql`INSERT INTO company_team_members(company_id, team_id, user_id) VALUES (${input.companyId}, ${input.teamId}, ${userId}) ON CONFLICT DO NOTHING RETURNING user_id`
          : yield* sql`DELETE FROM company_team_members WHERE company_id = ${input.companyId} AND team_id = ${input.teamId} AND user_id = ${userId} RETURNING user_id`;
        if (rows.length === 0) continue;
        const revision = yield* changed(input.companyId);
        yield* sql`INSERT INTO company_team_changes(company_id, revision, team_id, user_id, actor_id, added) VALUES (${input.companyId}, ${revision}::bigint, ${input.teamId}, ${userId}, ${input.actorId}, ${input.added})`;
        count++;
      }
      return count;
    })
  );
});
/** Internal authority read for audience consumers; inactive people have no effective memberships. */
export const memberships = Effect.fn("Teams.memberships")(function* (
  companyId: string,
  userId: string
) {
  return (yield* membershipRows({ companyId, userId }).pipe(Effect.catchTags(schemaError))).map(
    (row) => row.id
  );
});
/** Internal committed facts, ordered by Companies revision; callers authorize disclosure. */
export const changes = Effect.fn("Teams.changes")((companyId: string, after: string) =>
  changeRows({ companyId, after }).pipe(Effect.catchTags(schemaError))
);

const selfJoinRows = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, teamIds: Schema.Array(Schema.String) }),
  Result: Schema.Struct({ ...MembershipChange.fields, teamName: Schema.String }),
  execute: ({ companyId, teamIds }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`
    SELECT c.revision::text, c.team_id AS "teamId", c.user_id AS "userId", c.actor_id AS "actorId", c.added,
      c.created_at AS "createdAt", t.name AS "teamName"
    FROM company_team_changes c JOIN company_teams t ON t.id = c.team_id AND t.company_id = c.company_id
    WHERE c.company_id = ${companyId} AND c.team_id = ANY(${teamIds}::text[]) AND c.added AND c.actor_id = c.user_id
    ORDER BY c.revision`
    )
});
/** Internal owner-history facts, scoped before reading; callers authorize disclosure. */
export const selfJoins = Effect.fn("Teams.selfJoins")(
  (companyId: string, teamIds: readonly string[]) =>
    selfJoinRows({ companyId, teamIds }).pipe(Effect.catchTags(schemaError))
);

const decodePeople = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      active: Schema.Boolean,
      role: Schema.Literals(["member", "admin", "super_admin"]),
      teamIds: Schema.Array(Schema.String)
    })
  )
);
/** Batched company-owned authority facts. Inactive owners retain their team selections for repairs. */
export const people = Effect.fn("Teams.people")(function* (
  companyId: string,
  userIds: readonly string[]
) {
  const sql = yield* SqlClient.SqlClient;
  if (!userIds.length) return [];
  return yield* sql`SELECT u.id, u.deactivated_at IS NULL AS active, u.role,
    COALESCE(array_agg(m.team_id ORDER BY m.team_id) FILTER (WHERE m.team_id IS NOT NULL), ARRAY[]::text[]) AS "teamIds"
    FROM users u LEFT JOIN (company_team_members m JOIN company_teams t ON t.company_id = m.company_id AND t.id = m.team_id AND t.deleted_at IS NULL) ON m.company_id = u.company_id AND m.user_id = u.id
    WHERE u.company_id = ${companyId} AND u.id = ANY(${[...new Set(userIds)]}::text[])
    GROUP BY u.id`.pipe(Effect.flatMap(decodePeople), Effect.catchTags(schemaError));
});

/** Audience writers take shared team locks, in identity order, until their transaction commits. */
export const lockActive = Effect.fn("Teams.lockActive")(function* (
  companyId: string,
  teamIds: readonly string[]
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    id: string;
  }>`SELECT id FROM company_teams WHERE company_id = ${companyId}
    AND id = ANY(${[...new Set(teamIds)].sort()}::text[]) AND deleted_at IS NULL ORDER BY id FOR SHARE`;
  return rows.length === new Set(teamIds).size;
});
export const deleted = Effect.fn("Teams.deleted")(function* (viewer: Viewer) {
  const sql = yield* SqlClient.SqlClient;
  yield* requireViewer(viewer);
  const actor = yield* active({ companyId: viewer.companyId, userId: viewer.actorId }).pipe(
    Effect.catchTags(schemaError)
  );
  if (actor[0]?.role === "member") return yield* new RoleForbidden(viewer);
  return yield* sql`SELECT id, company_id AS "companyId", name, created_at AS "createdAt", deleted_at AS "deletedAt"
    FROM company_teams WHERE company_id = ${viewer.companyId} AND deleted_at IS NOT NULL ORDER BY lower(name), id`.pipe(
    Effect.flatMap(decodeTeams),
    Effect.catchTags(schemaError)
  );
});
/** Keep memberships and identity. Reference checks run under the exclusive team lock. */
export const setDeleted = Effect.fn("Teams.setDeleted")(function* (
  input: TeamRef & { readonly deleted: boolean }
) {
  const sql = yield* SqlClient.SqlClient;
  const referenced = yield* References;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* lockAdministrator(input);
      yield* sql`SELECT id FROM company_teams WHERE company_id = ${input.companyId} AND id = ${input.teamId} FOR UPDATE`;
      const found = yield* find(input).pipe(Effect.catchTags(schemaError));
      if (Option.isNone(found)) return yield* new TeamNotFound({ teamId: input.teamId });
      if ((found.value.deletedAt !== null) === input.deleted) return;
      if (input.deleted && (yield* referenced(input.companyId, input.teamId)))
        return yield* new TeamInUse({ teamId: input.teamId });
      yield* sql`UPDATE company_teams SET deleted_at = ${input.deleted ? sql`now()` : sql`NULL`}
      WHERE company_id = ${input.companyId} AND id = ${input.teamId}`;
      const revision = yield* changed(input.companyId);
      yield* sql`INSERT INTO company_team_lifecycle(company_id, team_id, revision, actor_id, deleted)
      VALUES (${input.companyId}, ${input.teamId}, ${revision}::bigint, ${input.actorId}, ${input.deleted})`;
    })
  );
});
