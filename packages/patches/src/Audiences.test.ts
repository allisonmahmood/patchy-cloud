import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
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
it.layer(services)("Patch audiences", (it) => {
  it.effect(
    "reuses authenticated patch facts and loads memberships only once for team audiences",
    () =>
      Effect.gen(function* () {
        const t = yield* team("Query budget", [uploader.user.id]);
        const queries: string[] = [];
        const trace: Statement.Transformer = (statement) => {
          queries.push(statement.compile()[0]);
          return Effect.succeed(statement);
        };
        yield* Effect.gen(function* () {
          const admitted = yield* Audiences.forAuthenticatedMember(
            viewer.companyId,
            uploader.user.id,
            [Audiences.company(), Audiences.company("public")]
          );
          assert.isTrue(admitted(Audiences.company()));
          assert.isTrue(admitted(Audiences.company("public")));
          assert.lengthOf(queries, 0);
          const selected = teamAudience([t.id]);
          const teamGrant = yield* Audiences.forAuthenticatedMember(
            viewer.companyId,
            uploader.user.id,
            [selected, selected]
          );
          assert.isTrue(teamGrant(selected));
          assert.isTrue(teamGrant(selected));
          assert.lengthOf(queries, 1);
          assert.include(queries[0]!, "company_team_members");
          queries.length = 0;
          assert.isTrue(
            yield* Audiences.canOpen(
              { companyId: viewer.companyId, audience: Audiences.company(), disabledAt: null },
              viewer.companyId,
              uploader.user.id
            )
          );
          assert.lengthOf(queries, 1);
          assert.include(queries[0]!, "FROM users");
          assert.notInclude(queries[0]!, "FROM patches");
        }).pipe(
          Effect.provideService(Statement.CurrentTransformer, trace),
          Effect.provideService(Audiences.Activation, true)
        );
      })
  );
  it.effect(
    "requires an explicit first audience and refuses activation before downstream enforcement",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const input = Fixtures.recordInput(uploader, { scope: undefined });
        assert.equal((yield* Effect.flip(patches.preflight(input)))._tag, "AudienceRequired");
        const t = yield* team("Barrier", [uploader.user.id]);
        const error = yield* Effect.flip(
          patches
            .preflight({ ...input, audience: teamAudience([t.id]) })
            .pipe(Effect.provideService(Audiences.Activation, false))
        );
        assert.equal(error._tag, "AudienceInactive");
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
        assert.isTrue(yield* Audiences.references(viewer.companyId, design.id));
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
        assert.isTrue(yield* Audiences.references(viewer.companyId, t.id));
      }).pipe(Effect.provideService(Audiences.Activation, true))
  );
  it.effect("keeps more than 100 guests readable and every company guest selectable", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const grants = yield* GuestGrants.GuestGrants;
      const sql = yield* SqlClient.SqlClient;
      const outside = yield* (yield* Companies.Companies).create({
        handle: "many-guests",
        name: "Outside",
        clerkUserId: "many-owner",
        email: "owner@many.example",
        userName: "Outside"
      });
      yield* sql`INSERT INTO users(id, clerk_user_id, company_id, email, name, role)
        SELECT 'many-guest-' || n, 'many-clerk-' || n, ${outside.company.id}, 'guest-' || n || '@many.example', 'Guest ' || n, 'member' FROM generate_series(1, 101) n`;
      yield* sql`INSERT INTO company_patch_guests(company_id, user_id, added_by)
        SELECT ${viewer.companyId}, 'many-guest-' || n, ${uploader.user.id} FROM generate_series(1, 100) n`;
      const selected = Array.from({ length: 100 }, (_, i) => `many-guest-${i + 1}`);
      const validationQueries: string[] = [];
      yield* Audiences.validate({
        companyId: viewer.companyId,
        actorId: uploader.user.id,
        ownerId: uploader.user.id,
        audience: { members: { kind: "company" }, guests: { kind: "specific", userIds: selected } }
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          validationQueries.push(statement.compile()[0]);
          return Effect.succeed(statement);
        })
      );
      assert.lengthOf(validationQueries, 2, "one actor/owner lookup and one batch of 100 guests");

      const input = Fixtures.recordInput(uploader, {
        audience: { members: { kind: "company" }, guests: { kind: "specific", userIds: selected } }
      });
      yield* Fixtures.record(input);
      yield* grants.share({
        patchId: input.patchId,
        actor: { userId: uploader.user.id, admin: false },
        email: "guest-101@many.example"
      });
      const loaded = Option.getOrThrow(yield* patches.find(input.patchId));
      assert.equal(loaded.patch.audience.guests.kind, "specific");
      assert.lengthOf(yield* grants.guests(input.patchId), 101);
      assert.isTrue(
        (yield* grants.sharedBefore(viewer.companyId)).some((p) => p.userId === selected[0])
      );
      assert.isAtLeast((yield* grants.sharedBefore(viewer.companyId)).length, 101);
      assert.isTrue(
        yield* Audiences.canOpen(
          Option.getOrThrow(yield* patches.find(input.patchId)).patch,
          viewer.companyId,
          uploader.user.id
        )
      );
      yield* grants.remove({
        patchId: input.patchId,
        actor: { userId: uploader.user.id, admin: false },
        guest: "many-guest-101"
      });
      assert.lengthOf(yield* grants.guests(input.patchId), 100);
    })
  );
  it.effect(
    "retains inactive guest grants through scope changes and keeps each patch's attribution",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const grants = yield* GuestGrants.GuestGrants;
        const sql = yield* SqlClient.SqlClient;
        const outside = yield* (yield* Companies.Companies).create({
          handle: "inactive-guest",
          name: "Outside",
          clerkUserId: "inactive-guest",
          email: "inactive@guests.example",
          userName: "Inactive"
        });
        const first = yield* Fixtures.record(Fixtures.recordInput(uploader));
        const second = yield* Fixtures.record(Fixtures.recordInput(reader));
        const actor = { userId: uploader.user.id, admin: false };
        yield* grants.share({ patchId: first.patchId, actor, email: outside.user.email });
        yield* grants.share({
          patchId: second.patchId,
          actor: { userId: reader.user.id, admin: false },
          email: outside.user.email
        });
        const listed = (yield* grants.companyGuests(viewer.companyId)).find(
          (g) => g.userId === outside.user.id
        )!;
        assert.equal(
          listed.patches.find((p) => p.name === second.name)?.sharedBy,
          reader.user.name
        );
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${outside.user.id}`;
        const shared = yield* patches.setSharing({
          patchId: first.patchId,
          actor: actor,
          scope: "public"
        });
        assert.deepStrictEqual(shared.audience.guests, {
          kind: "specific",
          userIds: [outside.user.id]
        });
        yield* patches.setSharing({
          patchId: first.patchId,
          actor: actor,
          audience: {
            ...shared.audience,
            members: { kind: "company" }
          }
        });
        yield* Fixtures.record(
          Fixtures.recordInput(uploader, {
            intent: "update",
            patchId: first.patchId,
            scope: "public"
          })
        );
        assert.lengthOf(yield* grants.guests(first.patchId), 1);
        assert.isFalse(
          (yield* grants.sharedWith(outside.user.id)).some((p) => p.patchId === first.patchId)
        );
        yield* grants.revokeAll({ companyId: viewer.companyId, userId: outside.user.id });
      })
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
        yield* patches.setSharing({ patchId: patchId, actor: actor, audience: all });
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
