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
const services = Layer.mergeAll(
  Companies.layer,
  Layer.merge(Users.layer, Teams.layer),
  Directory.layer,
  Teams.layer
).pipe(Layer.provideMerge(Testing.layer()), Layer.provideMerge(NodeCryptography.layer));
it.layer(services)("Teams", (it) => {
  it.effect(
    "deletes and restores stable identity and recorded memberships without reviving removed memberships",
    () =>
      Effect.gen(function* () {
        const { ref, member, admin } = yield* setup("teams-recovery");
        const team = yield* (yield* Teams.Teams).create({ ...ref, name: "Research" });
        const target = { ...ref, teamId: team.id };
        yield* (yield* Teams.Teams).setMemberships({
          ...target,
          userIds: [member.id, admin.id],
          added: true
        });
        yield* (yield* Teams.Teams).setMemberships({
          ...target,
          userIds: [admin.id],
          added: false
        });
        assert.equal(
          (yield* (yield* Teams.Teams).setDeleted({ ...target, deleted: true }).pipe(Effect.flip))
            ._tag,
          "TeamInUse"
        );
        yield* (yield* Teams.Teams)
          .setDeleted({ ...target, deleted: true })
          .pipe(Effect.provideService(Teams.References, () => Effect.succeed(false)));
        assert.deepEqual(
          yield* (yield* Teams.Teams)
            .memberships(ref.companyId, [member.id])
            .pipe(Effect.map((rows) => rows.get(member.id) ?? [])),
          []
        );
        assert.deepEqual(
          (yield* (yield* Teams.Teams).deleted(ref)).map((t) => t.id),
          [team.id]
        );
        assert.equal(
          (yield* (yield* Teams.Teams)
            .setMemberships({ ...target, userIds: [member.id], added: true })
            .pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        assert.equal(
          (yield* (yield* Teams.Teams)
            .setDeleted({ ...target, actorId: member.id, deleted: false })
            .pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        yield* (yield* Teams.Teams).setDeleted({ ...target, deleted: false });
        assert.deepEqual(
          yield* (yield* Teams.Teams)
            .memberships(ref.companyId, [member.id])
            .pipe(Effect.map((rows) => rows.get(member.id) ?? [])),
          [team.id]
        );
        assert.deepEqual(
          yield* (yield* Teams.Teams)
            .memberships(ref.companyId, [admin.id])
            .pipe(Effect.map((rows) => rows.get(admin.id) ?? [])),
          []
        );
        assert.deepEqual(yield* (yield* Teams.Teams).deleted(ref), []);
        assert.equal(
          (yield* (yield* Teams.Teams).list(ref)).find((t) => t.id === team.id)?.name,
          "Research"
        );
      })
  );

  it.effect("protects admins atomically while allowing self-leave and super-admin management", () =>
    Effect.gen(function* () {
      const { ref, admin, member } = yield* setup("teams-protection");
      const users = yield* Users.Users;
      yield* users.setRole({ ...ref, userId: member.id, role: "admin" });
      const team = yield* (yield* Teams.Teams).create({ ...ref, name: "Finance" });
      const input = { ...ref, teamId: team.id, userIds: [admin.id, member.id], added: true };
      yield* (yield* Teams.Teams).setMemberships(input);
      assert.equal(
        (yield* (yield* Teams.Teams)
          .setMemberships({
            ...input,
            actorId: admin.id,
            userIds: [ref.actorId],
            added: false
          })
          .pipe(Effect.flip))._tag,
        "RoleForbidden"
      );
      const directory = yield* Directory.Directory;
      const before = yield* directory.revision(ref.companyId);
      assert.equal(
        (yield* (yield* Teams.Teams)
          .setMemberships({ ...input, actorId: admin.id, added: false })
          .pipe(Effect.flip))._tag,
        "RoleForbidden"
      );
      assert.equal(yield* directory.revision(ref.companyId), before);
      assert.deepEqual(
        yield* (yield* Teams.Teams)
          .memberships(ref.companyId, [admin.id])
          .pipe(Effect.map((rows) => rows.get(admin.id) ?? [])),
        [team.id]
      );
      assert.equal(
        yield* (yield* Teams.Teams).setMemberships({
          ...input,
          actorId: admin.id,
          userIds: [admin.id],
          added: false
        }),
        1
      );
      assert.equal(
        yield* (yield* Teams.Teams).setMemberships({
          ...input,
          userIds: [member.id],
          added: false
        }),
        1
      );
    })
  );
  it.effect(
    "hides nonmember teams and rosters, including stale identifiers, until membership returns",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-visibility");
        const finance = yield* (yield* Teams.Teams).create({ ...ref, name: "Finance" });
        const design = yield* (yield* Teams.Teams).create({ ...ref, name: "Design" });
        const asMember = { ...ref, actorId: member.id };
        assert.deepEqual(yield* (yield* Teams.Teams).list(asMember), []);
        assert.equal(
          (yield* (yield* Teams.Teams)
            .members({ ...asMember, teamId: finance.id })
            .pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        const input = { ...ref, teamId: finance.id, userIds: [member.id], added: true };
        yield* (yield* Teams.Teams).setMemberships(input);
        assert.deepEqual(
          (yield* (yield* Teams.Teams).list(asMember)).map((t) => t.id),
          [finance.id]
        );
        assert.deepEqual(yield* (yield* Teams.Teams).members({ ...asMember, teamId: finance.id }), [
          member.id
        ]);
        assert.equal(
          (yield* (yield* Teams.Teams)
            .members({ ...asMember, teamId: design.id })
            .pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        assert.lengthOf(yield* (yield* Teams.Teams).list({ ...ref, actorId: admin.id }), 2);
        yield* (yield* Teams.Teams).setMemberships({ ...input, added: false });
        assert.deepEqual(yield* (yield* Teams.Teams).list(asMember), []);
        assert.equal(
          (yield* (yield* Teams.Teams)
            .members({ ...asMember, teamId: finance.id })
            .pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        yield* (yield* Teams.Teams).setMemberships(input);
        assert.lengthOf(yield* (yield* Teams.Teams).list(asMember), 1);
      })
  );
  it.effect("super admins join and leave through recorded memberships", () =>
    Effect.gen(function* () {
      const { ref, admin } = yield* setup("teams-recorded-super");
      const users = yield* Users.Users;
      const team = yield* (yield* Teams.Teams).create({ ...ref, name: "Finance" });
      yield* users.setRole({ ...ref, userId: admin.id, role: "super_admin" });
      assert.deepEqual(
        yield* (yield* Teams.Teams)
          .memberships(ref.companyId, [admin.id])
          .pipe(Effect.map((rows) => rows.get(admin.id) ?? [])),
        []
      );
      const input = {
        ...ref,
        actorId: admin.id,
        teamId: team.id,
        userIds: [admin.id],
        added: true
      };
      assert.equal(yield* (yield* Teams.Teams).setMemberships(input), 1);
      assert.deepEqual(
        yield* (yield* Teams.Teams)
          .memberships(ref.companyId, [admin.id])
          .pipe(Effect.map((rows) => rows.get(admin.id) ?? [])),
        [team.id]
      );
      assert.equal(yield* (yield* Teams.Teams).setMemberships({ ...input, added: false }), 1);
      assert.deepEqual(
        yield* (yield* Teams.Teams)
          .memberships(ref.companyId, [admin.id])
          .pipe(Effect.map((rows) => rows.get(admin.id) ?? [])),
        []
      );
    })
  );
  it.effect(
    "owns atomic batch edits, preserving attribution and authority on a failed selection",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-batch");
        const directory = yield* Directory.Directory;
        const team = yield* (yield* Teams.Teams).create({ ...ref, name: "Design" });
        const input = { ...ref, teamId: team.id, userIds: [admin.id, member.id], added: true };
        const before = yield* directory.revision(ref.companyId);
        const failed = yield* (yield* Teams.Teams)
          .setMemberships({
            ...input,
            userIds: [admin.id, "missing-person"]
          })
          .pipe(Effect.flip);
        assert.strictEqual(failed._tag, "UserNotFound");
        assert.deepStrictEqual(
          yield* (yield* Teams.Teams).members({ ...ref, teamId: team.id }),
          []
        );
        assert.deepStrictEqual(yield* readChanges(ref.companyId, before), []);
        assert.strictEqual(yield* directory.revision(ref.companyId), before);
        assert.strictEqual(
          yield* (yield* Teams.Teams).setMemberships({
            ...input,
            userIds: [admin.id, admin.id, member.id]
          }),
          2
        );
        const facts = yield* readChanges(ref.companyId, before);
        assert.strictEqual(facts.length, 2);
        assert.isTrue(facts.every((change) => change.actorId === ref.actorId));
        const committed = yield* directory.revision(ref.companyId);
        assert.strictEqual(BigInt(committed), BigInt(before) + 1n);
        assert.strictEqual(yield* (yield* Teams.Teams).setMemberships(input), 0);
        assert.strictEqual(
          yield* (yield* Teams.Teams).setMemberships({ ...input, userIds: [] }),
          0
        );
        assert.strictEqual(yield* directory.revision(ref.companyId), committed);
        assert.deepStrictEqual(yield* readChanges(ref.companyId, committed), []);
        assert.strictEqual(
          yield* (yield* Teams.Teams).setMemberships({ ...input, added: false }),
          2
        );
        assert.deepStrictEqual(
          yield* (yield* Teams.Teams).members({ ...ref, teamId: team.id }),
          []
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
            userIds: [admin.id],
            added: true
          });
          yield* (yield* Teams.Teams).setMemberships({
            ...asAdmin,
            teamId,
            userIds: [member.id],
            added: true
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
          userIds: [member.id],
          added: false
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
          userIds: [member.id],
          added: true
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
        const input = { ...ref, teamId: team.id, userIds: [member.id], added: true };
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
            .setMemberships({ ...input, userIds: [other.user.id] })
            .pipe(Effect.flip))._tag,
          "UserNotFound"
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .setMemberships({
              ...other.ref,
              teamId: team.id,
              userIds: [other.user.id],
              added: true
            })
            .pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        assert.strictEqual(
          (yield* (yield* Teams.Teams).members({ ...other.ref, teamId: team.id }).pipe(Effect.flip))
            ._tag,
          "TeamNotFound"
        );
        yield* users.setRole({
          companyId: ref.companyId,
          actorId: ref.actorId,
          userId: admin.id,
          role: "member"
        });
        assert.strictEqual(
          (yield* (yield* Teams.Teams)
            .setMemberships({ ...input, actorId: admin.id })
            .pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        yield* (yield* Teams.Teams).setMemberships(input);
        yield* users.deactivate({ ...ref, userId: member.id });
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
        yield* (yield* Teams.Teams).setMemberships({ ...input, added: false });
        yield* users.reactivate({ ...ref, userId: member.id });
        assert.deepStrictEqual(
          (yield* (yield* Teams.Teams).memberships(ref.companyId, [member.id])).get(member.id)!,
          []
        );
      })
  );
  it.effect("preserves admin removal rules for inactive targets", () =>
    Effect.gen(function* () {
      const { ref, admin, member } = yield* setup("teams-inactive-admin");
      const teams = yield* Teams.Teams;
      const users = yield* Users.Users;
      const team = yield* teams.create({ ...ref, name: "Finance" });
      const input = { ...ref, teamId: team.id, userIds: [admin.id, member.id], added: true };
      yield* teams.setMemberships(input);
      yield* users.deactivate({ ...ref, userId: member.id });
      assert.deepStrictEqual(
        (yield* teams.memberships(ref.companyId, [admin.id, member.id])).get(member.id),
        []
      );
      yield* teams.setMemberships({
        ...input,
        actorId: admin.id,
        userIds: [member.id],
        added: false
      });
      yield* users.deactivate({ ...ref, userId: admin.id });
      const second = yield* setup("teams-admin-outsider");
      assert.strictEqual(
        (yield* teams
          .setMemberships({ ...input, actorId: second.admin.id, added: false })
          .pipe(Effect.flip))._tag,
        "RoleForbidden"
      );
      yield* teams.setMemberships({ ...input, userIds: [admin.id], added: false });
      yield* users.reactivate({ ...ref, userId: member.id });
      yield* users.reactivate({ ...ref, userId: admin.id });
      assert.deepStrictEqual(yield* teams.members({ ...ref, teamId: team.id }), []);
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
