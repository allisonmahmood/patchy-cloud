import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Cryptography } from "@patchy/core";
import { lockAdministrator, Role, roleFromStorage, RoleForbidden, UserNotFound } from "./Users.js";

export class Team extends Schema.Class<Team>("Team")({
  id: Schema.String,
  companyId: Schema.String,
  name: Schema.String,
  createdAt: Schema.Date
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
export interface Viewer {
  readonly companyId: string;
  readonly actorId: string;
}
export interface TeamRef extends Viewer {
  readonly teamId: string;
}
const schemaError = { SchemaError: Effect.die } as const;
const ref = Schema.Struct({ companyId: Schema.String, teamId: Schema.String });
const find = SqlSchema.findOneOption({
  Request: ref,
  Result: Team,
  execute: ({ companyId, teamId }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT id, company_id AS "companyId", name, created_at AS "createdAt" FROM company_teams WHERE company_id = ${companyId} AND id = ${teamId}`
    )
});
// Explicit rows remain independent of the role-derived entitlement. Never materialize
// automatic rows: demotion must drop only that entitlement, including on existing teams.
const effectiveMemberships = (sql: SqlClient.SqlClient, companyId: string) => sql`
  SELECT m.company_id, m.team_id, m.user_id FROM company_team_members m
  JOIN users u ON u.company_id = m.company_id AND u.id = m.user_id
  WHERE m.company_id = ${companyId} AND u.deactivated_at IS NULL
  UNION
  SELECT t.company_id, t.id AS team_id, u.id AS user_id FROM company_teams t
  JOIN users u ON u.company_id = t.company_id
  WHERE t.company_id = ${companyId} AND u.role = 'admin' AND u.deactivated_at IS NULL`;

// Both directory and roster queries apply this decision in their own SQL snapshot.
const visibleTeams = (sql: SqlClient.SqlClient, viewer: Viewer) => sql`
  SELECT t.id, t.company_id, t.name, t.created_at FROM company_teams t
  JOIN users u ON u.company_id = t.company_id AND u.id = ${viewer.actorId}
  WHERE t.company_id = ${viewer.companyId} AND u.deactivated_at IS NULL
  AND (u.role = 'admin' OR u.is_regular_admin OR EXISTS (
    SELECT 1 FROM effective_memberships m WHERE m.team_id = t.id AND m.user_id = u.id
  ))`;
const listRows = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, actorId: Schema.String }),
  Result: Team,
  execute: (viewer) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`WITH effective_memberships AS (${effectiveMemberships(sql, viewer.companyId)}) SELECT id, company_id AS "companyId", name, created_at AS "createdAt" FROM (${visibleTeams(sql, viewer)}) visible ORDER BY lower(name), id`
    )
});
const active = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
  Result: Schema.Struct({ id: Schema.String, role: Role }),
  execute: ({ companyId, userId }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT id, ${sql.unsafe(roleFromStorage)} AS role FROM users WHERE company_id = ${companyId} AND id = ${userId} AND deactivated_at IS NULL`
    )
});
const memberRows = SqlSchema.findAll({
  Request: Schema.Struct({ ...ref.fields, actorId: Schema.String }),
  Result: Schema.Struct({ id: Schema.String }),
  execute: (input) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`WITH effective_memberships AS (${effectiveMemberships(sql, input.companyId)}) SELECT m.user_id AS id FROM effective_memberships m JOIN (${visibleTeams(sql, input)}) t ON t.id = m.team_id WHERE m.team_id = ${input.teamId} ORDER BY m.user_id`
    )
});
const membershipRows = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
  Result: Schema.Struct({ id: Schema.String }),
  execute: ({ companyId, userId }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`SELECT team_id AS id FROM (${effectiveMemberships(sql, companyId)}) m WHERE user_id = ${userId} ORDER BY team_id`
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
  if (Option.isNone(team)) return yield* new TeamNotFound({ teamId: input.teamId });
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
  const visible = yield* listRows(input).pipe(Effect.catchTags(schemaError));
  if (!visible.some((team) => team.id === input.teamId))
    return yield* new TeamNotFound({ teamId: input.teamId });
  return (yield* memberRows(input).pipe(Effect.catchTags(schemaError))).map((row) => row.id);
});
/** Shared by rendered controls and the locked write path; a role never overrides required membership. */
export const canRemoveMembership = (
  actor: { readonly id: string; readonly role: Role },
  target: { readonly id: string; readonly role: Role }
) =>
  target.role !== "super_admin" &&
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
        // Adding an already-required member must not create an accidental grant after demotion.
        if (input.added && target[0]!.role === "super_admin") continue;
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

/** Internal batch authority facts, including active people with no team memberships. */
const membershipFactRows = SqlSchema.findAll({
  Request: Schema.Struct({ companyId: Schema.String, userIds: Schema.Array(Schema.String) }),
  Result: Schema.Struct({ userId: Schema.String, teamIds: Schema.Array(Schema.String) }),
  execute: ({ companyId, userIds }) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`
    WITH effective_memberships AS (${effectiveMemberships(sql, companyId)})
    SELECT u.id AS "userId", COALESCE(array_agg(m.team_id ORDER BY m.team_id) FILTER (WHERE m.team_id IS NOT NULL), ARRAY[]::text[]) AS "teamIds"
    FROM users u LEFT JOIN effective_memberships m ON m.company_id = u.company_id AND m.user_id = u.id
    WHERE u.company_id = ${companyId} AND u.id = ANY(${userIds}::text[]) AND u.deactivated_at IS NULL GROUP BY u.id`
    )
});

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

export const membershipFacts = Effect.fn("Teams.membershipFacts")(
  (companyId: string, userIds: readonly string[]) =>
    membershipFactRows({ companyId, userIds }).pipe(Effect.catchTags(schemaError))
);
