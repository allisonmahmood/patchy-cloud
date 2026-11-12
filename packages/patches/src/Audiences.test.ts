import { assert, it } from "@effect/vitest";
import { CompanyDatabases } from "@patchy/company-database";
import * as LoadedVersions from "./LoadedVersions.js";
import { MAX_AUDIENCE_TEAMS, sharedTableId } from "@patchy/api";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Analytics } from "@patchy/analytics";
import { Companies, Teams, Users } from "@patchy/companies";
import { RuntimeLog } from "@patchy/runtime";
import type { PatchAudience } from "@patchy/api";
import * as ConnectionVisibility from "./ConnectionVisibility.js";
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
// Runs `effect` in a transaction left open, holding its locks, until `release` commits it.
// `waiter` waits until another session waits on one of those locks.
const held = Effect.fn("held")(function* <A, E>(effect: Effect.Effect<A, E>) {
  const sql = yield* SqlClient.SqlClient;
  const ran = yield* Deferred.make<number>();
  const commit = yield* Deferred.make<void>();
  const fiber = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const result = yield* effect;
        const [session] = yield* sql<{ readonly pid: number }>`SELECT pg_backend_pid() AS pid`;
        if (session !== undefined) yield* Deferred.succeed(ran, session.pid);
        yield* Deferred.await(commit);
        return result;
      })
    )
    .pipe(Effect.forkScoped);
  const holder = yield* Deferred.await(ran);
  return {
    waiter: sql`SELECT pid FROM pg_stat_activity WHERE ${holder} = ANY(pg_blocking_pids(pid))`.pipe(
      Effect.repeat({ until: (rows) => rows.length > 0 })
    ),
    release: Deferred.succeed(commit, undefined).pipe(Effect.andThen(Fiber.join(fiber)))
  };
});
const DAY = 24 * 60 * 60 * 1_000;
const services = GuestGrants.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Patches.layer, Users.layer, Companies.layer)),
  Layer.provideMerge(Analytics.layerNoop),
  Layer.provideMerge(Fixtures.database)
);
it.layer(services)("Patch audiences", (it) => {
  it.effect("rechecks source access and membership restoration through the Runtime port", () =>
    Effect.gen(function* () {
      const selected = yield* team("Shared source design", [uploader.user.id, reader.user.id]);
      yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(viewer.companyId);
      const input = Fixtures.recordInput(uploader, {
        audience: teamAudience([selected.id]),
        manifest: {
          ...Fixtures.manifest,
          tier: 1,
          tables: {
            notes: { description: "Restricted columns", columns: {}, indexes: {}, shared: true }
          },
          files: { assets: { description: "Restricted files", shared: true } },
          uses: {}
        }
      });
      yield* Fixtures.record(input);
      const versions = yield* LoadedVersions.make;
      const patches = yield* Patches.Patches;
      yield* patches.sharedTable(input.patchId, "notes", viewer.companyId, reader.user.id);
      yield* patches.sharedStore(input.patchId, "assets", viewer.companyId, reader.user.id);
      const member = { companyId: viewer.companyId, userId: reader.user.id };
      assert.isTrue(Option.isSome(yield* versions.findForViewer(input.patchId, member)));
      yield* (yield* Teams.Teams).setMemberships({
        ...viewer,
        teamId: selected.id,
        remove: [reader.user.id]
      });
      assert.isTrue(Option.isNone(yield* versions.findForViewer(input.patchId, member)));
      assert.equal(
        (yield* patches
          .sharedTable(input.patchId, "notes", viewer.companyId, reader.user.id)
          .pipe(Effect.flip))._tag,
        "PatchNotOpenable"
      );
      assert.equal(
        (yield* patches
          .sharedStore(input.patchId, "assets", viewer.companyId, reader.user.id)
          .pipe(Effect.flip))._tag,
        "PatchNotOpenable"
      );
      assert.isTrue(
        Option.isSome(
          yield* versions.findForViewer(input.patchId, { ...member, userId: uploader.user.id })
        )
      );
      yield* (yield* Teams.Teams).setMemberships({
        ...viewer,
        teamId: selected.id,
        add: [reader.user.id]
      });
      assert.isTrue(Option.isSome(yield* versions.findForViewer(input.patchId, member)));
    })
  );

  it.effect(
    "refuses only a narrowing that leaves dependants without readers, naming the ones the actor can open",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(viewer.companyId);
        const source = Fixtures.recordInput(uploader, {
          manifest: {
            ...Fixtures.manifest,
            tier: 1,
            tables: { notes: { description: "Notes", columns: {}, indexes: {}, shared: true } },
            files: {},
            uses: {}
          }
        });
        yield* Fixtures.record(source);
        const manifest = {
          ...Fixtures.manifest,
          tier: 2,
          tables: {},
          files: {},
          uses: {
            notes: {
              kind: "sharedTable",
              patchId: source.patchId,
              table: "notes",
              id: sharedTableId(source.patchId, "notes"),
              revision: 1
            }
          }
        } as const;
        const own = Fixtures.recordInput(uploader, { manifest });
        const restricted = yield* team("Private consumer", [reader.user.id]);
        const other = Fixtures.recordInput(reader, {
          manifest,
          audience: teamAudience([restricted.id])
        });
        yield* Fixtures.record(own);
        yield* Fixtures.record(other);
        const owner = { userId: uploader.user.id, admin: false };

        // Retiring names the dependant the owner can open and counts the one they can't.
        const retiring = yield* patches.retire(source.patchId, owner).pipe(Effect.flip);
        assert.equal(retiring._tag, "HasDependants");
        if (retiring._tag === "HasDependants") {
          assert.deepStrictEqual(
            retiring.dependants.map((d) => d.patchId),
            [own.patchId]
          );
          assert.equal(retiring.hiddenCount, 1);
        }
        // Narrowing refuses the same way until forced; widening back never asks.
        const narrow = yield* team("Source narrowing", [uploader.user.id]);
        const sharing = (audience: PatchAudience, force?: boolean) =>
          patches.setSharing({ patchId: source.patchId, actor: owner, audience, force });
        const narrowing = yield* sharing(teamAudience([narrow.id])).pipe(Effect.flip);
        assert.equal(narrowing._tag, "HasDependants");
        if (narrowing._tag === "HasDependants") assert.equal(narrowing.hiddenCount, 1);
        // A publish narrowing it asks the same, before upload and again under the lock.
        const update = Fixtures.recordInput(uploader, {
          intent: "update",
          patchId: source.patchId,
          manifest: source.manifest,
          audience: teamAudience([narrow.id])
        });
        assert.equal((yield* Effect.flip(patches.preflight(update)))._tag, "HasDependants");
        assert.equal((yield* Effect.flip(Fixtures.record(update)))._tag, "HasDependants");
        yield* sharing(teamAudience([narrow.id]), true);
        yield* sharing({ kind: "company" });
      })
  );

  it.effect("defaults omitted first-publish audiences to Company", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const input = Fixtures.recordInput(uploader, { audience: undefined });
      yield* patches.preflight(input);
      const created = yield* Fixtures.record(input);
      assert.deepStrictEqual(created.audience, { kind: "company" });
      assert.equal(created.scope, "company");
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
        // Clients released before team audiences read `company`; the audience names the teams.
        assert.equal(published.scope, "company");
        assert.deepStrictEqual(published.audience, {
          kind: "teams",
          teams: [design, engineering].map(({ id, name }) => ({ id, name }))
        });
        assert.isTrue(
          (yield* patches.list(access(reader.user.id))).some(
            (row) => row.patch.id === input.patchId
          )
        );
        assert.isFalse(
          (yield* patches.list(access(admin.user.id))).some((row) => row.patch.id === input.patchId)
        );
        yield* (yield* Teams.Teams).setMemberships({
          ...viewer,
          teamId: engineering.id,
          remove: [reader.user.id]
        });
        assert.isFalse(
          yield* patches.admitsMember(input.patchId, viewer.companyId, reader.user.id)
        );
        yield* (yield* Teams.Teams).setMemberships({
          ...viewer,
          teamId: engineering.id,
          add: [reader.user.id]
        });
        assert.isTrue(yield* patches.admitsMember(input.patchId, viewer.companyId, reader.user.id));
        yield* (yield* Teams.Teams).rename({
          ...viewer,
          teamId: design.id,
          name: "Renamed design union"
        });
        for (const t of [design, engineering])
          yield* (yield* Teams.Teams).setMemberships({
            ...viewer,
            teamId: t.id,
            remove: [uploader.user.id]
          });
        assert.isFalse(
          yield* patches.admitsMember(input.patchId, viewer.companyId, uploader.user.id)
        );
        assert.equal(
          (yield* Effect.flip(patches.authorizePublish({ ...input, intent: "update" })))._tag,
          "OwnerAccessLost"
        );
        assert.equal(
          (yield* patches.manage(input.patchId, { userId: admin.user.id, admin: true })).id,
          input.patchId
        );
        assert.isFalse(
          (yield* patches.list(access(admin.user.id))).some((row) => row.patch.id === input.patchId)
        );
      })
  );
  it.effect(
    "refuses a scope alone for a patch open to teams, and keeps the audience when none is sent",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const t = yield* team("Upgrade required", [uploader.user.id]);
        const input = Fixtures.recordInput(uploader, { audience: teamAudience([t.id]) });
        yield* Fixtures.record(input);
        const owner = { userId: uploader.user.id, admin: false };
        const update = (overrides: Partial<Patches.RecordInput>) =>
          Fixtures.recordInput(uploader, {
            intent: "update",
            patchId: input.patchId,
            ...overrides
          });
        const stored = Effect.map(
          patches.list({ ...access(uploader.user.id), patchRef: input.patchId }),
          ([found]) => found?.patch.audience
        );
        // What an earlier CLI sends for `share company` or `publish --share company`.
        for (const scopeOnly of [
          patches.setSharing({
            patchId: input.patchId,
            actor: owner,
            audience: { kind: "company" },
            scopeOnly: true
          }),
          patches.preflight(update({ audience: { kind: "company" }, scopeOnly: true })),
          Fixtures.record(update({ audience: { kind: "public" }, scopeOnly: true }))
        ])
          assert.equal((yield* Effect.flip(scopeOnly))._tag, "UpgradeRequired");
        assert.deepStrictEqual(yield* stored, input.audience);
        // A republish without one keeps it; the whole audience widens it.
        yield* Fixtures.record(update({ audience: undefined }));
        assert.deepStrictEqual(yield* stored, input.audience);
        const widened = yield* patches.setSharing({
          patchId: input.patchId,
          actor: owner,
          audience: { kind: "company" }
        });
        assert.deepStrictEqual(widened.audience, { kind: "company" });
        // A scope alone still moves a patch that isn't open to teams.
        yield* patches.setSharing({
          patchId: input.patchId,
          actor: owner,
          audience: { kind: "public" },
          scopeOnly: true
        });
        assert.deepStrictEqual(yield* stored, { kind: "public" });
      })
  );
  it.effect(
    "shows a connection's calls from a patch only to people who can open it, and to nobody once it is reclaimed",
    () =>
      Effect.gen(function* () {
        const visibility = yield* ConnectionVisibility.make;
        const log = yield* RuntimeLog.RuntimeLog;
        const patches = yield* Patches.Patches;
        const finance = yield* team("Visibility finance", [uploader.user.id]);
        const restricted = Fixtures.recordInput(uploader, { audience: teamAudience([finance.id]) });
        const open = Fixtures.recordInput(uploader);
        yield* Fixtures.record(restricted);
        yield* Fixtures.record(open);
        const connectionId = "visibility-calls";
        for (const [correlationId, from] of [
          ["restricted-call", restricted],
          ["open-call", open],
          ["admin-call", null]
        ] as const)
          yield* log.begin({
            companyId: viewer.companyId,
            userId: uploader.user.id,
            credentialKind: from === null ? "admin" : "session",
            patchId: from?.patchId ?? null,
            versionId: from?.versionId ?? null,
            op: "postgres.query",
            resource: null,
            connectionId,
            correlationId,
            sql: "SELECT 'ledger'"
          });
        const shown = (userId: string) =>
          Effect.gen(function* () {
            const patchIds = yield* visibility.openableIds(viewer.companyId, userId);
            const calls = yield* log.recent({
              companyId: viewer.companyId,
              connectionId,
              patchIds
            });
            return calls.map((call) => call.correlationId).sort();
          });
        assert.deepStrictEqual(yield* shown(admin.user.id), ["admin-call", "open-call"]);
        assert.deepStrictEqual(yield* shown(reader.user.id), ["admin-call", "open-call"]);
        assert.deepStrictEqual(yield* shown(uploader.user.id), [
          "admin-call",
          "open-call",
          "restricted-call"
        ]);
        // Reclamation keeps the patch's calls but drops its row and audience: they stay hidden.
        yield* patches.delete(restricted.patchId, { userId: uploader.user.id, admin: false });
        yield* TestClock.adjust(30 * DAY);
        assert.isTrue(Option.isSome(yield* patches.purgeDeleted(restricted.patchId)));
        assert.deepStrictEqual(yield* shown(admin.user.id), ["admin-call", "open-call"]);
        assert.deepStrictEqual(yield* shown(uploader.user.id), ["admin-call", "open-call"]);
      })
  );
  it.effect(
    "warns when its audience reaches people its shared source or a team-only connection doesn't",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(viewer.companyId);
        const finance = yield* team("Reach finance", [uploader.user.id]);
        const source = Fixtures.recordInput(uploader, {
          audience: teamAudience([finance.id]),
          manifest: {
            ...Fixtures.manifest,
            tier: 1,
            tables: { ledger: { description: "Ledger", columns: {}, indexes: {}, shared: true } },
            files: {},
            uses: {}
          }
        });
        yield* Fixtures.record(source);
        const reads = {
          ...Fixtures.manifest,
          tier: 2,
          tables: {},
          files: {},
          uses: {
            ledger: {
              kind: "sharedTable",
              patchId: source.patchId,
              table: "ledger",
              id: sharedTableId(source.patchId, "ledger"),
              revision: 1
            }
          }
        } as const;
        const consumer = Fixtures.recordInput(uploader, { manifest: reads });
        const published = yield* Fixtures.record(consumer);
        assert.isTrue(published.warnings.some((line) => line.includes("can't open")));
        const viewing = { companyId: viewer.companyId, userId: uploader.user.id };
        assert.lengthOf(yield* patches.reach(consumer.patchId, viewing), 1);
        const narrowed = yield* patches.setSharing({
          patchId: consumer.patchId,
          actor: { userId: uploader.user.id, admin: false },
          audience: teamAudience([finance.id])
        });
        assert.deepStrictEqual(narrowed.warnings, []);
        assert.deepStrictEqual(
          yield* patches.reach(consumer.patchId, { ...viewing, userId: reader.user.id }),
          []
        );
      })
  );
  it.effect(
    "lets an owner name any team that keeps them in, and refuses unknown, too many or owner-excluding teams unchanged",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const own = yield* team("Owner included", [uploader.user.id]);
        const other = yield* team("Owner excluded", [reader.user.id]);
        const input = Fixtures.recordInput(uploader, { audience: teamAudience([own.id]) });
        yield* Fixtures.record(input);
        const actor = { userId: uploader.user.id, admin: false };
        const share = (ids: readonly string[]) =>
          patches.setSharing({ patchId: input.patchId, actor, audience: teamAudience(ids) });
        // Real teams, so only the cap refuses them: one past it, with the owner's team.
        const tooMany = Array.from(
          { length: MAX_AUDIENCE_TEAMS },
          (_, i) => `team_audience_cap_${i}`
        );
        yield* (yield* SqlClient.SqlClient)`INSERT INTO company_teams(id, company_id, name)
          SELECT id, ${viewer.companyId}, id FROM unnest(${tooMany}::text[]) id`;
        for (const [ids, refusal] of [
          [["unknown-team"], "InvalidAudienceTeams"],
          [[own.id, ...tooMany], "InvalidAudienceTeams"],
          [[other.id], "AudienceExcludesOwner"]
        ] as const)
          assert.equal((yield* Effect.flip(share(ids)))._tag, refusal);
        const [found] = yield* patches.list({
          ...access(uploader.user.id),
          patchRef: input.patchId
        });
        assert.deepStrictEqual(found!.patch.audience, input.audience);
        // A member owner may name a team they aren't on, as long as one chosen team admits them.
        const widened = yield* share([own.id, other.id]);
        assert.deepStrictEqual(widened.patch.audience, teamAudience([own.id, other.id].sort()));
      })
  );
  it.effect("a team deletion and a share adding that team never both succeed", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const teams = yield* Teams.Teams;
      const own = yield* team("Race owner team", [uploader.user.id]);
      const input = Fixtures.recordInput(uploader, { audience: teamAudience([own.id]) });
      yield* Fixtures.record(input);
      const actor = { userId: uploader.user.id, admin: false };
      const share = (t: Teams.Team) =>
        patches.setSharing({
          patchId: input.patchId,
          actor,
          audience: teamAudience([own.id, t.id])
        });
      const remove = (t: Teams.Team) => teams.remove({ ...viewer, teamId: t.id });
      // The stored audience comes back in team id order.
      const audience = Effect.map(
        patches.list({ ...access(uploader.user.id), patchRef: input.patchId }),
        ([found]) => found?.patch.audience
      );
      const sorted = (ids: readonly string[]) => teamAudience([...ids].sort());
      const exists = (t: Teams.Team) =>
        Effect.map(teams.list(viewer), (all) => all.some((found) => found.id === t.id));

      // The share commits first; the deletion waited on it, and the foreign key refuses it.
      const kept = yield* team("Race shared first", []);
      const sharing = yield* held(share(kept));
      const refused = yield* remove(kept).pipe(Effect.flip, Effect.forkScoped);
      yield* sharing.waiter;
      yield* sharing.release;
      assert.strictEqual((yield* Fiber.join(refused))._tag, "TeamInUse");
      assert.deepStrictEqual(yield* audience, sorted([own.id, kept.id]));
      assert.isTrue(yield* exists(kept));

      // The deletion commits first; the share waited on it, and finds the team gone.
      const gone = yield* team("Race deleted first", []);
      const removing = yield* held(remove(gone));
      const late = yield* share(gone).pipe(Effect.flip, Effect.forkScoped);
      yield* removing.waiter;
      yield* removing.release;
      assert.strictEqual((yield* Fiber.join(late))._tag, "InvalidAudienceTeams");
      assert.deepStrictEqual(yield* audience, sorted([own.id, kept.id]));
      assert.isFalse(yield* exists(gone));
    }).pipe(Effect.scoped)
  );
  it.effect(
    "refuses deleting a team that retired or deleted patches name until their sharing drops it",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const teams = yield* Teams.Teams;
        const own = yield* team("Lifecycle owner team", [uploader.user.id]);
        const used = yield* team("Lifecycle used team", []);
        const owner = { userId: uploader.user.id, admin: false };
        const audience = teamAudience([own.id, used.id]);
        const retired = Fixtures.recordInput(uploader, { audience });
        const deleted = Fixtures.recordInput(uploader, { audience });
        yield* Fixtures.record(retired);
        yield* Fixtures.record(deleted);
        yield* patches.retire(retired.patchId, owner);
        yield* patches.delete(deleted.patchId, owner);
        const removal = teams.remove({ ...viewer, teamId: used.id });
        const narrow = (patchId: string) =>
          patches.setSharing({ patchId, actor: owner, audience: teamAudience([own.id]) });
        assert.strictEqual((yield* Effect.flip(removal))._tag, "TeamInUse");
        yield* narrow(retired.patchId);
        assert.strictEqual((yield* Effect.flip(removal))._tag, "TeamInUse");
        yield* narrow(deleted.patchId);
        yield* removal;
        const states = yield* patches.list({ ...access(uploader.user.id), state: "all" });
        assert.deepStrictEqual(
          [retired.patchId, deleted.patchId].map(
            (id) => states.find((row) => row.patch.id === id)?.patch.state
          ),
          ["retired", "deleted"]
        );
        // Past its recovery window a deleted patch takes no more changes.
        yield* TestClock.adjust(30 * DAY);
        assert.strictEqual((yield* Effect.flip(narrow(deleted.patchId)))._tag, "PatchUnavailable");
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
        yield* Fixtures.record(
          Fixtures.recordInput(uploader, {
            intent: "update",
            patchId: input.patchId,
            audience: undefined
          })
        );
        yield* patches.rollback(input.patchId, { userId: uploader.user.id, admin: false }, 1);
        const aborted = yield* sql
          .withTransaction(
            patches
              .setSharing({
                patchId: input.patchId,
                actor: { userId: uploader.user.id, admin: false },
                audience: { kind: "company" }
              })
              .pipe(Effect.andThen(Effect.fail("abort" as const)))
          )
          .pipe(Effect.flip);
        assert.strictEqual(aborted, "abort");
        const [found] = yield* patches.list({
          ...access(uploader.user.id),
          patchRef: input.patchId
        });
        assert.deepStrictEqual(found!.patch.audience, input.audience);
      })
  );
  it.effect(
    "keeps named guests through team edits and lets them find it, shows guests' patches as the viewer may see them, and lets an admin repair a deactivated owner's",
    () =>
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
        const input = Fixtures.recordInput(uploader, { title: "Team ledger" });
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
        // The guest still finds the team patch on Home and in the switcher, and its next publish
        // still checks its guests.
        assert.deepStrictEqual(
          (yield* grants.sharedWith(outside.user.id)).map((shared) => [
            shared.patchId,
            shared.scope
          ]),
          [[input.patchId, "teams"]]
        );
        assert.isTrue(
          Option.isNone(
            yield* grants.unavailableAfterPublish({
              patchId: input.patchId,
              companyId: viewer.companyId,
              scope: undefined,
              version: { tier: 1, manifest: Fixtures.manifest }
            })
          )
        );
        // A member outside its audience doesn't learn of it from People; an admin sees its title.
        const guestOf = (viewerId: string) =>
          Effect.map(grants.companyGuests(viewer.companyId, viewerId), (guests) =>
            guests.find((g) => g.userId === outside.user.id)
          );
        assert.isUndefined(yield* guestOf(reader.user.id));
        assert.deepStrictEqual(
          (yield* guestOf(admin.user.id))?.patches.map((p) => p.title),
          ["Team ledger"]
        );
        yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${uploader.user.id}`;
        const adminActor = { userId: admin.user.id, admin: true };
        const repaired = yield* patches.setSharing({
          patchId: input.patchId,
          actor: adminActor,
          audience: { kind: "company" }
        });
        assert.deepStrictEqual(repaired.audience, { kind: "company" });
        yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = ${uploader.user.id}`;
        // Removing a guest from every patch records the admin who did it, not the guest.
        yield* grants.revokeAll({
          companyId: viewer.companyId,
          userId: outside.user.id,
          actorId: admin.user.id
        });
        assert.deepStrictEqual(
          yield* sql`SELECT last_changed_by FROM patches WHERE id = ${input.patchId}`,
          [{ last_changed_by: admin.user.id }]
        );
        assert.lengthOf(yield* grants.guests(input.patchId), 0);
      })
  );
  it.effect("removing a guest everywhere waits for the patch before touching its grant", () =>
    Effect.gen(function* () {
      const grants = yield* GuestGrants.GuestGrants;
      const sql = yield* SqlClient.SqlClient;
      const outside = yield* (yield* Companies.Companies).create({
        handle: "lock-order-guest",
        name: "Elsewhere",
        clerkUserId: "lock-order-guest",
        email: "guest@elsewhere.example",
        userName: "Lock guest"
      });
      const input = Fixtures.recordInput(uploader);
      yield* Fixtures.record(input);
      yield* grants.share({
        patchId: input.patchId,
        actor: { userId: uploader.user.id, admin: false },
        email: outside.user.email
      });
      // Sharing holds the patch, then takes its grant. Removal must queue behind the patch
      // without holding the grant, or the two deadlock.
      const sharing = yield* held(
        sql`SELECT id FROM patches WHERE id = ${input.patchId} FOR UPDATE`
      );
      const removing = yield* grants
        .revokeAll({ companyId: viewer.companyId, userId: outside.user.id, actorId: admin.user.id })
        .pipe(Effect.forkScoped);
      yield* sharing.waiter;
      const grant = yield* sql
        .withTransaction(
          sql`SELECT patch_id FROM patch_guest_grants
            WHERE patch_id = ${input.patchId} AND user_id = ${outside.user.id} FOR UPDATE NOWAIT`
        )
        .pipe(Effect.result);
      assert.isTrue(grant._tag === "Success");
      yield* sharing.release;
      yield* Fiber.join(removing);
      assert.lengthOf(yield* grants.guests(input.patchId), 0);
    }).pipe(Effect.scoped)
  );
  it.effect(
    "adding an admin to a patch's team races removing its guest or reclaiming it without a deadlock",
    () =>
      Effect.gen(function* () {
        const grants = yield* GuestGrants.GuestGrants;
        const teams = yield* Teams.Teams;
        const patches = yield* Patches.Patches;
        const sql = yield* SqlClient.SqlClient;
        const owner = { userId: uploader.user.id, admin: false };
        const blocked = (count: number) =>
          sql<{ readonly waiting: number }>`SELECT count(*)::int AS waiting
            FROM pg_stat_activity
            WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`.pipe(
            Effect.repeat({ until: ([row]) => (row?.waiting ?? 0) >= count })
          );
        const additions = (patchId: string) =>
          sql<{ readonly userId: string }>`SELECT user_id AS "userId"
            FROM patch_admin_additions WHERE patch_id = ${patchId}`;
        const removals = [
          {
            kind: "guest removal",
            handle: "race-revoke",
            remove: (patchId: string, guestId: string) =>
              Effect.asVoid(grants.revoke({ patchId, userId: guestId, actorId: owner.userId }))
          },
          {
            kind: "reclamation",
            handle: "race-reclaim",
            remove: (patchId: string) => Effect.asVoid(patches.purgeDeleted(patchId))
          }
        ];
        for (const { kind, handle, remove } of removals) {
          const outside = yield* (yield* Companies.Companies).create({
            handle,
            name: "Elsewhere",
            clerkUserId: handle,
            email: `${handle}@elsewhere.example`,
            userName: "Race guest"
          });
          const finance = yield* team(`Race finance ${kind}`, [uploader.user.id]);
          const input = Fixtures.recordInput(uploader, { audience: teamAudience([finance.id]) });
          yield* Fixtures.record(input);
          yield* grants.share({ patchId: input.patchId, actor: owner, email: outside.user.email });
          if (kind === "reclamation") {
            yield* patches.delete(input.patchId, owner);
            yield* TestClock.adjust(30 * DAY);
          }
          // Both sides queue on the company's directory row: the team change first, holding the
          // company row, then the removal, holding the patch. The team change gets it and must
          // finish without waiting on the patch the removal holds.
          const directory = yield* held(
            sql`SELECT revision FROM companies_directory
              WHERE company_id = ${viewer.companyId} FOR UPDATE`
          );
          const adding = yield* teams
            .setMemberships({
              ...viewer,
              teamId: finance.id,
              add: [admin.user.id]
            })
            .pipe(Effect.forkScoped);
          yield* directory.waiter;
          const removing = yield* remove(input.patchId, outside.user.id).pipe(Effect.forkScoped);
          yield* blocked(2);
          yield* directory.release;
          assert.strictEqual(yield* Fiber.join(adding), 1, kind);
          yield* Fiber.join(removing);
          assert.include(yield* teams.members({ ...viewer, teamId: finance.id }), admin.user.id);
          if (kind === "reclamation") {
            assert.isTrue(Option.isNone(yield* patches.find(input.patchId)), kind);
            assert.lengthOf(yield* additions(input.patchId), 0, kind);
          } else {
            assert.lengthOf(yield* grants.guests(input.patchId), 0, kind);
            assert.deepStrictEqual(yield* additions(input.patchId), [{ userId: admin.user.id }]);
          }
        }
      }).pipe(Effect.scoped)
  );
});
