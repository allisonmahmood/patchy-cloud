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
const services = Layer.mergeAll(Companies.layer, Users.layer, Teams.layer, Directory.layer).pipe(
  Layer.provideMerge(Testing.layer()),
  Layer.provideMerge(NodeCryptography.layer)
);
it.layer(services)("Teams", (it) => {
  it.effect(
    "keeps independent overlapping memberships and stable identities across service reconstruction",
    () =>
      Effect.gen(function* () {
        const { ref, admin, member } = yield* setup("teams-overlap");
        const teams = yield* Teams.Teams;
        const design = yield* teams.create({ ...ref, name: " Design " });
        const engineering = yield* teams.create({ ...ref, name: "Engineering" });
        const asAdmin = { ...ref, actorId: admin.id };
        for (const teamId of [design.id, engineering.id]) {
          yield* teams.setMembership({ ...asAdmin, teamId, userId: admin.id, added: true });
          yield* teams.setMembership({ ...asAdmin, teamId, userId: member.id, added: true });
        }
        yield* teams.rename({ ...asAdmin, teamId: design.id, name: "Product Design" });
        yield* teams.setMembership({
          ...asAdmin,
          teamId: design.id,
          userId: member.id,
          added: false
        });
        const rebuilt = yield* Teams.make;
        assert.deepStrictEqual(
          (yield* rebuilt.list(ref)).map((team) => team.id).sort(),
          [design.id, engineering.id].sort()
        );
        assert.deepStrictEqual(yield* rebuilt.members({ ...ref, teamId: design.id }), [admin.id]);
        assert.deepStrictEqual(yield* rebuilt.memberships(ref.companyId, member.id), [
          engineering.id
        ]);
        yield* rebuilt.setMembership({
          ...asAdmin,
          teamId: design.id,
          userId: member.id,
          added: true
        });
        assert.strictEqual((yield* rebuilt.memberships(ref.companyId, member.id)).length, 2);
        const changes = yield* rebuilt.changes(ref.companyId, "0");
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
        const teams = yield* Teams.Teams;
        const users = yield* Users.Users;
        const team = yield* teams.create({ ...ref, name: "Design" });
        const input = { ...ref, teamId: team.id, userId: member.id, added: true };
        for (const action of [
          teams.create({ ...ref, actorId: member.id, name: "Hidden" }).pipe(Effect.asVoid),
          teams.rename({ ...input, actorId: member.id, name: "Hidden" }).pipe(Effect.asVoid),
          teams.setMembership({ ...input, actorId: member.id }).pipe(Effect.asVoid)
        ]) {
          assert.strictEqual((yield* action.pipe(Effect.flip))._tag, "RoleForbidden");
        }
        assert.strictEqual(
          (yield* teams.setMembership({ ...input, userId: other.user.id }).pipe(Effect.flip))._tag,
          "UserNotFound"
        );
        assert.strictEqual(
          (yield* teams
            .setMembership({ ...other.ref, teamId: team.id, userId: other.user.id, added: true })
            .pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        assert.strictEqual(
          (yield* teams.members({ ...other.ref, teamId: team.id }).pipe(Effect.flip))._tag,
          "TeamNotFound"
        );
        yield* users.setRole({
          companyId: ref.companyId,
          actorId: ref.actorId,
          userId: admin.id,
          role: "member"
        });
        assert.strictEqual(
          (yield* teams.setMembership({ ...input, actorId: admin.id }).pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        yield* teams.setMembership(input);
        yield* users.deactivate({ ...ref, userId: member.id });
        assert.deepStrictEqual(yield* teams.memberships(ref.companyId, member.id), []);
        assert.strictEqual(
          (yield* teams.setMembership(input).pipe(Effect.flip))._tag,
          "UserNotFound"
        );
        assert.strictEqual(
          (yield* teams.list({ ...ref, actorId: member.id }).pipe(Effect.flip))._tag,
          "RoleForbidden"
        );
        yield* users.reactivate({ ...ref, userId: member.id });
        assert.deepStrictEqual(yield* teams.memberships(ref.companyId, member.id), [team.id]);
      })
  );
  it.effect(
    "normalizes names, refuses duplicates within a company and preserves identity on no-op rename",
    () =>
      Effect.gen(function* () {
        const { ref } = yield* setup("teams-names");
        const teams = yield* Teams.Teams;
        const team = yield* teams.create({ ...ref, name: "  Product   Design " });
        assert.strictEqual(team.name, "Product Design");
        assert.strictEqual(
          (yield* teams.create({ ...ref, name: "product design" }).pipe(Effect.flip))._tag,
          "TeamNameTaken"
        );
        for (const name of ["   ", "x".repeat(101)])
          assert.strictEqual(
            (yield* teams.create({ ...ref, name }).pipe(Effect.flip))._tag,
            "InvalidTeamName"
          );
        const other = yield* teams.create({ ...ref, name: "Engineering" });
        assert.strictEqual(
          (yield* teams
            .rename({ ...ref, teamId: other.id, name: "Product Design" })
            .pipe(Effect.flip))._tag,
          "TeamNameTaken"
        );
        const directory = yield* Directory.Directory;
        const before = yield* directory.revision(ref.companyId);
        assert.strictEqual(
          (yield* teams.rename({ ...ref, teamId: team.id, name: team.name })).id,
          team.id
        );
        assert.strictEqual(yield* directory.revision(ref.companyId), before);
      })
  );
  it.effect("serializes concurrent membership edits into one effective fact", () =>
    Effect.gen(function* () {
      const { ref, member } = yield* setup("teams-concurrent");
      const teams = yield* Teams.Teams;
      const team = yield* teams.create({ ...ref, name: "Design" });
      const input = { ...ref, teamId: team.id, userId: member.id, added: true };
      const results = yield* Effect.all([teams.setMembership(input), teams.setMembership(input)], {
        concurrency: 2
      });
      assert.deepStrictEqual([...results].sort(), [false, true]);
      assert.strictEqual((yield* teams.changes(ref.companyId, "0")).length, 1);
    })
  );
  it.effect(
    "publishes membership revisions and attributable facts only after outer commit, never for rollback or no-op",
    () =>
      Effect.gen(function* () {
        const { ref, member } = yield* setup("teams-commit");
        const teams = yield* Teams.Teams;
        const directory = yield* Directory.Directory;
        const sql = yield* SqlClient.SqlClient;
        const pg = yield* PgClient.PgClient;
        const team = yield* teams.create({ ...ref, name: "Design" });
        const input = { ...ref, teamId: team.id, userId: member.id, added: true };
        const initial = yield* directory.revision(ref.companyId);
        const notifications = yield* pg.listen("patchy_runtime_wakes");
        const barrier = Effect.gen(function* () {
          yield* pg.notify("patchy_runtime_wakes", "barrier");
          assert.strictEqual((yield* Queue.take(notifications)).payload, "barrier");
        });
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* teams.setMembership(input);
              yield* barrier;
              return yield* Effect.fail("rollback");
            })
          )
          .pipe(Effect.flip);
        yield* barrier;
        assert.strictEqual(yield* directory.revision(ref.companyId), initial);
        assert.deepStrictEqual(yield* teams.changes(ref.companyId, "0"), []);
        assert.deepStrictEqual(yield* teams.memberships(ref.companyId, member.id), []);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* teams.setMembership(input);
            yield* barrier;
          })
        );
        assert.include((yield* Queue.take(notifications)).payload, `members:${ref.companyId}`);
        const committed = yield* directory.revision(ref.companyId);
        const facts = yield* teams.changes(ref.companyId, initial);
        assert.strictEqual(facts.length, 1);
        assert.strictEqual(facts[0]!.revision, committed);
        assert.strictEqual(facts[0]!.actorId, ref.actorId);
        assert.isFalse(yield* teams.setMembership(input));
        yield* barrier;
        assert.strictEqual(yield* directory.revision(ref.companyId), committed);
        assert.deepStrictEqual(yield* teams.changes(ref.companyId, committed), []);
      }).pipe(Effect.scoped)
  );
});
