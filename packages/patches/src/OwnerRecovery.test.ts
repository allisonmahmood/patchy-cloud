import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Statement from "effect/sql/Statement";
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
  members: { kind: "teams", teamIds: ids },
  guests: { kind: "specific", userIds: [] }
});
const team = Effect.fn("test.team")(function* (name: string, userIds: readonly string[]) {
  const t = yield* Teams.create({ ...viewer, name });
  yield* Teams.setMemberships({ ...viewer, teamId: t.id, userIds, added: true });
  return t;
});
const services = GuestGrants.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Patches.layer, Users.layer, Companies.layer)),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provideMerge(Fixtures.database),
  Layer.provide(Layer.succeed(Audiences.Activation, true))
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
        assert.equal(
          (yield* Effect.flip(patches.authorizePublish({ ...input, intent: "update" })))._tag,
          "PatchUnavailable"
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
        assert.isTrue(
          (yield* patches.list(access(admin.user.id))).some((v) => v.patch.id === input.patchId)
        );
        assert.equal(
          (yield* Effect.flip(
            patches.reassign(input.patchId, actor, uploader.user.id, uploader.user.id)
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
        const queries: string[] = [];
        const trace: Statement.Transformer = (statement) => {
          queries.push(statement.compile()[0]);
          return Effect.succeed(statement);
        };
        const eligible = yield* patches
          .eligibleOwners(input.patchId, actor)
          .pipe(Effect.provideService(Statement.CurrentTransformer, trace));
        assert.equal(
          queries.filter((query) => query.includes("LEFT JOIN effective_memberships")).length,
          1
        );
        queries.length = 0;
        const single = yield* patches
          .management(viewer.companyId, admin.user.id, input.patchId)
          .pipe(Effect.provideService(Statement.CurrentTransformer, trace));
        assert.lengthOf(single, 1);
        assert.equal(
          queries.filter((query) => query.includes("LEFT JOIN effective_memberships")).length,
          1
        );
        assert.isTrue(
          queries.some((query) => query.includes("p.id =") && query.includes("p.name ="))
        );
        assert.deepEqual(
          eligible.map((p) => p.id),
          [admin.user.id, reader.user.id]
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
        const versions = yield* patches.managementVersions(input.patchId, actor);
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
          "PatchUnavailable"
        );
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "member" });
      }).pipe(Effect.provideService(Audiences.Activation, true))
  );
  it.effect(
    "shows only self-joining records for the current owner's selected teams and membership restoration restores publishing",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const users = yield* Users.Users;
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "admin" });
        const self = { ...viewer, actorId: reader.user.id };
        const t = yield* team("History", [uploader.user.id]);
        const unrelated = yield* team("Unrelated history", []);
        const input = Fixtures.recordInput(uploader, { audience: teamAudience([t.id]) });
        yield* Fixtures.record(input);
        for (let i = 0; i < 102; i++)
          yield* Teams.setMemberships({
            ...self,
            teamId: unrelated.id,
            userIds: [reader.user.id],
            added: i % 2 === 0
          });
        for (const teamId of [t.id, unrelated.id])
          yield* Teams.setMemberships({ ...self, teamId, userIds: [reader.user.id], added: true });
        yield* Teams.setMemberships({
          ...viewer,
          teamId: t.id,
          userIds: [uploader.user.id],
          added: false
        });
        const history = yield* patches.managementHistory(input.patchId, uploader.user.id);
        assert.equal(history.length, 1);
        assert.equal(history[0]!.actorId, reader.user.id);
        assert.equal(history[0]!.teamId, t.id);
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
        yield* patches.authorizePublish({ ...input, intent: "update" });
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "member" });
      }).pipe(Effect.provideService(Audiences.Activation, true))
  );
});
