import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { Companies, Teams, Users } from "@patchy/companies";
import type { PatchAudience } from "@patchy/api";
import * as Audiences from "./Audiences.js";
import * as GuestGrants from "./GuestGrants.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const { admin, uploader, reader } = Fixtures.identities;
const viewer = { companyId: admin.company.id, actorId: admin.user.id };
const access = (userId: string) => ({
  companyId: admin.company.id,
  userId,
  state: "all" as const,
  canOpen: () => true
});
const teamAudience = (ids: readonly string[]): PatchAudience => ({
  members: { kind: "teams", teamIds: ids }
});
const team = Effect.fn("test.team")(function* (name: string, userIds: readonly string[]) {
  const t = yield* Teams.create({ ...viewer, name });
  yield* Teams.setMemberships({ ...viewer, teamId: t.id, userIds, added: true });
  return t;
});
const services = GuestGrants.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Patches.layer, Users.layer, Companies.layer)),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provideMerge(Fixtures.database)
);
it.layer(services)("Patch audiences", (it) => {
  it.effect("defaults omitted first-publish audiences to Company", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const input = Fixtures.recordInput(uploader, { scope: undefined });
      yield* patches.preflight(input);
      const created = yield* Fixtures.record(input);
      assert.deepStrictEqual(created.audience, Audiences.company());
    })
  );
  it.effect(
    "commits multiple team grants with publication; roles and ownership never bypass current membership",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const design = yield* team("Design union", [uploader.user.id]);
        const engineering = yield* team("Engineering union", [uploader.user.id, reader.user.id]);
        const input = Fixtures.recordInput(uploader, {
          audience: teamAudience([design.id, engineering.id])
        });
        const published = yield* Fixtures.record(input);
        assert.deepStrictEqual(published.audience, input.audience);
        assert.isTrue(
          (yield* patches.list(access(reader.user.id))).some(
            (row) => row.patch.id === input.patchId
          )
        );
        assert.isFalse(
          (yield* patches.list(access(admin.user.id))).some((row) => row.patch.id === input.patchId)
        );
        yield* Teams.setMemberships({
          ...viewer,
          teamId: engineering.id,
          userIds: [reader.user.id],
          added: false
        });
        assert.isFalse(
          yield* Audiences.canOpen(
            Option.getOrThrow(yield* patches.find(input.patchId)).patch,
            viewer.companyId,
            reader.user.id
          )
        );
        yield* Teams.setMemberships({
          ...viewer,
          teamId: engineering.id,
          userIds: [reader.user.id],
          added: true
        });
        assert.isTrue(
          yield* Audiences.canOpen(
            Option.getOrThrow(yield* patches.find(input.patchId)).patch,
            viewer.companyId,
            reader.user.id
          )
        );
        yield* Teams.rename({ ...viewer, teamId: design.id, name: "Renamed design union" });
        for (const t of [design, engineering])
          yield* Teams.setMemberships({
            ...viewer,
            teamId: t.id,
            userIds: [uploader.user.id],
            added: false
          });
        assert.isFalse(
          yield* Audiences.canOpen(
            Option.getOrThrow(yield* patches.find(input.patchId)).patch,
            viewer.companyId,
            uploader.user.id
          )
        );
        assert.equal(
          (yield* Effect.flip(patches.authorizePublish({ ...input, intent: "update" })))._tag,
          "OwnerAccessLost"
        );
        assert.equal(
          (yield* Effect.flip(
            patches.manage(input.patchId, { userId: admin.user.id, admin: true })
          ))._tag,
          "PatchUnavailable"
        );
      })
  );
  it.effect("member sharing preserves existing teams outside their memberships", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const own = yield* team("Visible owner team", [uploader.user.id, admin.user.id]);
      const hidden = yield* team("Hidden existing team", [reader.user.id]);
      const input = Fixtures.recordInput(uploader, { audience: teamAudience([own.id]) });
      yield* Fixtures.record(input);
      yield* patches.setSharing({
        patchId: input.patchId,
        actor: { userId: admin.user.id, admin: true },
        audience: teamAudience([own.id, hidden.id])
      });
      const result = yield* patches.setSharing({
        patchId: input.patchId,
        actor: { userId: uploader.user.id, admin: false },
        audience: teamAudience([own.id])
      });
      assert.deepStrictEqual(result.audience.members, teamAudience([own.id, hidden.id]).members);
    })
  );
  it.effect("legacy Company sharing retains teams; explicit audience widens", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const t = yield* team("Legacy Company", [uploader.user.id]);
      const audience = teamAudience([t.id]);
      const input = Fixtures.recordInput(uploader, { audience });
      yield* Fixtures.record(input);
      const actor = { userId: uploader.user.id, admin: false };
      const retained = yield* patches.setSharing({
        patchId: input.patchId,
        actor,
        scope: "company"
      });
      assert.deepStrictEqual(retained.audience, audience);
      const updated = yield* Fixtures.record(
        Fixtures.recordInput(uploader, {
          intent: "update",
          patchId: input.patchId,
          scope: "company"
        })
      );
      assert.deepStrictEqual(updated.audience, audience);
      const widened = yield* patches.setSharing({
        patchId: input.patchId,
        actor,
        audience: Audiences.company()
      });
      assert.deepStrictEqual(widened.audience, Audiences.company());
    })
  );
  it.effect(
    "rejects unknown teams and owner-excluding sharing without partially changing the audience",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const own = yield* team("Owner included", [uploader.user.id]);
        const other = yield* team("Owner excluded", [reader.user.id]);
        const input = Fixtures.recordInput(uploader, { audience: teamAudience([own.id]) });
        yield* Fixtures.record(input);
        const actor = { userId: uploader.user.id, admin: false };
        for (const ids of [["unknown-team"], [other.id]]) {
          assert.equal(
            (yield* Effect.flip(
              patches.setSharing({
                patchId: input.patchId,
                actor: actor,
                audience: teamAudience(ids)
              })
            ))._tag,
            "InvalidAudienceTeams"
          );
        }
        const [found] = yield* patches.list({
          ...access(uploader.user.id),
          patchRef: input.patchId
        });
        assert.deepStrictEqual(found!.patch.audience, input.audience);
      })
  );
  it.effect(
    "retains audience on republish and rollback and rolls back audience authority with its outer transaction",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const sql = yield* SqlClient.SqlClient;
        const t = yield* team("Retained audience", [uploader.user.id]);
        const input = Fixtures.recordInput(uploader, { audience: teamAudience([t.id]) });
        yield* Fixtures.record(input);
        const updated = yield* Fixtures.record(
          Fixtures.recordInput(uploader, {
            intent: "update",
            patchId: input.patchId,
            scope: undefined
          })
        );
        assert.deepStrictEqual(updated.audience, input.audience);
        yield* patches.rollback(input.patchId, { userId: uploader.user.id, admin: false }, 1);
        yield* sql
          .withTransaction(
            patches
              .setSharing({
                patchId: input.patchId,
                actor: { userId: uploader.user.id, admin: false },
                audience: Audiences.company()
              })
              .pipe(Effect.andThen(Effect.fail("abort")))
          )
          .pipe(Effect.catch(() => Effect.void));
        const [found] = yield* patches.list({
          ...access(uploader.user.id),
          patchRef: input.patchId
        });
        assert.deepStrictEqual(found!.patch.audience, input.audience);
      })
  );
  it.effect("keeps named guests during team edits and permits inactive-owner sharing repair", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const grants = yield* GuestGrants.GuestGrants;
      const sql = yield* SqlClient.SqlClient;
      const outside = yield* (yield* Companies.Companies).create({
        handle: "review-guest",
        name: "Outside",
        clerkUserId: "review-guest",
        email: "review@outside.example",
        userName: "Guest"
      });
      const t = yield* team("Guest preservation", [uploader.user.id, admin.user.id]);
      const input = Fixtures.recordInput(uploader);
      yield* Fixtures.record(input);
      const owner = { userId: uploader.user.id, admin: false };
      yield* grants.share({ patchId: input.patchId, actor: owner, email: outside.user.email });
      yield* patches.setSharing({
        patchId: input.patchId,
        actor: owner,
        audience: teamAudience([t.id])
      });
      assert.deepStrictEqual(
        (yield* grants.guests(input.patchId)).map((g) => g.userId),
        [outside.user.id]
      );
      const outsiderView = yield* grants.companyGuests(viewer.companyId, {
        userId: reader.user.id,
        admin: false
      });
      assert.deepStrictEqual(outsiderView.find((g) => g.userId === outside.user.id)?.patches, []);
      yield* sql`UPDATE users SET role = 'super_admin' WHERE id = ${reader.user.id}`;
      const oversight = yield* grants.companyGuests(viewer.companyId, {
        userId: reader.user.id,
        admin: true
      });
      assert.equal(oversight.find((g) => g.userId === outside.user.id)?.patches[0]?.title, null);
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${outside.user.id}`;
      yield* patches.setSharing({
        patchId: input.patchId,
        actor: owner,
        audience: teamAudience([t.id])
      });
      assert.lengthOf(yield* grants.guests(input.patchId), 1);
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${uploader.user.id}`;
      const adminActor = { userId: admin.user.id, admin: true };
      const repaired = yield* patches.setSharing({
        patchId: input.patchId,
        actor: adminActor,
        audience: Audiences.company()
      });
      assert.equal(repaired.scope, "company");
      yield* grants.remove({ patchId: input.patchId, actor: adminActor, guest: outside.user.id });
      assert.deepStrictEqual(
        yield* sql`SELECT last_changed_by FROM patches WHERE id = ${input.patchId}`,
        [{ last_changed_by: admin.user.id }]
      );
      assert.lengthOf(yield* grants.guests(input.patchId), 0);
      yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = ${uploader.user.id}`;
    })
  );
});
