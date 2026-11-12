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
const teamAudience = (ids: readonly string[]): PatchAudience => ({ kind: "teams", teamIds: ids });
const team = Effect.fn("test.team")(function* (name: string, userIds: readonly string[]) {
  const t = yield* (yield* Teams.Teams).create({ ...viewer, name });
  yield* (yield* Teams.Teams).setMemberships({ ...viewer, teamId: t.id, add: userIds });
  return t;
});
const services = GuestGrants.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Patches.layer, Users.layer, Companies.layer)),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provideMerge(Fixtures.database)
);
it.layer(services)("Owner recovery", (it) => {
  it.effect(
    "an owner who can't open their patch sees it without content, and an admin manages it without opening it",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const users = yield* Users.Users;
        const t = yield* team("Recovery", [uploader.user.id, reader.user.id]);
        const input = Fixtures.recordInput(uploader, {
          audience: teamAudience([t.id]),
          description: "Inside the audience only"
        });
        yield* Fixtures.record(input);
        yield* (yield* Teams.Teams).setMemberships({
          ...viewer,
          teamId: t.id,
          remove: [uploader.user.id]
        });
        const managed = (userId: string) =>
          Effect.map(patches.read({ ...access(userId), managed: true }), (rows) =>
            rows.find((row) => row.patch.id === input.patchId)
          );

        // The owner sees they own it, and nothing of what is in it.
        const owner = yield* managed(uploader.user.id);
        assert.deepStrictEqual(owner?.access, {
          canOpen: false,
          canManage: false,
          ownerCanOpen: false
        });
        assert.strictEqual(owner?.patch.description, "");
        assert.equal(
          (yield* Effect.flip(patches.authorizePublish({ ...input, intent: "update" })))._tag,
          "OwnerAccessLost"
        );
        const card = yield* patches.portalCard(input.patchId, access(uploader.user.id));
        assert.deepStrictEqual(card.versions, []);

        // An admin manages it, but reaches nothing of its content and no agent lists it.
        const actor = { userId: admin.user.id, admin: true };
        const oversight = yield* managed(admin.user.id);
        assert.deepStrictEqual(oversight?.access, {
          canOpen: false,
          canManage: true,
          ownerCanOpen: false
        });
        assert.strictEqual(oversight?.patch.description, "");
        assert.isFalse(
          (yield* patches.list(access(admin.user.id))).some((row) => row.patch.id === input.patchId)
        );
        assert.equal(
          (yield* Effect.flip(patches.setDescription(input.patchId, actor, "forbidden")))._tag,
          "PatchUnavailable"
        );
        // Choosing what everyone is served is content too.
        assert.equal(
          (yield* Effect.flip(patches.rollback(input.patchId, actor, 1)))._tag,
          "PatchUnavailable"
        );

        // Reassigning goes only to someone who can open it, and only by an admin.
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
        assert.deepEqual(
          (yield* patches.eligibleOwners(input.patchId, actor)).map((person) => person.id),
          [reader.user.id]
        );
        yield* patches.reassign(input.patchId, actor, reader.user.id, uploader.user.id);
        assert.equal(
          (yield* Effect.flip(
            patches.reassign(input.patchId, actor, reader.user.id, uploader.user.id)
          ))._tag,
          "StaleAction"
        );
        assert.isTrue((yield* managed(admin.user.id))?.access.ownerCanOpen);
        yield* patches.retire(input.patchId, actor);
        yield* patches.restore(input.patchId, actor);

        // An admin owner keeps managing a patch they can't open; a member owner doesn't.
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "admin" });
        yield* (yield* Teams.Teams).setMemberships({
          ...viewer,
          teamId: t.id,
          remove: [reader.user.id]
        });
        yield* patches.manage(input.patchId, { userId: reader.user.id, admin: true });
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "member" });
        assert.equal(
          (yield* Effect.flip(
            patches.manage(input.patchId, { userId: reader.user.id, admin: false })
          ))._tag,
          "OwnerAccessLost"
        );
      })
  );

  it.effect(
    "tells the owner of audience changes others made and of admins added to its teams, and keeps them",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const users = yield* Users.Users;
        const teams = yield* Teams.Teams;
        const own = yield* team("History owner", [uploader.user.id]);
        const other = yield* team("History other", []);
        const input = Fixtures.recordInput(uploader, { audience: teamAudience([own.id]) });
        yield* Fixtures.record(input);
        const owner = { userId: uploader.user.id, admin: false };
        const byAdmin = { userId: admin.user.id, admin: true };
        const history = (userId: string) =>
          patches.ownerHistory(input.patchId, { companyId: viewer.companyId, userId });
        const seen = (userId: string) =>
          Effect.map(history(userId), (entries) =>
            entries.map((entry) =>
              entry.kind === "audience"
                ? [entry.actorId, entry.before.kind, entry.after.kind]
                : [entry.actorId, entry.userId, entry.teamName]
            )
          );
        const join = (teamId: string, userId: string) =>
          teams.setMemberships({ ...viewer, teamId, add: [userId] });

        // The owner's own change, and a member added to the team, are no news to the owner; nor
        // is that member becoming an admin later.
        yield* patches.setSharing({
          patchId: input.patchId,
          actor: owner,
          audience: teamAudience([own.id, other.id])
        });
        yield* join(other.id, reader.user.id);
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "admin" });
        assert.deepStrictEqual(yield* history(uploader.user.id), []);

        // An admin added to one of its teams by another admin, and an admin widening it to
        // Company. An admin added to a team it doesn't name then is no news.
        yield* join(own.id, reader.user.id);
        yield* patches.setSharing({
          patchId: input.patchId,
          actor: byAdmin,
          audience: { kind: "company" }
        });
        yield* join(other.id, admin.user.id);
        // Neither the demotion nor the widening takes back what the owner was told.
        yield* users.setRole({ ...viewer, userId: reader.user.id, role: "member" });
        const kept = [
          [admin.user.id, "teams", "company"],
          [admin.user.id, reader.user.id, own.name]
        ];
        // Audience changes and team changes keep their own clocks, so only their sets compare.
        assert.sameDeepMembers(yield* seen(uploader.user.id), kept);
        yield* patches.setSharing({
          patchId: input.patchId,
          actor: byAdmin,
          audience: teamAudience([other.id, own.id])
        });
        assert.sameDeepMembers(yield* seen(uploader.user.id), [
          ...kept,
          [admin.user.id, "company", "teams"]
        ]);
        const widened = (yield* history(uploader.user.id)).find(
          (entry) => entry.kind === "audience" && entry.after.kind === "company"
        );
        assert.deepStrictEqual(widened?.kind === "audience" ? widened.before : undefined, {
          kind: "teams",
          teams: [other, own].map(({ id, name }) => ({ id, name }))
        });
        // Admins read it too; other members don't.
        assert.lengthOf(yield* history(admin.user.id), 3);
        assert.equal((yield* Effect.flip(history(reader.user.id)))._tag, "PatchUnavailable");
      })
  );
});
