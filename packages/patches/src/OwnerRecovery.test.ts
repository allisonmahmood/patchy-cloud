import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Analytics } from "@patchy/analytics";
import { Companies, Teams, Users } from "@patchy/companies";
import type { PatchAudience } from "@patchy/api";
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
it.layer(services)("Owner recovery", (it) => {
  it.effect(
    "recovers an inaccessible owner without admitting content, stale actors or ineligible targets",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const users = yield* Users.Users;
        const t = yield* team("Recovery", [uploader.user.id, reader.user.id]);
        const input = Fixtures.recordInput(uploader, { audience: teamAudience([t.id]) });
        yield* Fixtures.record(input);
        yield* Teams.setMemberships({
          ...viewer,
          teamId: t.id,
          userIds: [uploader.user.id],
          added: false
        });
        const actor = { userId: admin.user.id, admin: true };
        const ownerView = (yield* patches.management(viewer.companyId, uploader.user.id)).find(
          (v) => v.record.id === input.patchId
        )!;
        assert.isFalse(ownerView.canOpen);
        assert.isFalse(ownerView.canManage);
        assert.isFalse(ownerView.ownerCanOpen);
        assert.notProperty(ownerView.record, "description");
        assert.notProperty(ownerView.record, "manifest");
        const sameNameAsId = Fixtures.recordInput(reader, {
          title: input.patchId,
          audience: teamAudience([t.id])
        });
        yield* Fixtures.record(sameNameAsId);
        assert.deepEqual(
          (yield* patches.management(viewer.companyId, admin.user.id, { name: input.patchId })).map(
            (view) => view.record.id
          ),
          [sameNameAsId.patchId]
        );
        assert.deepEqual(
          (yield* patches.management(viewer.companyId, admin.user.id, { id: input.patchId })).map(
            (view) => view.record.id
          ),
          [input.patchId]
        );

        assert.equal(
          (yield* Effect.flip(patches.authorizePublish({ ...input, intent: "update" })))._tag,
          "OwnerAccessLost"
        );
        assert.equal(
          (yield* Effect.flip(patches.portalCard(input.patchId, access(uploader.user.id))))._tag,
          "PatchUnavailable"
        );
        assert.equal(
          (yield* patches.management(viewer.companyId, admin.user.id)).find(
            (v) => v.record.id === input.patchId
          )!.canManage,
          true
        );
        assert.equal(
          (yield* Effect.flip(patches.setDescription(input.patchId, actor, "forbidden")))._tag,
          "PatchUnavailable"
        );
        const metadata = yield* patches.manage(input.patchId, actor);
        assert.notProperty(metadata, "title");
        assert.notProperty(metadata, "description");
        assert.notProperty(metadata, "manifest");
        assert.isFalse(
          (yield* patches.list(access(admin.user.id))).some((v) => v.patch.id === input.patchId)
        );
        assert.equal(
          (yield* Effect.flip(
            patches.reassign(input.patchId, actor, admin.user.id, uploader.user.id)
          ))._tag,
          "InvalidOwner"
        );
        assert.equal(
          (yield* Effect.flip(
            patches.reassign(
              input.patchId,
              { userId: reader.user.id, admin: true },
              reader.user.id,
              uploader.user.id
            )
          ))._tag,
          "NotOwner"
        );
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "admin" });
        const eligible = yield* patches.eligibleOwners(input.patchId, actor);
        assert.lengthOf(
          yield* patches.management(viewer.companyId, admin.user.id, { id: input.patchId }),
          1
        );
        assert.deepEqual(
          eligible.map((p) => p.id),
          [reader.user.id]
        );
        yield* patches.reassign(
          input.patchId,
          { userId: reader.user.id, admin: true },
          reader.user.id,
          uploader.user.id
        );
        assert.equal(
          (yield* Effect.flip(
            patches.reassign(input.patchId, actor, reader.user.id, uploader.user.id)
          ))._tag,
          "StaleAction"
        );
        const versions = (yield* patches.management(viewer.companyId, admin.user.id, {
          id: input.patchId
        }))[0]!.versions;
        assert.equal(versions[0]!.publisherName, uploader.user.name);
        yield* patches.retire(input.patchId, actor);
        yield* patches.restore(input.patchId, actor);
        yield* Teams.setMemberships({
          ...viewer,
          teamId: t.id,
          userIds: [reader.user.id],
          added: false
        });
        assert.equal(
          (yield* Effect.flip(
            patches.manage(input.patchId, { userId: reader.user.id, admin: true })
          ))._tag,
          "OwnerAccessLost"
        );
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "member" });
      })
  );
  it.effect("a super-admin owner loses content access after leaving the only audience team", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const users = yield* Users.Users;
      yield* users.setRole({ ...viewer, userId: uploader.user.id, role: "super_admin" });
      const t = yield* team("Super owner recovery", [uploader.user.id]);
      const input = Fixtures.recordInput(uploader, { audience: teamAudience([t.id]) });
      yield* Fixtures.record(input);
      yield* Teams.setMemberships({
        ...viewer,
        actorId: uploader.user.id,
        teamId: t.id,
        userIds: [uploader.user.id],
        added: false
      });
      const view = (yield* patches.management(viewer.companyId, uploader.user.id, {
        id: input.patchId
      }))[0]!;
      assert.isFalse(view.canOpen);
      assert.isFalse(view.ownerCanOpen);
      assert.isTrue(view.canManage);
      assert.equal(
        (yield* patches.authorizePublish({ ...input, intent: "update" }).pipe(Effect.flip))._tag,
        "OwnerAccessLost"
      );
      yield* users.setRole({ ...viewer, userId: uploader.user.id, role: "member" });
    })
  );
  it.effect(
    "shows only self-joining records for the current owner's selected teams and membership restoration restores publishing",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const t = yield* team("History", [uploader.user.id]);
        const unrelated = yield* team("Unrelated history", []);
        const input = Fixtures.recordInput(uploader, { audience: teamAudience([t.id]) });
        yield* Fixtures.record(input);
        for (const teamId of [t.id, unrelated.id])
          yield* Teams.setMemberships({ ...viewer, teamId, userIds: [admin.user.id], added: true });
        yield* Teams.setMemberships({
          ...viewer,
          teamId: t.id,
          userIds: [uploader.user.id],
          added: false
        });
        const history = yield* patches.managementHistory(input.patchId, uploader.user.id);
        assert.equal(history.length, 0);
        assert.equal(
          (yield* Effect.flip(patches.managementHistory(input.patchId, reader.user.id)))._tag,
          "PatchUnavailable"
        );
        yield* Teams.setMemberships({
          ...viewer,
          teamId: t.id,
          userIds: [uploader.user.id],
          added: true
        });
        assert.equal((yield* patches.managementHistory(input.patchId, uploader.user.id)).length, 1);
        yield* patches.authorizePublish({ ...input, intent: "update" });
      })
  );
});
