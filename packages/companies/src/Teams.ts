/**
 * Teams: flat, named sets of company people that own nothing. Admins create, rename and delete
 * them and manage every membership; every active person may read them. Patch and connection
 * audiences reference teams by foreign key, so Postgres refuses deleting a team still in use.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Cryptography } from "@patchy/core";
import { lockAdministrator, Role, RoleForbidden, UserNotFound } from "./Users.js";

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
/** The member directory moved past the revision a form was drawn at, so nothing was saved. */
export class TeamsChanged extends Schema.TaggedError<TeamsChanged>()("TeamsChanged", {
  companyId: Schema.String,
  revision: Schema.String
}) {
  override get message() {
    return "Teams changed since this was drawn. Nothing was saved.";
  }
}
/** A patch or connection audience still names the team, in any state. */
export class TeamInUse extends Schema.TaggedError<TeamInUse>()("TeamInUse", {
  teamId: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return "This team is used by patches or connections. Change their audiences before deleting it.";
  }
}
/**
 * The one team rule of every audience, patch or connection: one that names teams admits the
 * people on any of them, and any other admits everyone it reaches. Who the person is, and whether
 * they must be active, is the caller's to check.
 */
export const admits = (
  audience:
    | { readonly kind: "company" | "public" }
    | { readonly kind: "teams"; readonly teamIds: readonly string[] },
  teamIds: readonly string[]
) => audience.kind !== "teams" || audience.teamIds.some((id) => teamIds.includes(id));

export interface Viewer {
  readonly companyId: string;
  readonly actorId: string;
}
export interface TeamRef extends Viewer {
  readonly teamId: string;
}
export interface MembershipChange extends TeamRef {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
  readonly revision?: string;
}
const Person = Schema.Struct({
  id: Schema.String,
  active: Schema.Boolean,
  role: Role,
  teamIds: Schema.Array(Schema.String)
});

export class Teams extends Context.Service<
  Teams,
  {
    readonly list: (viewer: Viewer) => Effect.Effect<readonly Team[], RoleForbidden | SqlError>;
    readonly create: (
      input: Viewer & { readonly name: string }
    ) => Effect.Effect<Team, RoleForbidden | InvalidTeamName | TeamNameTaken | SqlError>;
    readonly rename: (
      input: TeamRef & { readonly name: string }
    ) => Effect.Effect<
      Team,
      RoleForbidden | InvalidTeamName | TeamNameTaken | TeamNotFound | SqlError
    >;
    /** Deletes the team and its memberships for good; its history rows stay. */
    readonly remove: (
      input: TeamRef
    ) => Effect.Effect<void, RoleForbidden | TeamNotFound | TeamInUse | SqlError>;
    readonly members: (
      input: TeamRef
    ) => Effect.Effect<readonly string[], RoleForbidden | TeamNotFound | SqlError>;
    /**
     * Adds and removes people in one atomic batch; someone named in both stays as they are. With
     * `revision`, refuses `TeamsChanged` unless the member directory is still at it, so a form
     * drawn before another change can't undo it. Answers how many memberships changed.
     */
    readonly setMemberships: (
      input: MembershipChange
    ) => Effect.Effect<
      number,
      RoleForbidden | TeamNotFound | UserNotFound | TeamsChanged | SqlError
    >;
    /** The member directory's revision, which every team change advances. */
    readonly revision: (companyId: string) => Effect.Effect<string, SqlError>;
    /** Each person's current teams; a deactivated person has none. */
    readonly memberships: (
      companyId: string,
      userIds: readonly string[]
    ) => Effect.Effect<ReadonlyMap<string, readonly string[]>, SqlError>;
    /** Role, activity and recorded teams, kept for deactivated people too. */
    readonly people: (
      companyId: string,
      userIds: readonly string[]
    ) => Effect.Effect<readonly (typeof Person.Type)[], SqlError>;
  }
