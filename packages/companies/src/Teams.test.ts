import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { NodeCryptography } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import * as Directory from "./Directory.js";
import * as Teams from "./Teams.js";
import * as Users from "./Users.js";

const readChanges = Effect.fn(function* (companyId: string, after: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    actorId: string;
    userId: string;
    added: boolean;
  }>`SELECT actor_id AS "actorId", user_id AS "userId", added FROM company_team_changes WHERE company_id = ${companyId} AND revision > ${after}::bigint`;
});
const setup = Effect.fn(function* (handle: string) {
  const companies = yield* Companies.Companies;
  const owner = yield* companies.create({
    handle,
    name: handle,
    clerkUserId: `clerk_${handle}`,
    email: `${handle}@example.com`,
    userName: "Ada"
  });
  const add = Effect.fn(function* (name: string, role: Users.Role) {
    const invite = yield* companies.createInvite({
      companyId: owner.company.id,
      invitedBy: owner.user.id,
      email: `${name}-${handle}@example.com`,
      role
    });
    return yield* companies.consumeInvite({
      inviteId: invite.id,
      clerkUserId: `${name}_${handle}`,
      email: invite.email,
      name
    });
  });
  return {
    ...owner,
    ref: { companyId: owner.company.id, actorId: owner.user.id },
    admin: yield* add("Ben", "admin"),
    member: yield* add("Cleo", "member")
  };
});
const services = Layer.mergeAll(Companies.layer, Users.layer, Directory.layer, Teams.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);
it.layer(services)("Teams", (it) => {
  it.effect("deletes a team for good with its memberships, keeping its history", () =>
    Effect.gen(function* () {
      const { ref, member, admin } = yield* setup("teams-delete");
      const teams = yield* Teams.Teams;
      const team = yield* teams.create({ ...ref, name: "Research" });
      const target = { ...ref, teamId: team.id };
      yield* teams.setMemberships({ ...target, add: [member.id, admin.id] });
      assert.strictEqual(
        (yield* teams.remove({ ...target, actorId: member.id }).pipe(Effect.flip))._tag,
        "RoleForbidden"
      );
      yield* teams.remove(target);
      assert.deepStrictEqual(yield* teams.list(ref), []);
      assert.deepStrictEqual(
        (yield* teams.memberships(ref.companyId, [member.id, admin.id])).get(member.id),
        []
      );
      assert.strictEqual((yield* teams.members(target).pipe(Effect.flip))._tag, "TeamNotFound");
      assert.strictEqual((yield* teams.remove(target).pipe(Effect.flip))._tag, "TeamNotFound");
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT DISTINCT team_id AS "teamId", team_name AS "teamName" FROM company_team_changes
          WHERE company_id = ${ref.companyId}`,
        [{ teamId: team.id, teamName: "Research" }]
      );
      // The way back is a new team.
      assert.notStrictEqual((yield* teams.create({ ...ref, name: "Research" })).id, team.id);
    })
  );

  it.effect("shows members every team and roster, and refuses their writes", () =>
    Effect.gen(function* () {
      const { ref, admin, member } = yield* setup("teams-visibility");
      const teams = yield* Teams.Teams;
      const finance = yield* teams.create({ ...ref, name: "Finance" });
      const design = yield* teams.create({ ...ref, name: "Design" });
      yield* teams.setMemberships({ ...ref, teamId: finance.id, add: [admin.id] });
      const asMember = { ...ref, actorId: member.id };
      assert.deepStrictEqual(
        (yield* teams.list(asMember)).map((team) => team.id),
        [design.id, finance.id]
      );
      assert.deepStrictEqual(yield* teams.members({ ...asMember, teamId: finance.id }), [admin.id]);
      assert.deepStrictEqual(yield* teams.members({ ...asMember, teamId: design.id }), []);
      assert.strictEqual(
        (yield* teams
          .setMemberships({ ...asMember, teamId: design.id, add: [member.id] })
          .pipe(Effect.flip))._tag,
        "RoleForbidden"
      );
    })
  );
  it.effect(
    "owns atomic batch edits, preserving attribution and authority on a failed selection",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-batch");
        const teams = yield* Teams.Teams;
        const directory = yield* Directory.Directory;
        const team = yield* teams.create({ ...ref, name: "Design" });
        const target = { ...ref, teamId: team.id };
        const before = yield* directory.revision(ref.companyId);
        const failed = yield* teams
          .setMemberships({ ...target, add: [admin.id, "missing-person"] })
          .pipe(Effect.flip);
        assert.strictEqual(failed._tag, "UserNotFound");
        assert.deepStrictEqual(yield* teams.members(target), []);
        assert.deepStrictEqual(yield* readChanges(ref.companyId, before), []);
        assert.strictEqual(yield* directory.revision(ref.companyId), before);
        assert.strictEqual(
          yield* teams.setMemberships({ ...target, add: [admin.id, admin.id, member.id] }),
          2
        );
        const facts = yield* readChanges(ref.companyId, before);
        assert.strictEqual(facts.length, 2);
        assert.isTrue(facts.every((change) => change.actorId === ref.actorId));
        const committed = yield* directory.revision(ref.companyId);
        assert.strictEqual(BigInt(committed), BigInt(before) + 1n);
        assert.strictEqual(yield* teams.revision(ref.companyId), committed);
        assert.strictEqual(yield* teams.setMemberships({ ...target, add: [member.id] }), 0);
        assert.strictEqual(yield* teams.setMemberships(target), 0);
        assert.strictEqual(yield* directory.revision(ref.companyId), committed);
        assert.deepStrictEqual(yield* readChanges(ref.companyId, committed), []);
        assert.strictEqual(
          yield* teams.setMemberships({ ...target, remove: [admin.id, member.id] }),
          2
        );
        assert.deepStrictEqual(yield* teams.members(target), []);
      })
  );

  it.effect(
    "saves a roster's adds and removes together, only at the revision it was drawn at",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-roster");
        const teams = yield* Teams.Teams;
        const team = yield* teams.create({ ...ref, name: "Sales" });
        const target = { ...ref, teamId: team.id };
        yield* teams.setMemberships({ ...target, add: [admin.id] });
        const drawn = yield* teams.revision(ref.companyId);
        // Another admin's change in between makes the drawn form stale: nothing it asked for lands.
        const other = yield* teams.create({ ...ref, name: "Finance" });
        yield* teams.setMemberships({ ...ref, teamId: other.id, add: [member.id] });
        const stale = yield* teams
          .setMemberships({ ...target, add: [member.id], remove: [admin.id], revision: drawn })
          .pipe(Effect.flip);
        assert.strictEqual(stale._tag, "TeamsChanged");
        assert.deepStrictEqual(yield* teams.members(target), [admin.id]);
        const current = yield* teams.revision(ref.companyId);
        assert.strictEqual(
          yield* teams.setMemberships({
            ...target,
            add: [member.id, ref.actorId],
            remove: [admin.id, ref.actorId],
            revision: current
          }),
          2
        );
        assert.deepStrictEqual(yield* teams.members(target), [member.id]);
        assert.deepStrictEqual(
          (yield* readChanges(ref.companyId, current))
            .map(({ userId, added }) => [userId, added])
            .sort(([, a], [, b]) => Number(a) - Number(b)),
          [
            [admin.id, false],
            [member.id, true]
          ]
        );
        // A team deleted while its roster was being edited refuses the save.
        const before = yield* teams.revision(ref.companyId);
        yield* teams.remove(target);
        assert.strictEqual(
          (yield* teams
            .setMemberships({ ...target, add: [admin.id], revision: before })
            .pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
      })
  );

  it.effect(
    "keeps independent overlapping memberships and stable identities in durable storage",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-overlap");
        const design = yield* (yield* Teams.Teams).create({ ...ref, name: " Design " });
        const engineering = yield* (yield* Teams.Teams).create({ ...ref, name: "Engineering" });
        const asAdmin = { ...ref, actorId: admin.id };
        for (const teamId of [design.id, engineering.id]) {
          yield* (yield* Teams.Teams).setMemberships({
            ...asAdmin,
            teamId,
            add: [admin.id]
          });
          yield* (yield* Teams.Teams).setMemberships({
            ...asAdmin,
            teamId,
            add: [member.id]
          });
        }
        yield* (yield* Teams.Teams).rename({
          ...asAdmin,
          teamId: design.id,
          name: "Product Design"
        });
        yield* (yield* Teams.Teams).setMemberships({
          ...asAdmin,
          teamId: design.id,
          remove: [member.id]
        });
        assert.deepStrictEqual(
          (yield* (yield* Teams.Teams).list(ref)).map((team) => team.id).sort(),
          [design.id, engineering.id].sort()
        );
        assert.deepStrictEqual(yield* (yield* Teams.Teams).members({ ...ref, teamId: design.id }), [
          admin.id
        ]);
        assert.deepStrictEqual(
          (yield* (yield* Teams.Teams).memberships(ref.companyId, [member.id])).get(member.id)!,
          [engineering.id]
        );
        yield* (yield* Teams.Teams).setMemberships({
          ...asAdmin,
          teamId: design.id,
          add: [member.id]
        });
        assert.strictEqual(
          (yield* (yield* Teams.Teams).memberships(ref.companyId, [member.id])).get(member.id)!
            .length,
          2
        );
        const changes = yield* readChanges(ref.companyId, "0");
        assert.strictEqual(changes.length, 6);
        assert.isTrue(changes.every((change) => change.actorId === admin.id));
        assert.isTrue(changes.some((change) => change.userId === admin.id && change.added));
      })
  );
  it.effect(
    "rejects member self-assignment, foreign teams/people and inactive actors/targets using current authority",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-authority");
        const other = yield* setup("teams-foreign");
        const users = yield* Users.Users;
        const team = yield* (yield* Teams.Teams).create({ ...ref, name: "Design" });
        const input = { ...ref, teamId: team.id, add: [member.id] };
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .create({ ...ref, actorId: member.id, name: "Hidden" })
            .pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .rename({ ...input, actorId: member.id, name: "Hidden" })
            .pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .setMemberships({ ...input, actorId: member.id })
            .pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .setMemberships({ ...input, add: [other.user.id] })
            .pipe(Effect.flip))._tag,
          "UserNotFound"
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .setMemberships({
              ...other.ref,
              teamId: team.id,
              add: [other.user.id]
            })
            .pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams).members({ ...other.ref, teamId: team.id }).pipe(Effect.flip))
            ._tag,
          "TeamNotFound"
        );
        yield* users.setRole({ companyId: ref.companyId, userId: admin.id, role: "member" });
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .setMemberships({ ...input, actorId: admin.id })
            .pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        yield* (yield* Teams.Teams).setMemberships(input);
        yield* users.deactivate({ companyId: ref.companyId, userId: member.id });
        assert.deepStrictEqual(
          (yield* (yield* Teams.Teams).memberships(ref.companyId, [member.id])).get(member.id)!,
          []
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams).setMemberships(input).pipe(Effect.flip))._tag,
          "UserNotFound"
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams).list({ ...ref, actorId: member.id }).pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        yield* (yield* Teams.Teams).setMemberships({ ...input, add: [], remove: [member.id] });
        yield* users.reactivate({ companyId: ref.companyId, userId: member.id });
        assert.deepStrictEqual(
          (yield* (yield* Teams.Teams).memberships(ref.companyId, [member.id])).get(member.id)!,
          []
        );
      })
  );
  it.effect(
    "normalizes names, refuses duplicates within a company and preserves identity on no-op rename",
    () =>
      Effect.gen(function* () {
        const { ref } = yield* setup("teams-names");
        const team = yield* (yield* Teams.Teams).create({ ...ref, name: "  Product   Design " });
        assert.strictEqual(team.name, "Product Design");
        assert.strictEqual(
          (yield* (yield* Teams.Teams).create({ ...ref, name: "product design" }).pipe(Effect.flip))
            ._tag,
          "TeamNameTaken"
        );
        for (const name of ["   ", "x".repeat(101)])
          assert.strictEqual(
            (yield* (yield* Teams.Teams).create({ ...ref, name }).pipe(Effect.flip))._tag,
            "InvalidTeamName"
          );
        const other = yield* (yield* Teams.Teams).create({ ...ref, name: "Engineering" });
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .rename({ ...ref, teamId: other.id, name: "Product Design" })
            .pipe(Effect.flip))._tag,
          "TeamNameTaken"
        );
        const directory = yield* Directory.Directory;
        const before = yield* directory.revision(ref.companyId);
        assert.strictEqual(
          (yield* (yield* Teams.Teams).rename({ ...ref, teamId: team.id, name: team.name })).id,
          team.id
        );
        assert.strictEqual(yield* directory.revision(ref.companyId), before);
      })
  );
});
