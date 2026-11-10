import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as PgClient from "@effect/sql-pg/PgClient";
import { NodeCryptography } from "@patchy/core";
import * as Testing from "@patchy/sql/testing";
import * as Companies from "./Companies.js";
import * as Directory from "./Directory.js";
import * as Teams from "./Teams.js";
import * as Users from "./Users.js";

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
const services = Layer.mergeAll(Companies.layer, Users.layer, Directory.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);
it.layer(services)("Teams", (it) => {
  it.effect("protects admins atomically while allowing self-leave and super-admin management", () =>
    Effect.gen(function* () {
      const { ref, admin, member } = yield* setup("teams-protection");
      const users = yield* Users.Users;
      yield* users.setRole({ ...ref, userId: member.id, role: "admin" });
      const team = yield* Teams.create({ ...ref, name: "Finance" });
      const input = { ...ref, teamId: team.id, userIds: [admin.id, member.id], added: true };
      yield* Teams.setMemberships(input);
      assert.equal(
        (yield* Teams.setMemberships({
          ...input,
          actorId: admin.id,
          userIds: [ref.actorId],
          added: false
        }).pipe(Effect.flip))._tag,
        "RoleForbidden"
      );
      const directory = yield* Directory.Directory;
      const before = yield* directory.revision(ref.companyId);
      assert.equal(
        (yield* Teams.setMemberships({ ...input, actorId: admin.id, added: false }).pipe(
          Effect.flip
        ))._tag,
        "RoleForbidden"
      );
      assert.equal(yield* directory.revision(ref.companyId), before);
      assert.deepEqual(yield* Teams.memberships(ref.companyId, admin.id), [team.id]);
      assert.equal(
        yield* Teams.setMemberships({
          ...input,
          actorId: admin.id,
          userIds: [admin.id],
          added: false
        }),
        1
      );
      assert.equal(
        yield* Teams.setMemberships({ ...input, userIds: [member.id], added: false }),
        1
      );
    })
  );
  it.effect(
    "hides nonmember teams and rosters, including stale identifiers, until membership returns",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-visibility");
        const finance = yield* Teams.create({ ...ref, name: "Finance" });
        const design = yield* Teams.create({ ...ref, name: "Design" });
        const asMember = { ...ref, actorId: member.id };
        assert.deepEqual(yield* Teams.list(asMember), []);
        assert.equal(
          (yield* Teams.members({ ...asMember, teamId: finance.id }).pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        const input = { ...ref, teamId: finance.id, userIds: [member.id], added: true };
        yield* Teams.setMemberships(input);
        assert.deepEqual(
          (yield* Teams.list(asMember)).map((t) => t.id),
          [finance.id]
        );
        assert.deepEqual(yield* Teams.members({ ...asMember, teamId: finance.id }), [member.id]);
        assert.equal(
          (yield* Teams.members({ ...asMember, teamId: design.id }).pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        assert.lengthOf(yield* Teams.list({ ...ref, actorId: admin.id }), 2);
        yield* Teams.setMemberships({ ...input, added: false });
        assert.deepEqual(yield* Teams.list(asMember), []);
        assert.equal(
          (yield* Teams.members({ ...asMember, teamId: finance.id }).pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        yield* Teams.setMemberships(input);
        assert.lengthOf(yield* Teams.list(asMember), 1);
      })
  );
  it.effect("super admins join and leave through recorded memberships", () =>
    Effect.gen(function* () {
      const { ref, admin } = yield* setup("teams-recorded-super");
      const users = yield* Users.Users;
      const team = yield* Teams.create({ ...ref, name: "Finance" });
      yield* users.setRole({ ...ref, userId: admin.id, role: "super_admin" });
      assert.deepEqual(yield* Teams.memberships(ref.companyId, admin.id), []);
      const input = {
        ...ref,
        actorId: admin.id,
        teamId: team.id,
        userIds: [admin.id],
        added: true
      };
      assert.equal(yield* Teams.setMemberships(input), 1);
      assert.deepEqual(yield* Teams.memberships(ref.companyId, admin.id), [team.id]);
      assert.equal(yield* Teams.setMemberships({ ...input, added: false }), 1);
      assert.deepEqual(yield* Teams.memberships(ref.companyId, admin.id), []);
    })
  );
  it.effect(
    "owns atomic batch edits, preserving attribution and authority on a failed selection",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-batch");
        const directory = yield* Directory.Directory;
        const team = yield* Teams.create({ ...ref, name: "Design" });
        const input = { ...ref, teamId: team.id, userIds: [admin.id, member.id], added: true };
        const before = yield* directory.revision(ref.companyId);
        const failed = yield* Teams.setMemberships({
          ...input,
          userIds: [admin.id, "missing-person"]
        }).pipe(Effect.flip);
        assert.strictEqual(failed._tag, "UserNotFound");
        assert.deepStrictEqual(yield* Teams.members({ ...ref, teamId: team.id }), []);
        assert.deepStrictEqual(yield* Teams.changes(ref.companyId, before), []);
        assert.strictEqual(yield* directory.revision(ref.companyId), before);
        assert.strictEqual(
          yield* Teams.setMemberships({ ...input, userIds: [admin.id, admin.id, member.id] }),
          2
        );
        const facts = yield* Teams.changes(ref.companyId, before);
        assert.strictEqual(facts.length, 2);
        assert.isTrue(facts.every((change) => change.actorId === ref.actorId));
        const committed = yield* directory.revision(ref.companyId);
        assert.strictEqual(yield* Teams.setMemberships(input), 0);
        assert.strictEqual(yield* Teams.setMemberships({ ...input, userIds: [] }), 0);
        assert.strictEqual(yield* directory.revision(ref.companyId), committed);
        assert.deepStrictEqual(yield* Teams.changes(ref.companyId, committed), []);
        assert.strictEqual(yield* Teams.setMemberships({ ...input, added: false }), 2);
        assert.deepStrictEqual(yield* Teams.members({ ...ref, teamId: team.id }), []);
      })
  );

  it.effect(
    "keeps independent overlapping memberships and stable identities in durable storage",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-overlap");
        const design = yield* Teams.create({ ...ref, name: " Design " });
        const engineering = yield* Teams.create({ ...ref, name: "Engineering" });
        const asAdmin = { ...ref, actorId: admin.id };
        for (const teamId of [design.id, engineering.id]) {
          yield* Teams.setMemberships({ ...asAdmin, teamId, userIds: [admin.id], added: true });
          yield* Teams.setMemberships({ ...asAdmin, teamId, userIds: [member.id], added: true });
        }
        yield* Teams.rename({ ...asAdmin, teamId: design.id, name: "Product Design" });
        yield* Teams.setMemberships({
          ...asAdmin,
          teamId: design.id,
          userIds: [member.id],
          added: false
        });
        assert.deepStrictEqual(
          (yield* Teams.list(ref)).map((team) => team.id).sort(),
          [design.id, engineering.id].sort()
        );
        assert.deepStrictEqual(yield* Teams.members({ ...ref, teamId: design.id }), [admin.id]);
        assert.deepStrictEqual(yield* Teams.memberships(ref.companyId, member.id), [
          engineering.id
        ]);
        yield* Teams.setMemberships({
          ...asAdmin,
          teamId: design.id,
          userIds: [member.id],
          added: true
        });
        assert.strictEqual((yield* Teams.memberships(ref.companyId, member.id)).length, 2);
        const changes = yield* Teams.changes(ref.companyId, "0");
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
        const team = yield* Teams.create({ ...ref, name: "Design" });
        const input = { ...ref, teamId: team.id, userIds: [member.id], added: true };
        assert.strictEqual(
          (yield* Teams.create({ ...ref, actorId: member.id, name: "Hidden" }).pipe(Effect.flip))
            ._tag,
          "RoleForbidden"
        );
        assert.strictEqual(
          (yield* Teams.rename({ ...input, actorId: member.id, name: "Hidden" }).pipe(Effect.flip))
            ._tag,
          "RoleForbidden"
        );
        assert.strictEqual(
          (yield* Teams.setMemberships({ ...input, actorId: member.id }).pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        assert.strictEqual(
          (yield* Teams.setMemberships({ ...input, userIds: [other.user.id] }).pipe(Effect.flip))
            ._tag,
          "UserNotFound"
        );
        assert.strictEqual(
          (yield* Teams.setMemberships({
            ...other.ref,
            teamId: team.id,
            userIds: [other.user.id],
            added: true
          }).pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        assert.strictEqual(
          (yield* Teams.members({ ...other.ref, teamId: team.id }).pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        yield* users.setRole({
          companyId: ref.companyId,
          actorId: ref.actorId,
          userId: admin.id,
          role: "member"
        });
        assert.strictEqual(
          (yield* Teams.setMemberships({ ...input, actorId: admin.id }).pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        yield* Teams.setMemberships(input);
        yield* users.deactivate({ ...ref, userId: member.id });
        assert.deepStrictEqual(yield* Teams.memberships(ref.companyId, member.id), []);
        assert.strictEqual(
          (yield* Teams.setMemberships(input).pipe(Effect.flip))._tag,
          "UserNotFound"
        );
        assert.strictEqual(
          (yield* Teams.list({ ...ref, actorId: member.id }).pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        yield* users.reactivate({ ...ref, userId: member.id });
        assert.deepStrictEqual(yield* Teams.memberships(ref.companyId, member.id), [team.id]);
      })
  );
  it.effect(
    "normalizes names, refuses duplicates within a company and preserves identity on no-op rename",
    () =>
      Effect.gen(function* () {
        const { ref } = yield* setup("teams-names");
        const team = yield* Teams.create({ ...ref, name: "  Product   Design " });
        assert.strictEqual(team.name, "Product Design");
        assert.strictEqual(
          (yield* Teams.create({ ...ref, name: "product design" }).pipe(Effect.flip))._tag,
          "TeamNameTaken"
        );
        for (const name of ["   ", "x".repeat(101)])
          assert.strictEqual(
            (yield* Teams.create({ ...ref, name }).pipe(Effect.flip))._tag,
            "InvalidTeamName"
          );
        const other = yield* Teams.create({ ...ref, name: "Engineering" });
        assert.strictEqual(
          (yield* Teams.rename({ ...ref, teamId: other.id, name: "Product Design" }).pipe(
            Effect.flip
          ))._tag,
          "TeamNameTaken"
        );
        const directory = yield* Directory.Directory;
        const before = yield* directory.revision(ref.companyId);
        assert.strictEqual(
          (yield* Teams.rename({ ...ref, teamId: team.id, name: team.name })).id,
          team.id
        );
        assert.strictEqual(yield* directory.revision(ref.companyId), before);
      })
  );
  it.effect("serializes concurrent membership edits into one effective fact", () =>
    Effect.gen(function* () {
      const { ref, member } = yield* setup("teams-concurrent");
      const team = yield* Teams.create({ ...ref, name: "Design" });
      const input = { ...ref, teamId: team.id, userIds: [member.id], added: true };
      const results = yield* Effect.all(
        [Teams.setMemberships(input), Teams.setMemberships(input)],
        {
          concurrency: 2
        }
      );
      assert.deepStrictEqual([...results].sort(), [0, 1]);
      assert.strictEqual((yield* Teams.changes(ref.companyId, "0")).length, 1);
    })
  );
  it.effect(
    "publishes membership revisions and attributable facts only after outer commit, never for rollback or no-op",
    () =>
      Effect.gen(function* () {
        const { ref, member } = yield* setup("teams-commit");
        const directory = yield* Directory.Directory;
        const sql = yield* SqlClient.SqlClient;
        const pg = yield* PgClient.PgClient;
        const team = yield* Teams.create({ ...ref, name: "Design" });
        const input = { ...ref, teamId: team.id, userIds: [member.id], added: true };
        const initial = yield* directory.revision(ref.companyId);
        const notifications = yield* pg.listen("patchy_runtime_wakes");
        const barrier = Effect.gen(function* () {
          yield* pg.notify("patchy_runtime_wakes", "barrier");
          assert.strictEqual((yield* Queue.take(notifications)).payload, "barrier");
        });
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* Teams.setMemberships(input);
              yield* barrier;
              return yield* Effect.fail("rollback");
            })
          )
          .pipe(Effect.flip);
        yield* barrier;
        assert.strictEqual(yield* directory.revision(ref.companyId), initial);
        assert.deepStrictEqual(yield* Teams.changes(ref.companyId, "0"), []);
        assert.deepStrictEqual(yield* Teams.memberships(ref.companyId, member.id), []);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* Teams.setMemberships(input);
            yield* barrier;
          })
        );
        assert.include((yield* Queue.take(notifications)).payload, `members:${ref.companyId}`);
        const committed = yield* directory.revision(ref.companyId);
        const facts = yield* Teams.changes(ref.companyId, initial);
        assert.strictEqual(facts.length, 1);
        assert.strictEqual(facts[0]!.revision, committed);
        assert.strictEqual(facts[0]!.actorId, ref.actorId);
        assert.strictEqual(yield* Teams.setMemberships(input), 0);
        yield* barrier;
        assert.strictEqual(yield* directory.revision(ref.companyId), committed);
        assert.deepStrictEqual(yield* Teams.changes(ref.companyId, committed), []);
      }).pipe(Effect.scoped)
  );
});