>()("@patchy/companies/Teams") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Cryptography.Cryptography;
  const dieOnSchemaError = { SchemaError: Effect.die } as const;
  const admin = (input: Viewer) =>
    lockAdministrator(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const ref = Schema.Struct({ companyId: Schema.String, teamId: Schema.String });
  const find = SqlSchema.findOneOption({
    Request: ref,
    Result: Team,
    execute: ({ companyId, teamId }) =>
      sql`SELECT id, company_id AS "companyId", name, created_at AS "createdAt"
        FROM company_teams WHERE company_id = ${companyId} AND id = ${teamId}`
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: Team,
    execute: (companyId) =>
      sql`SELECT id, company_id AS "companyId", name, created_at AS "createdAt"
        FROM company_teams WHERE company_id = ${companyId} ORDER BY lower(name), id`
  });
  const memberRows = SqlSchema.findAll({
    Request: ref,
    Result: Schema.Struct({ userId: Schema.String }),
    execute: ({ companyId, teamId }) =>
      sql`SELECT user_id AS "userId" FROM company_team_members
        WHERE company_id = ${companyId} AND team_id = ${teamId} ORDER BY user_id`
  });
  // Only active people's memberships admit anyone.
  const membershipRows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, userIds: Schema.Array(Schema.String) }),
    Result: Schema.Struct({ userId: Schema.String, teamId: Schema.String }),
    execute: ({ companyId, userIds }) =>
      sql`SELECT m.user_id AS "userId", m.team_id AS "teamId" FROM company_team_members m
        JOIN users u ON u.company_id = m.company_id AND u.id = m.user_id
        WHERE m.company_id = ${companyId} AND u.deactivated_at IS NULL
          AND m.user_id = ANY(${userIds}::text[])
        ORDER BY m.user_id, m.team_id`
  });
  const activeViewer = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, actorId: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ companyId, actorId }) =>
      sql`SELECT id FROM users WHERE company_id = ${companyId} AND id = ${actorId} AND deactivated_at IS NULL`
  });
  const requireViewer = Effect.fn("Teams.requireViewer")(function* (viewer: Viewer) {
    const rows = yield* activeViewer(viewer).pipe(Effect.catchTags(dieOnSchemaError));
    if (rows.length === 0) return yield* new RoleForbidden(viewer);
  });
  const requireTeam = Effect.fn("Teams.requireTeam")(function* (input: TeamRef) {
    const team = yield* find(input).pipe(Effect.catchTags(dieOnSchemaError));
    if (Option.isNone(team)) return yield* new TeamNotFound({ teamId: input.teamId });
    return team.value;
  });
  // Teams change who may open patches, so they advance the member directory's revision and wake
  // its readers. NOTIFY is transactional: nothing wakes until the outermost commit.
  const advanceRevision = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ revision: Schema.String }),
    execute: (companyId) =>
      sql`INSERT INTO companies_directory(company_id, revision) VALUES (${companyId}, 1)
        ON CONFLICT(company_id) DO UPDATE SET revision = companies_directory.revision + 1
        RETURNING revision::text`
  });
  const changed = Effect.fn("Teams.changed")(function* (companyId: string) {
    const { revision } = yield* advanceRevision(companyId).pipe(
      Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
    );
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
    return yield* listRows(viewer.companyId).pipe(Effect.catchTags(dieOnSchemaError));
  });
  const create = Effect.fn("Teams.create")((input: Viewer & { readonly name: string }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* admin(input);
        const name = yield* nameOf(input.name);
        const id = yield* crypto.internalId("team");
        const rows = yield* sql`INSERT INTO company_teams(id, company_id, name)
          VALUES (${id}, ${input.companyId}, ${name}) ON CONFLICT DO NOTHING RETURNING id`;
        if (rows.length === 0) return yield* new TeamNameTaken({ companyId: input.companyId });
        yield* changed(input.companyId);
        return yield* requireTeam({ ...input, teamId: id }).pipe(
          Effect.catchTags({ TeamNotFound: Effect.die })
        );
      })
    )
  );
  const rename = Effect.fn("Teams.rename")((input: TeamRef & { readonly name: string }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* admin(input);
        const team = yield* requireTeam(input);
        const name = yield* nameOf(input.name);
        if (name === team.name) return team;
        const duplicates = yield* sql`SELECT id FROM company_teams
          WHERE company_id = ${input.companyId} AND lower(name) = lower(${name}) AND id <> ${input.teamId}`;
        if (duplicates.length) return yield* new TeamNameTaken({ companyId: input.companyId });
        yield* sql`UPDATE company_teams SET name = ${name}
          WHERE company_id = ${input.companyId} AND id = ${input.teamId}`;
        yield* changed(input.companyId);
        return new Team({ ...team, name });
      })
    )
  );
  const remove = Effect.fn("Teams.remove")((input: TeamRef) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* admin(input);
        yield* requireTeam(input);
        // The audience tables' foreign keys refuse the delete while anything names the team, and
        // a share adding it waits on the row or makes this wait, so one of the two loses.
        yield* sql`DELETE FROM company_teams WHERE company_id = ${input.companyId} AND id = ${input.teamId}`.pipe(
          Effect.catchIf(
            (error) => error.reason._tag === "ConstraintError",
            (cause) => Effect.fail(new TeamInUse({ teamId: input.teamId, cause }))
          )
        );
        yield* changed(input.companyId);
      })
    )
  );
  const members = Effect.fn("Teams.members")(function* (input: TeamRef) {
    yield* requireViewer(input);
    yield* requireTeam(input);
    const rows = yield* memberRows(input).pipe(Effect.catchTags(dieOnSchemaError));
    return rows.map((row) => row.userId);
  });
  const currentRevision = SqlSchema.findOne({
    Request: Schema.String,
    Result: Schema.Struct({ revision: Schema.String }),
    execute: (companyId) =>
      sql`SELECT COALESCE((SELECT revision FROM companies_directory WHERE company_id = ${companyId}), 0)::text AS revision`
  });
  const revision = Effect.fn("Teams.revision")(function* (companyId: string) {
    const row = yield* currentRevision(companyId).pipe(
      Effect.catchTags({ ...dieOnSchemaError, NoSuchElementError: Effect.die })
    );
    return row.revision;
  });
  /** Only effective edits are recorded, advance the revision and wake readers. */
  const setMemberships = Effect.fn("Teams.setMemberships")((input: MembershipChange) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* admin(input);
        const team = yield* requireTeam(input);
        if (input.revision !== undefined) {
          // Locked to the commit, after the company row, as every team change takes them.
          const [row] = yield* sql<{ readonly revision: string }>`SELECT revision::text
            FROM companies_directory WHERE company_id = ${input.companyId} FOR UPDATE`;
          const current = row?.revision ?? "0";
          if (current !== input.revision)
            return yield* new TeamsChanged({ companyId: input.companyId, revision: current });
        }
        const adding = new Set(input.add);
        const removing = new Set(input.remove);
        const changes = [
          ...[...removing]
            .filter((id) => !adding.has(id))
            .map((userId) => ({ userId, added: false })),
          ...[...adding]
            .filter((id) => !removing.has(id))
            .map((userId) => ({ userId, added: true }))
        ];
        const edited: { readonly userId: string; readonly added: boolean }[] = [];
        for (const change of changes) {
          const [target] = yield* sql<{ active: boolean }>`SELECT deactivated_at IS NULL AS active
            FROM users WHERE company_id = ${input.companyId} AND id = ${change.userId} FOR KEY SHARE`;
          if (target === undefined || (change.added && !target.active))
            return yield* new UserNotFound({ companyId: input.companyId, userId: change.userId });
          const rows = change.added
            ? yield* sql`INSERT INTO company_team_members(company_id, team_id, user_id)
                VALUES (${input.companyId}, ${input.teamId}, ${change.userId}) ON CONFLICT DO NOTHING RETURNING user_id`
            : yield* sql`DELETE FROM company_team_members WHERE company_id = ${input.companyId}
                AND team_id = ${input.teamId} AND user_id = ${change.userId} RETURNING user_id`;
          if (rows.length > 0) edited.push(change);
        }
        if (edited.length === 0) return 0;
        const advanced = yield* changed(input.companyId);
        for (const change of edited)
          yield* sql`INSERT INTO company_team_changes(company_id, revision, team_id, team_name, user_id, actor_id, added)
            VALUES (${input.companyId}, ${advanced}::bigint, ${team.id}, ${team.name}, ${change.userId}, ${input.actorId}, ${change.added})`;
        return edited.length;
      })
    )
  );
  const memberships = Effect.fn("Teams.memberships")(function* (
    companyId: string,
    userIds: readonly string[]
  ) {
    const result = new Map<string, readonly string[]>(userIds.map((id) => [id, []]));
    if (userIds.length === 0) return result;
    const rows = yield* membershipRows({ companyId, userIds }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
    for (const row of rows) result.set(row.userId, [...(result.get(row.userId) ?? []), row.teamId]);
    return result;
  });
  const peopleRows = SqlSchema.findAll({
    Request: Schema.Struct({ companyId: Schema.String, userIds: Schema.Array(Schema.String) }),
    Result: Person,
    execute: ({ companyId, userIds }) =>
      sql`SELECT u.id, u.deactivated_at IS NULL AS active, u.role,
          ARRAY(SELECT m.team_id FROM company_team_members m
            WHERE m.company_id = u.company_id AND m.user_id = u.id ORDER BY m.team_id) AS "teamIds"
        FROM users u WHERE u.company_id = ${companyId} AND u.id = ANY(${userIds}::text[])`
  });
  const people = Effect.fn("Teams.people")(function* (
    companyId: string,
    userIds: readonly string[]
  ) {
    if (userIds.length === 0) return [];
    return yield* peopleRows({ companyId, userIds: [...new Set(userIds)] }).pipe(
      Effect.catchTags(dieOnSchemaError)
    );
  });

  return Teams.of({
    list,
    create,
    rename,
    remove,
    members,
    setMemberships,
    revision,
    memberships,
    people
  });
});

export const layer = Layer.effect(Teams, make);
