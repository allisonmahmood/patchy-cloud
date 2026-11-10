import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { SqlError } from "effect/sql/SqlError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Cryptography } from "@patchy/core";
import { lockAdministrator, type Role, RoleForbidden, UserNotFound } from "./Users.js";

export class Team extends Schema.Class<Team>("Team")({
  id: Schema.String,
  companyId: Schema.String,
  name: Schema.String,
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
export const canRemoveMembership = (
  actor: { readonly id: string; readonly role: Role },
  target: { readonly id: string; readonly role: Role }
) =>
  target.role !== "super_admin" &&
  (actor.role === "super_admin" ||
    (actor.role === "admin" && (target.role === "member" || actor.id === target.id)));
export class Teams extends Context.Service<
  Teams,
  {
    readonly list: (viewer: Viewer) => Effect.Effect<readonly Team[], RoleForbidden | SqlError>;
    readonly create: (
      input: Viewer & { readonly name: string }
    ) => Effect.Effect<
      Team,
      RoleForbidden | InvalidTeamName | TeamNameTaken | TeamNotFound | SqlError
    >;
    readonly rename: (
      input: TeamRef & { readonly name: string }
    ) => Effect.Effect<
      Team,
      RoleForbidden | InvalidTeamName | TeamNameTaken | TeamNotFound | SqlError
    >;
    readonly members: (
      input: TeamRef
    ) => Effect.Effect<readonly string[], RoleForbidden | TeamNotFound | SqlError>;
    readonly setMemberships: (
      input: TeamRef & { readonly userIds: readonly string[]; readonly added: boolean }
    ) => Effect.Effect<number, RoleForbidden | TeamNotFound | UserNotFound | SqlError>;
    readonly memberships: (
      companyId: string,
      userIds: readonly string[]
    ) => Effect.Effect<ReadonlyMap<string, readonly string[]>, SqlError>;
  }
>()("@patchy/companies/Teams") {}
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Cryptography.Cryptography;
  const schemaError = { SchemaError: Effect.die } as const;
  const ref = Schema.Struct({ companyId: Schema.String, teamId: Schema.String });
  const find = SqlSchema.findOneOption({
    Request: ref,
    Result: Team,
    execute: ({ companyId, teamId }) =>
      sql`SELECT id, company_id AS "companyId", name, created_at AS "createdAt" FROM company_teams WHERE company_id = ${companyId} AND id = ${teamId}`
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Team,
    execute: (companyId) =>
      sql`SELECT id, company_id AS "companyId", name, created_at AS "createdAt" FROM company_teams WHERE company_id = ${companyId} ORDER BY lower(name), id`
  });
  const active = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ companyId, userId }) =>
      sql`SELECT id FROM users WHERE company_id = ${companyId} AND id = ${userId} AND deactivated_at IS NULL`
  });
  const memberRows = SqlSchema.findAll({
    Request: ref,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ companyId, teamId }) =>
      sql`SELECT m.user_id AS id FROM company_team_members m JOIN users u ON u.id = m.user_id AND u.company_id = m.company_id WHERE m.company_id = ${companyId} AND m.team_id = ${teamId} ORDER BY m.user_id`
  });
  const membershipRows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, userIds: Schema.Array(Schema.String) }),
    Result: Schema.Struct({ userId: Schema.String, teamId: Schema.String }),
    execute: ({ companyId, userIds }) =>
      sql`SELECT m.user_id AS "userId", m.team_id AS "teamId" FROM company_team_members m JOIN users u ON u.id = m.user_id AND u.company_id = m.company_id WHERE m.company_id = ${companyId} AND ${sql.in("m.user_id", userIds)} AND u.deactivated_at IS NULL ORDER BY m.user_id, m.team_id`
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
      sql`INSERT INTO companies_directory(company_id, revision) VALUES (${companyId}, 1) ON CONFLICT(company_id) DO UPDATE SET revision = companies_directory.revision + 1 RETURNING revision::text`
  });
  const changed = Effect.fn("Teams.changed")(function* (companyId: string) {
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
  const list = Effect.fn("Teams.list")(function* (viewer: Viewer) {
    yield* requireViewer(viewer);
    return yield* listRows(viewer.companyId).pipe(Effect.catchTags(schemaError));
  });
  const create = Effect.fn("Teams.create")(function* (input: Viewer & { readonly name: string }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockAdministrator(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));
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
  const rename = Effect.fn("Teams.rename")(function* (input: TeamRef & { readonly name: string }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* lockAdministrator(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));
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
  const members = Effect.fn("Teams.members")(function* (input: TeamRef) {
    yield* requireViewer(input);
    yield* requireTeam(input);
    return (yield* memberRows(input).pipe(Effect.catchTags(schemaError))).map((row) => row.id);
  });
  /** One submission is atomic. Only effective edits record attribution, advance authority and wake readers. */
  const setMemberships = Effect.fn("Teams.setMemberships")(function* (
    input: TeamRef & { readonly userIds: readonly string[]; readonly added: boolean }
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const actorRole = yield* lockAdministrator(input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql)
        );
        yield* requireTeam(input);
        const edited: string[] = [];
        for (const userId of new Set(input.userIds)) {
          const target = yield* sql<{
            role: Role;
            active: boolean;
          }>`SELECT role, deactivated_at IS NULL AS active FROM users WHERE company_id = ${input.companyId} AND id = ${userId} FOR KEY SHARE`;
          if (!target[0] || (input.added && !target[0].active))
            return yield* new UserNotFound({ companyId: input.companyId, userId });
          if (
            !input.added &&
            !canRemoveMembership(
              { id: input.actorId, role: actorRole },
              { id: userId, role: target[0].role }
            )
          )
            return yield* new RoleForbidden(input);
          const rows = input.added
            ? yield* sql`INSERT INTO company_team_members(company_id, team_id, user_id) VALUES (${input.companyId}, ${input.teamId}, ${userId}) ON CONFLICT DO NOTHING RETURNING user_id`
            : yield* sql`DELETE FROM company_team_members WHERE company_id = ${input.companyId} AND team_id = ${input.teamId} AND user_id = ${userId} RETURNING user_id`;
          if (rows.length === 0) continue;
          edited.push(userId);
        }
        if (edited.length) {
          const revision = yield* changed(input.companyId);
          for (const userId of edited) {
            yield* sql`INSERT INTO company_team_changes(company_id, revision, team_id, user_id, actor_id, added) VALUES (${input.companyId}, ${revision}::bigint, ${input.teamId}, ${userId}, ${input.actorId}, ${input.added})`;
          }
        }
        return edited.length;
      })
    );
  });
  /** Internal authority read for audience consumers; inactive people have no effective memberships. */
  const memberships = Effect.fn("Teams.memberships")(function* (
    companyId: string,
    userIds: readonly string[]
  ) {
    const result = new Map<string, string[]>(userIds.map((id) => [id, []]));
    if (!userIds.length) return result;
    const rows = yield* membershipRows({ companyId, userIds }).pipe(Effect.catchTags(schemaError));
    for (const row of rows) result.get(row.userId)!.push(row.teamId);
    return result;
  });
  return { list, create, rename, members, setMemberships, memberships };
});
export const layer = Layer.effect(Teams, make);
