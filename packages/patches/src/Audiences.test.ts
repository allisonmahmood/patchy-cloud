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
it.layer(services)("Patch audiences", (it) => {
  it.effect(
    "requires an explicit first audience and refuses activation before downstream enforcement",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const input = Fixtures.recordInput(uploader, { scope: undefined });
        assert.equal((yield* Effect.flip(patches.preflight(input)))._tag, "InvalidAudience");
        const t = yield* team("Barrier", [uploader.user.id]);
        const error = yield* Effect.flip(
          patches
            .preflight({ ...input, audience: teamAudience([t.id]) })
            .pipe(Effect.provideService(Audiences.Activation, false))
        );
        assert.equal(error._tag, "InvalidAudience");
        assert.equal(
          (yield* patches.list(access(uploader.user.id))).some(
            (row) => row.patch.id === input.patchId
          ),
          false
        );
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
        assert.isTrue(yield* Audiences.references(viewer.companyId, design.id));
        yield* Teams.setMemberships({
          ...viewer,
          teamId: engineering.id,
          userIds: [reader.user.id],
          added: false
        });
        assert.isFalse(yield* Audiences.canOpen(input.patchId, viewer.companyId, reader.user.id));
        yield* Teams.setMemberships({
          ...viewer,
          teamId: engineering.id,
          userIds: [reader.user.id],
          added: true
        });
        assert.isTrue(yield* Audiences.canOpen(input.patchId, viewer.companyId, reader.user.id));
        yield* Teams.rename({ ...viewer, teamId: design.id, name: "Renamed design union" });
        assert.isTrue(yield* Audiences.references(viewer.companyId, design.id));
        for (const t of [design, engineering])
          yield* Teams.setMemberships({
            ...viewer,
            teamId: t.id,
            userIds: [uploader.user.id],
            added: false
          });
        assert.isFalse(yield* Audiences.canOpen(input.patchId, viewer.companyId, uploader.user.id));
        assert.equal(
          (yield* Effect.flip(patches.authorizePublish({ ...input, intent: "update" })))._tag,
          "PatchUnavailable"
        );
        assert.equal(
          (yield* Effect.flip(
            patches.manage(input.patchId, { userId: admin.user.id, admin: true })
          ))._tag,
          "PatchUnavailable"
        );
      }).pipe(Effect.provideService(Audiences.Activation, true))
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
              patches.setScope(input.patchId, actor, "company", undefined, teamAudience(ids))
            ))._tag,
            "InvalidAudience"
          );
        }
        const [found] = yield* patches.list({
          ...access(uploader.user.id),
          patchRef: input.patchId
        });
        assert.deepStrictEqual(found!.patch.audience, input.audience);
        assert.isTrue(yield* Audiences.references(viewer.companyId, own.id));
        assert.isFalse(yield* Audiences.references(viewer.companyId, other.id));
      }).pipe(Effect.provideService(Audiences.Activation, true))
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
              .setScope(
                input.patchId,
                { userId: uploader.user.id, admin: false },
                "company",
                undefined,
                Audiences.company()
              )
              .pipe(Effect.andThen(Effect.fail("abort")))
          )
          .pipe(Effect.catch(() => Effect.void));
        const [found] = yield* patches.list({
          ...access(uploader.user.id),
          patchRef: input.patchId
        });
        assert.deepStrictEqual(found!.patch.audience, input.audience);
        assert.isTrue(yield* Audiences.references(viewer.companyId, t.id));
      }).pipe(Effect.provideService(Audiences.Activation, true))
  );
  it.effect(
    "all company guests includes future guests, supports exclusions and preserves named grants independently",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const grants = yield* GuestGrants.GuestGrants;
        const companies = yield* Companies.Companies;
        const gina = yield* companies.create({
          handle: "audience-gina",
          name: "Gina Co",
          clerkUserId: "audience-gina",
          email: "gina@audience.example",
          userName: "Gina"
        });
        const riley = yield* companies.create({
          handle: "audience-riley",
          name: "Riley Co",
          clerkUserId: "audience-riley",
          email: "riley@audience.example",
          userName: "Riley"
        });
        const actor = { userId: uploader.user.id, admin: false };
        const { patchId } = yield* Fixtures.record(Fixtures.recordInput(uploader));
        const all: PatchAudience = {
          members: { kind: "company" },
          guests: { kind: "all", excludedUserIds: [] }
        };
        yield* patches.setScope(patchId, actor, "company", undefined, all);
        assert.isFalse((yield* grants.sharedWith(gina.user.id)).some((p) => p.patchId === patchId));
        const invitation = yield* Fixtures.record(Fixtures.recordInput(uploader));
        yield* grants.share({ patchId: invitation.patchId, actor, email: "gina@audience.example" });
        assert.isTrue((yield* grants.sharedWith(gina.user.id)).some((p) => p.patchId === patchId));
        yield* grants.remove({ patchId, actor, guest: gina.user.id });
        assert.isFalse((yield* grants.sharedWith(gina.user.id)).some((p) => p.patchId === patchId));
        assert.isTrue(
          (yield* grants.sharedWith(gina.user.id)).some((p) => p.patchId === invitation.patchId)
        );
        yield* grants.share({
          patchId: invitation.patchId,
          actor,
          email: "riley@audience.example"
        });
        assert.isTrue((yield* grants.sharedWith(riley.user.id)).some((p) => p.patchId === patchId));
        yield* grants.share({ patchId, actor, email: "gina@audience.example" });
        const loaded = yield* patches.find(patchId);
        assert.isTrue(Option.isSome(loaded));
        const bound = Option.getOrThrow(loaded);
        assert.isTrue(
          Option.isSome(
            yield* grants.host({
              patchId,
              userId: gina.user.id,
              state: "live",
              current: true,
              version: bound.version
            })
          )
        );
        assert.isTrue(
          (yield* grants.holders({ companyId: viewer.companyId, patchId }, [gina.user.id])).get(
            gina.user.id
          )
        );
        yield* grants.revokeAll({ companyId: viewer.companyId, userId: gina.user.id });
        assert.isFalse((yield* grants.sharedWith(gina.user.id)).some((p) => p.patchId === patchId));
      }).pipe(Effect.provideService(Audiences.Activation, true))
  );
});
