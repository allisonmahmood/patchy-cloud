import { assert, it } from "@effect/vitest";
import { type Manifest, sharedTableId } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const { admin, sibling, uploader, reader } = Fixtures.identities;
const owner = { userId: uploader.user.id, admin: false };
const administrator = { userId: admin.user.id, admin: true };
let counter = 0;

const input = (overrides: Partial<Patches.RecordInput> = {}): Patches.RecordInput => {
  const ordinal = ++counter;
  const patchId = overrides.patchId ?? `p${String(ordinal).padStart(11, "0")}`;
  return {
    ...Fixtures.publishRecord(),
    intent: "create",
    patchId,
    companyId: uploader.company.id,
    ownerUserId: uploader.user.id,
    versionId: `ver_${patchId}_${ordinal}`,
    machineTokenId: uploader.machine.id,
    title: `Lifecycle ${ordinal}`,
    objectKey: `patches/${patchId}/versions/${ordinal}.html`,
    contentHash: `sha256:${ordinal}`,
    fileSize: 1,
    filename: null,
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    sourceIp: null,
    userAgent: null,
    ...overrides
  };
};
const create = Effect.fn("PatchesTest.create")(function* (
  overrides: Partial<Patches.RecordInput> = {}
) {
  const request = input(overrides);
  yield* (yield* Patches.Patches).preflight(request);
  return yield* Fixtures.record(request);
});
const update = (patchId: string, overrides: Partial<Patches.RecordInput> = {}) =>
  Fixtures.record(input({ intent: "update", patchId, ...overrides }));
const stored = Effect.fn("PatchesTest.stored")(function* (patchId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT * FROM patches WHERE id = ${patchId}`;
  return rows[0]!;
});
const tableManifest = (name: string, shared = true): typeof Manifest.Type => ({
  ...Fixtures.manifest,
  name,
  tier: 1,
  tables: {
    notes: {
      description: "Notes keyed by id.",
      columns: { body: { kind: "text" } },
      indexes: {},
      shared
    }
  }
});
const declaration = (patchId: string, revision = 1) => ({
  kind: "sharedTable" as const,
  patchId,
  table: "notes",
  id: sharedTableId(patchId, "notes"),
  revision
});

it.layer(Patches.layer.pipe(Layer.provideMerge(Fixtures.database)))("Patches", (it) => {
  const moves: ReadonlyArray<{
    name: string;
    allowed: readonly Patches.PatchState[];
    run: (
      service: Patches.Patches["Service"],
      patchId: string,
      actor: Patches.Actor
    ) => Effect.Effect<unknown, Patches.LifecycleError | Patches.AdminRequired | SqlError>;
  }> = [
    { name: "retire", allowed: ["live"], run: (service, id, actor) => service.retire(id, actor) },
    {
      name: "delete",
      allowed: ["live", "retired"],
      run: (service, id, actor) => service.delete(id, actor)
    },
    {
      name: "restore",
      allowed: ["retired", "deleted"],
      run: (service, id, actor) => service.restore(id, actor)
    },
    {
      name: "rollback",
      allowed: ["live"],
      run: (service, id, actor) => service.rollback(id, actor, 1)
    },
    {
      name: "scope",
      allowed: ["live"],
      run: (service, id, actor) => service.setScope(id, actor, "public")
    },
    {
      name: "description",
      allowed: ["live", "retired"],
      run: (service, id, actor) => service.setDescription(id, actor, "New description")
    },
    {
      name: "reassign",
      allowed: ["live", "retired", "deleted"],
      run: (service, id, actor) => service.reassign(id, actor, reader.user.id)
    }
  ];

  for (const actor of [owner, administrator]) {
    for (const state of ["live", "retired", "deleted"] as const) {
      it.effect(
        `applies every ${actor.admin ? "admin" : "owner"} move from ${state} atomically`,
        () =>
          Effect.gen(function* () {
            const service = yield* Patches.Patches;
            for (const move of moves) {
              const patch = yield* create();
              if (state === "retired") yield* service.retire(patch.patchId, owner);
              if (state === "deleted") yield* service.delete(patch.patchId, owner);
              const before = yield* stored(patch.patchId);
              yield* TestClock.adjust(1_000);
              if (move.name === "reassign" && !actor.admin) {
                const refused = yield* move.run(service, patch.patchId, actor).pipe(Effect.flip);
                assert.strictEqual(refused._tag, "AdminRequired");
                assert.deepStrictEqual(yield* stored(patch.patchId), before);
                continue;
              }
              if (!move.allowed.includes(state)) {
                const refused = yield* move.run(service, patch.patchId, actor).pipe(Effect.flip);
                assert.instanceOf(refused, Patches.WrongState);
                assert.strictEqual(refused.state, state);
                assert.deepStrictEqual(yield* stored(patch.patchId), before, move.name);
                continue;
              }
              yield* move.run(service, patch.patchId, actor);
              const after = yield* stored(patch.patchId);
              assert.strictEqual(after.last_changed_by, actor.userId, move.name);
              assert.deepStrictEqual(
                after.last_changed_at,
                DateTime.toDateUtc(yield* DateTime.now),
                move.name
              );
              if (move.name === "retire") assert.strictEqual(after.retired_by, actor.userId);
              if (move.name === "delete") {
                assert.strictEqual(after.deleted_by, actor.userId);
                assert.deepStrictEqual(after.retired_at, before.retired_at);
              }
              if (move.name === "restore") {
                assert.isNull(after.retired_at);
                assert.isNull(after.retired_by);
                assert.isNull(after.deleted_at);
                assert.isNull(after.deleted_by);
                assert.isTrue(Option.isSome(yield* service.find(patch.patchId)));
              }
              if (move.name === "description")
                assert.strictEqual(after.description_updated_by, actor.userId);
              if (move.name === "reassign") {
                assert.strictEqual(after.owner_user_id, reader.user.id);
                assert.strictEqual(after.reassigned_by, actor.userId);
              }
            }
          })
      );
    }
  }

  it.effect("checks company and ownership before every verb's state and validation", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO companies (id, handle, name) VALUES ('cmp_lifecycle_foreign', 'lifecycle-foreign', 'Foreign')`;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role)
        VALUES ('usr_lifecycle_foreign', 'clerk_lifecycle_foreign', 'cmp_lifecycle_foreign', 'foreign@patchy.local', 'Foreign', 'admin')`;
      const outsider = { userId: "usr_lifecycle_foreign", admin: true };
      for (const state of ["live", "retired", "deleted"] as const) {
        const patch = yield* create();
        if (state === "retired") yield* service.retire(patch.patchId, owner);
        if (state === "deleted") yield* service.delete(patch.patchId, owner);
        const before = yield* stored(patch.patchId);
        for (const move of moves) {
          const refused = yield* move
            .run(service, patch.patchId, { userId: reader.user.id, admin: false })
            .pipe(Effect.flip);
          assert.instanceOf(refused, Patches.NotOwner);
          assert.deepStrictEqual(refused.owner, { id: uploader.user.id, name: uploader.user.name });
          assert.instanceOf(
            yield* move.run(service, patch.patchId, outsider).pipe(Effect.flip),
            Patches.PatchUnavailable
          );
        }
        assert.instanceOf(
          yield* service
            .setDescription(patch.patchId, { userId: reader.user.id, admin: false }, "\u0000")
            .pipe(Effect.flip),
          Patches.NotOwner
        );
        assert.instanceOf(
          yield* update(patch.patchId, {
            ownerUserId: reader.user.id,
            machineTokenId: reader.machine.id
          }).pipe(Effect.flip),
          Patches.NotOwner
        );
        assert.instanceOf(
          yield* service
            .authorizePublish({
              intent: "update",
              patchId: patch.patchId,
              ownerUserId: outsider.userId
            })
            .pipe(Effect.flip),
          Patches.PatchUnavailable
        );
        assert.deepStrictEqual(yield* stored(patch.patchId), before);
        yield* service.inventory(patch.patchId, reader.user.id);
        assert.instanceOf(
          yield* service.inventory(patch.patchId, outsider.userId).pipe(Effect.flip),
          Patches.PatchUnavailable
        );
      }
      const disabled = yield* create();
      yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${disabled.patchId}`;
      for (const move of moves) {
        assert.instanceOf(
          yield* move.run(service, disabled.patchId, administrator).pipe(Effect.flip),
          Patches.PatchUnavailable
        );
        assert.instanceOf(
          yield* move.run(service, "unknown", owner).pipe(Effect.flip),
          Patches.PatchUnavailable
        );
      }
      assert.instanceOf(
        yield* service.inventory(disabled.patchId, uploader.user.id).pipe(Effect.flip),
        Patches.PatchUnavailable
      );
      assert.isTrue(Option.isNone(yield* service.find(disabled.patchId)));
    })
  );

  it.effect("rechecks ownership and state when an authorized publish commits", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      for (const change of ["reassign", "retire", "delete"] as const) {
        const patch = yield* create();
        const request = input({ intent: "update", patchId: patch.patchId });
        yield* service.authorizePublish(request);
        yield* service.preflight(request);
        if (change === "reassign") {
          yield* service.reassign(patch.patchId, administrator, reader.user.id);
          yield* service.retire(patch.patchId, administrator);
        } else if (change === "retire") yield* service.retire(patch.patchId, owner);
        else yield* service.delete(patch.patchId, owner);
        const expected =
          change === "reassign"
            ? "NotOwner"
            : change === "retire"
              ? "PatchRetired"
              : "PatchDeleted";
        assert.strictEqual((yield* Fixtures.record(request).pipe(Effect.flip))._tag, expected);
        assert.strictEqual((yield* service.preflight(request).pipe(Effect.flip))._tag, expected);
        const sql = yield* SqlClient.SqlClient;
        const versions =
          yield* sql`SELECT id FROM patch_versions WHERE patch_id = ${patch.patchId}`;
        assert.deepStrictEqual(versions, [{ id: patch.versionId }]);
      }
      const owned = yield* create();
      assert.instanceOf(
        yield* update(owned.patchId, {
          ownerUserId: admin.user.id,
          machineTokenId: admin.machine.id
        }).pipe(Effect.flip),
        Patches.NotOwner
      );
    })
  );

  it.effect("validates active reassignment targets and leaves a no-op unstamped", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const patch = yield* create();
      const before = yield* stored(patch.patchId);
      yield* TestClock.adjust(DAY);
      yield* service.reassign(patch.patchId, administrator, uploader.user.id);
      assert.deepStrictEqual(yield* stored(patch.patchId), before);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO users (id, clerk_user_id, company_id, email, name, role, deactivated_at)
        VALUES ('usr_lifecycle_inactive', 'clerk_lifecycle_inactive', ${uploader.company.id}, 'inactive@patchy.local', 'Inactive', 'member', now())`;
      for (const userId of ["usr_lifecycle_inactive", "usr_lifecycle_foreign", "unknown"]) {
        assert.instanceOf(
          yield* service.reassign(patch.patchId, administrator, userId).pipe(Effect.flip),
          Patches.InvalidOwner
        );
        assert.deepStrictEqual(yield* stored(patch.patchId), before);
      }
      const reassigned = yield* service.reassign(patch.patchId, administrator, admin.user.id);
      assert.strictEqual(reassigned.ownerUserId, admin.user.id);
      assert.strictEqual(reassigned.reassignedBy, admin.user.id);
      assert.strictEqual(
        (yield* update(patch.patchId, {
          ownerUserId: admin.user.id,
          machineTokenId: admin.machine.id
        })).versionNumber,
        2
      );
      assert.strictEqual(
        Option.getOrThrow(yield* service.find(patch.patchId, 1)).version.createdByMachineTokenId,
        uploader.machine.id
      );
    })
  );

  it.effect("normalizes descriptions by code point and stamps only changed text", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const patch = yield* create({ description: "  First\nparagraph \t here  " });
      assert.strictEqual(patch.description, "First paragraph here");
      yield* TestClock.adjust(DAY);
      const before = yield* stored(patch.patchId);
      yield* service.setDescription(patch.patchId, owner, " First\tparagraph\n here ");
      assert.deepStrictEqual(yield* stored(patch.patchId), before);
      const same = yield* update(patch.patchId, { description: "First paragraph here" });
      assert.strictEqual(same.descriptionUpdatedAt, patch.descriptionUpdatedAt);
      const astral = "\u{10400}".repeat(500);
      assert.strictEqual(
        (yield* service.setDescription(patch.patchId, administrator, astral)).description,
        astral
      );
      for (const text of [astral + "\u{10400}", "\u0000", "\u007f", "\u0085", " \n\t "]) {
        assert.instanceOf(
          yield* service.setDescription(patch.patchId, owner, text).pipe(Effect.flip),
          Patches.InvalidDescription
        );
      }
      yield* service.setDescription(patch.patchId, owner, "<script>literal</script>");
      const unchanged = yield* update(patch.patchId);
      assert.strictEqual(unchanged.description, "<script>literal</script>");
      const cleared = yield* service.setDescription(patch.patchId, owner, "");
      assert.strictEqual(cleared.description, "");
      const emptyBefore = yield* stored(patch.patchId);
      yield* TestClock.adjust(DAY);
      yield* service.setDescription(patch.patchId, administrator, "");
      assert.deepStrictEqual(yield* stored(patch.patchId), emptyBefore);
      const fromManifest = yield* create({
        manifest: { ...Fixtures.manifest, description: " Manifest description " }
      });
      assert.strictEqual(fromManifest.description, "Manifest description");
    })
  );

  it.effect("refuses reserved names before bytes and at commit", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      for (const name of ["patches", "connections"]) {
        const request = input({ manifest: { ...Fixtures.manifest, name } });
        assert.instanceOf(
          yield* service.preflight(request).pipe(Effect.flip),
          Patches.ReservedName
        );
        assert.instanceOf(yield* Fixtures.record(request).pipe(Effect.flip), Patches.ReservedName);
        assert.isTrue(Option.isNone(yield* service.find(request.patchId)));
      }
    })
  );

  it.effect("keeps live patches indefinitely and counts visits without changing stamps", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const patch = yield* create({
        ownerUserId: reader.user.id,
        machineTokenId: reader.machine.id
      });
      const before = Option.getOrThrow(yield* service.find(patch.patchId));
      yield* Fixtures.revoke(reader.machine.id);
      yield* TestClock.adjust(365 * DAY);
      yield* service.recordVisit(patch.patchId);
      yield* service.recordVisit(patch.patchId);
      assert.deepStrictEqual(Option.getOrThrow(yield* service.find(patch.patchId)), before);
      const sql = yield* SqlClient.SqlClient;
      const visits =
        yield* sql`SELECT visit_count::int AS count FROM patches WHERE id = ${patch.patchId}`;
      assert.deepStrictEqual(visits, [{ count: 2 }]);
      yield* service.retire(patch.patchId, administrator);
      yield* service.recordVisit(patch.patchId);
      assert.deepStrictEqual(
        yield* sql`SELECT visit_count::int AS count FROM patches WHERE id = ${patch.patchId}`,
        [{ count: 2 }]
      );
    })
  );

  it.effect(
    "defaults scope, preserves explicit scope across machines and serializes version numbers",
    () =>
      Effect.gen(function* () {
        const service = yield* Patches.Patches;
        const patch = yield* create();
        assert.strictEqual(patch.scope, "company");
        yield* service.setScope(patch.patchId, administrator, "public");
        const before = Option.getOrThrow(yield* service.find(patch.patchId));
        yield* service.setScope(patch.patchId, owner, "company");
        assert.deepStrictEqual(
          Option.getOrThrow(yield* service.find(patch.patchId)).version,
          before.version
        );
        assert.strictEqual((yield* update(patch.patchId, { scope: "public" })).scope, "public");
        assert.strictEqual(
          (yield* update(patch.patchId, { machineTokenId: sibling.machine.id })).scope,
          "public"
        );
        const numbers = yield* Effect.all(
          [update(patch.patchId), update(patch.patchId), update(patch.patchId)],
          { concurrency: "unbounded" }
        );
        assert.deepStrictEqual(numbers.map((entry) => entry.versionNumber).sort(), [4, 5, 6]);
      })
  );

  it.effect("counts retained non-deleted patches for the owner quota", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const before = yield* service.countQuotaPatches(uploader.user.id);
      const kept = yield* create();
      const retired = yield* create();
      const deleted = yield* create();
      const disabled = yield* create();
      yield* update(kept.patchId);
      assert.strictEqual(yield* service.countQuotaPatches(uploader.user.id), before + 4);
      yield* service.retire(retired.patchId, owner);
      yield* service.delete(deleted.patchId, owner);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${disabled.patchId}`;
      assert.strictEqual(yield* service.countQuotaPatches(uploader.user.id), before + 2);
    })
  );

  it.effect(
    "retains declarations across versions, excluding off dependants, and refuses unshare before DDL",
    () =>
      Effect.gen(function* () {
        const service = yield* Patches.Patches;
        const source = yield* create({ manifest: tableManifest("lifecycle-source") });
        const consumerManifest = {
          ...Fixtures.manifest,
          uses: { notes: declaration(source.patchId) }
        };
        const consumer = yield* create({
          manifest: consumerManifest,
          ownerUserId: reader.user.id,
          machineTokenId: reader.machine.id
        });
        yield* update(consumer.patchId, {
          manifest: consumerManifest,
          ownerUserId: reader.user.id,
          machineTokenId: reader.machine.id
        });
        yield* update(consumer.patchId, {
          ownerUserId: reader.user.id,
          machineTokenId: reader.machine.id
        });
        for (const state of ["retired", "deleted", "disabled"] as const) {
          const off = yield* create({ manifest: consumerManifest });
          if (state === "retired") yield* service.retire(off.patchId, owner);
          else if (state === "deleted") yield* service.delete(off.patchId, owner);
          else {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${off.patchId}`;
          }
        }
        const expected = [
          {
            patchId: consumer.patchId,
            name: consumer.name,
            owner: { id: reader.user.id, name: reader.user.name }
          }
        ];
        for (const move of [service.retire, service.delete]) {
          const refused = yield* move(source.patchId, owner).pipe(Effect.flip);
          assert.instanceOf(refused, Patches.HasDependants);
          assert.deepStrictEqual(refused.dependants, expected);
        }
        const before = yield* service.inventory(source.patchId, reader.user.id);
        const unshared: typeof Manifest.Type = {
          ...tableManifest(source.name, false),
          tables: {
            notes: {
              description: "Notes keyed by id.",
              columns: { body: { kind: "text" }, extra: { kind: "text", optional: true } },
              indexes: {},
              shared: false
            }
          }
        };
        const request = input({ intent: "update", patchId: source.patchId, manifest: unshared });
        assert.instanceOf(
          yield* service.preflight(request).pipe(Effect.flip),
          Patches.HasDependants
        );
        const refused = yield* Fixtures.record(request).pipe(Effect.flip);
        assert.instanceOf(refused, Patches.HasDependants);
        assert.deepStrictEqual(refused.dependants, expected);
        assert.deepStrictEqual(yield* service.inventory(source.patchId, uploader.user.id), before);
        yield* update(source.patchId, { manifest: unshared, force: true });
        const inventory = yield* service.inventory(source.patchId, reader.user.id);
        assert.isFalse(inventory.tables.notes!.shared);
        assert.isDefined(inventory.tables.notes!.columns.extra);
        yield* service.retire(source.patchId, owner, true);
        assert.instanceOf(
          yield* service
            .sharedTable(source.patchId, "notes", uploader.company.id)
            .pipe(Effect.flip),
          Patches.PatchNotOpenable
        );
        yield* service.delete(source.patchId, owner);
        assert.deepStrictEqual(yield* service.inventory(source.patchId, reader.user.id), inventory);
      })
  );

  it.effect("restore reports current-version sources as retired, deleted and gone", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const sources = [];
      for (const state of ["retired", "deleted", "gone", "older"])
        sources.push(yield* create({ manifest: tableManifest(`lifecycle-${state}`) }));
      const [retired, deleted, gone, older] = sources;
      const consumer = yield* create({
        manifest: { ...Fixtures.manifest, uses: { old: declaration(older!.patchId) } }
      });
      yield* update(consumer.patchId, {
        manifest: {
          ...Fixtures.manifest,
          uses: {
            retired: declaration(retired!.patchId),
            deleted: declaration(deleted!.patchId),
            gone: declaration(gone!.patchId)
          }
        }
      });
      yield* service.retire(consumer.patchId, owner);
      yield* service.retire(retired!.patchId, owner);
      yield* service.retire(older!.patchId, owner);
      yield* service.delete(deleted!.patchId, owner);
      yield* service.delete(gone!.patchId, owner);
      yield* TestClock.adjust(30 * DAY);
      yield* service.purgeDeleted(gone!.patchId);
      const refused = yield* service.restore(consumer.patchId, owner).pipe(Effect.flip);
      assert.instanceOf(refused, Patches.SourcesOff);
      assert.deepStrictEqual(refused.sources, [
        { patchId: retired!.patchId, name: retired!.name, table: "notes", state: "retired" },
        { patchId: deleted!.patchId, name: deleted!.name, table: "notes", state: "deleted" },
        { patchId: gone!.patchId, table: "notes", state: "gone" }
      ]);
      assert.strictEqual(
        (yield* service.restore(consumer.patchId, administrator, true)).state,
        "live"
      );
      yield* service.restore(retired!.patchId, owner);
      assert.strictEqual(
        (yield* service.sharedTable(retired!.patchId, "notes", uploader.company.id)).patchId,
        retired!.patchId
      );
    })
  );

  it.effect(
    "rolls back only the pointer, keeping cumulative inventory, sharing, name and description",
    () =>
      Effect.gen(function* () {
        const service = yield* Patches.Patches;
        const first = yield* create({
          manifest: tableManifest("lifecycle-rollback"),
          description: "First"
        });
        const secondManifest: typeof Manifest.Type = {
          ...tableManifest("lifecycle-renamed", false),
          tables: {
            notes: {
              description: "Notes keyed by id.",
              columns: { body: { kind: "text" }, extra: { kind: "text", optional: true } },
              indexes: {},
              shared: false
            }
          }
        };
        const second = yield* update(first.patchId, {
          manifest: secondManifest,
          description: "Second",
          machineTokenId: sibling.machine.id
        });
        const before = yield* service.inventory(first.patchId, reader.user.id);
        const rolled = yield* service.rollback(first.patchId, administrator, 1);
        assert.strictEqual(rolled.currentVersion, 1);
        assert.strictEqual(rolled.patch.currentVersionId, first.versionId);
        assert.strictEqual(rolled.patch.name, second.name);
        assert.strictEqual(rolled.patch.description, "Second");
        assert.strictEqual(rolled.patch.descriptionUpdatedAt, second.descriptionUpdatedAt);
        assert.deepStrictEqual(yield* service.inventory(first.patchId, reader.user.id), before);
        assert.strictEqual(
          Option.getOrThrow(yield* service.find(first.patchId)).version.createdByMachineTokenId,
          uploader.machine.id
        );
        assert.instanceOf(
          yield* service.rollback(first.patchId, owner, 999).pipe(Effect.flip),
          Patches.VersionUnavailable
        );
        const third = yield* update(first.patchId, { manifest: secondManifest });
        assert.strictEqual(third.versionNumber, 3);
        assert.strictEqual(
          Option.getOrThrow(yield* service.find(first.patchId)).version.id,
          third.versionId
        );
        assert.deepStrictEqual(
          { ...Option.getOrThrow(yield* service.resolveName(uploader.company.handle, first.name)) },
          { patchId: first.patchId, name: second.name, current: false }
        );
      })
  );

  it.effect(
    "restores the original inventory and address but refuses the exact recovery deadline",
    () =>
      Effect.gen(function* () {
        const service = yield* Patches.Patches;
        const patch = yield* create({ manifest: tableManifest("lifecycle-recovery") });
        const companies = yield* CompanyDatabases.CompanyDatabases;
        const inventory = yield* Inventory.Inventory;
        const before = yield* companies.withCompany(uploader.company.id)(
          inventory.read(patch.patchId)
        );
        yield* service.retire(patch.patchId, administrator);
        const deleted = yield* service.delete(patch.patchId, owner);
        assert.isNotNull(deleted.retiredAt);
        assert.strictEqual(Date.parse(deleted.purgeAt!) - Date.parse(deleted.deletedAt!), 30 * DAY);
        assert.strictEqual(
          Option.getOrThrow(yield* service.resolveName(uploader.company.handle, patch.name))
            .patchId,
          patch.patchId
        );
        yield* TestClock.adjust(30 * DAY - 1);
        const restored = yield* service.restore(patch.patchId, owner);
        assert.strictEqual(restored.name, patch.name);
        assert.isNull(restored.purgeAt);
        assert.deepStrictEqual(
          yield* companies.withCompany(uploader.company.id)(inventory.read(patch.patchId)),
          before
        );
        const deletedAgain = yield* service.delete(patch.patchId, owner);
        yield* TestClock.adjust(30 * DAY);
        const refused = yield* service
          .restore(patch.patchId, administrator, true)
          .pipe(Effect.flip);
        assert.instanceOf(refused, Patches.PatchDeleted);
        assert.strictEqual(refused.purgeAt, deletedAgain.purgeAt);
      })
  );

  it.effect("reserves an off patch's former names until reclamation", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      for (const state of ["retired", "deleted"] as const) {
        const formerName = `former-${state}`;
        const original = yield* create({ manifest: { ...Fixtures.manifest, name: formerName } });
        yield* update(original.patchId, {
          manifest: { ...Fixtures.manifest, name: `renamed-${state}` }
        });
        if (state === "retired") yield* service.retire(original.patchId, owner);
        else yield* service.delete(original.patchId, owner);
        const taker = input({ manifest: { ...Fixtures.manifest, name: formerName } });
        for (const attempt of [service.preflight(taker), Fixtures.record(taker)]) {
          const exit = yield* Effect.exit(attempt);
          assert.isTrue(Exit.isFailure(exit), `${state} former name was reusable`);
          if (Exit.isFailure(exit)) assert.instanceOf(Cause.squash(exit.cause), Patches.NameTaken);
        }
        yield* service.restore(original.patchId, owner);
        assert.strictEqual(
          Option.getOrThrow(yield* service.resolveName(uploader.company.handle, formerName))
            .patchId,
          original.patchId
        );
        if (state === "deleted") {
          yield* service.delete(original.patchId, owner);
          yield* TestClock.adjust(30 * DAY);
          yield* service.purgeDeleted(original.patchId);
        }
        // A live patch's former name, or a reclaimed one, is free to take.
        const taken = yield* create({ manifest: { ...Fixtures.manifest, name: formerName } });
        assert.strictEqual(taken.name, formerName);
      }
    })
  );

  it.effect("backfills missing names in creation order without changing existing names", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const named = yield* create({ title: "Backfill Report" });
      const later = yield* create({ title: "Bäckfill Réport" });
      const earlier = yield* create({ title: "BACKFILL___REPORT!" });
      const deleted = yield* create({ title: "Backfill Report" });
      yield* service.delete(deleted.patchId, owner);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM patch_names WHERE patch_id IN (${earlier.patchId}, ${later.patchId})`;
      yield* sql`UPDATE patches SET created_at = '2020-01-02'::timestamptz WHERE id = ${earlier.patchId}`;
      yield* sql`UPDATE patches SET created_at = '2020-01-03'::timestamptz WHERE id = ${later.patchId}`;
      yield* sql`UPDATE patches SET title = 'Already named title' WHERE id = ${named.patchId}`;
      for (let run = 0; run < 2; run++) {
        yield* Patches.backfillNames();
        for (const [patchId, name] of [
          [named.patchId, "backfill-report"],
          [earlier.patchId, "backfill-report-2"],
          [later.patchId, "backfill-report-3"]
        ] as const) {
          assert.strictEqual(Option.getOrThrow(yield* service.find(patchId)).patch.name, name);
          assert.deepStrictEqual(
            { ...Option.getOrThrow(yield* service.resolveName(uploader.company.handle, name)) },
            { patchId, name, current: true }
          );
        }
        assert.strictEqual(
          Option.getOrThrow(
            yield* service.resolveName(uploader.company.handle, "backfill-report-4")
          ).patchId,
          deleted.patchId
        );
      }
    })
  );

  for (const [admission, change] of [
    ["publish", "retire"],
    ["publish", "delete"],
    ["publish", "unshare"],
    ["restore", "retire"]
  ] as const) {
    it.effect(`fences ${change} against an uncommitted consumer ${admission}`, () =>
      Effect.gen(function* () {
        const service = yield* Patches.Patches;
        const sql = yield* SqlClient.SqlClient;
        const sourceManifest = tableManifest(`fence-${admission}-${change}`);
        const source = yield* create({ manifest: sourceManifest });
        const request = input({
          manifest: { ...Fixtures.manifest, tier: 1, uses: { notes: declaration(source.patchId) } }
        });
        yield* service.preflight(request);
        if (admission === "restore") {
          yield* Fixtures.record(request);
          yield* service.retire(request.patchId, owner);
        }
        const admitted = yield* Deferred.make<void>();
        const commit = yield* Deferred.make<void>();
        const admitting = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (admission === "restore") yield* service.restore(request.patchId, owner);
              else yield* Fixtures.record(request);
              yield* Deferred.succeed(admitted, undefined);
              yield* Deferred.await(commit);
            })
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(admitted);
        const changingPid = yield* Deferred.make<number>();
        const changing = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
              yield* Deferred.succeed(changingPid, row!.pid);
              if (change === "retire") yield* service.retire(source.patchId, owner);
              else if (change === "delete") yield* service.delete(source.patchId, owner);
              else
                yield* update(source.patchId, {
                  manifest: tableManifest(sourceManifest.name!, false)
                });
            })
          )
          .pipe(Effect.catchTags({ HasDependants: Effect.succeed }), Effect.forkScoped);
        const pid = yield* Deferred.await(changingPid);
        const waiting = yield* Effect.raceFirst(
          sql<{ waiting: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'
          ) AS waiting`.pipe(Effect.repeat({ until: (rows) => rows[0]!.waiting }), Effect.as(true)),
          Fiber.await(changing).pipe(Effect.as(false))
        );
        yield* Deferred.succeed(commit, undefined);
        yield* Fiber.join(admitting);
        const refusal = yield* Fiber.join(changing);
        assert.isTrue(waiting, "the source change must wait for the consumer's commit");
        assert.instanceOf(refusal, Patches.HasDependants);
        assert.deepStrictEqual(
          refusal.dependants.map(({ patchId }) => patchId),
          [request.patchId]
        );
        assert.isTrue(Option.isSome(yield* service.find(source.patchId)));
        assert.strictEqual(
          (yield* service.inventory(source.patchId, owner.userId)).tables.notes?.shared,
          true
        );
      }).pipe(Effect.scoped)
    );
  }
});

it.layer(Patches.layer.pipe(Layer.provideMerge(Fixtures.database)))("Patches reads", (it) => {
  const access: Patches.ReadAccess = {
    companyId: uploader.company.id,
    userId: reader.user.id,
    canOpen: () => true
  };

  it.effect("distinguishes an unavailable company database from confirmed empty inventory", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const empty = yield* create({ manifest: { ...Fixtures.manifest, name: "read-empty" } });
      assert.isNull(yield* service.companyInventory(empty.patchId, access));
      yield* databases.claim(uploader.company.id);
      assert.isNull(yield* service.companyInventory(empty.patchId, access));
      yield* databases.ensureReady(uploader.company.id);
      const confirmed = yield* service.companyInventory(empty.patchId, access);
      assert.isNotNull(confirmed);
      assert.deepStrictEqual(confirmed!.tables, {});
      assert.deepStrictEqual(confirmed!.files, {});

      const source = yield* create({ manifest: tableManifest("read-cumulative") });
      const before = yield* service.companyInventory(source.patchId, access);
      yield* update(source.patchId, {
        manifest: { ...Fixtures.manifest, name: source.name }
      });
      assert.deepStrictEqual(yield* service.companyInventory(source.patchId, access), before);
      assert.strictEqual(before!.tables.notes!.description, "Notes keyed by id.");
      assert.strictEqual(before!.tables.notes!.columns.body!.kind, "text");
      assert.isTrue(before!.tables.notes!.shared);
      const [detail] = yield* service.read({ ...access, state: "live", patchRef: source.name });
      assert.strictEqual(detail!.currentVersion, 2);
      assert.strictEqual(detail!.tier, 0);
    })
  );

  it.effect("applies alternate openability to actual state before reference state checks", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const live = yield* create({ manifest: { ...Fixtures.manifest, name: "read-open-live" } });
      const retired = yield* create({
        manifest: { ...Fixtures.manifest, name: "read-open-retired" }
      });
      yield* service.retire(retired.patchId, owner);
      const openability = yield* Patches.Openability;
      const narrowed = {
        companyId: uploader.company.id,
        userId: uploader.user.id,
        canOpen: (patch: Patches.Patch) => openability(patch, uploader.user.id)
      };
      const rows = yield* service.read({ ...narrowed, state: "all" });
      assert.deepStrictEqual(
        rows.map(({ patch }) => patch.id),
        [retired.patchId]
      );
      assert.strictEqual(
        (yield* service.read({ ...narrowed, state: "retired", patchRef: retired.name }))[0]!.patch
          .id,
        retired.patchId
      );
      for (const patchRef of [live.name, live.patchId]) {
        assert.instanceOf(
          yield* service.read({ ...narrowed, state: "retired", patchRef }).pipe(Effect.flip),
          Patches.PatchUnavailable
        );
      }
      assert.instanceOf(
        yield* service.companyInventory(live.patchId, narrowed).pipe(Effect.flip),
        Patches.PatchUnavailable
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${retired.patchId}`;
      assert.deepStrictEqual(yield* service.read({ ...narrowed, state: "all" }), []);
      assert.instanceOf(
        yield* service.companyInventory(retired.patchId, access).pipe(Effect.flip),
        Patches.PatchUnavailable
      );
      yield* sql`UPDATE patches SET disabled_at = NULL WHERE id = ${retired.patchId}`;
      assert.instanceOf(
        yield* service
          .companyInventory(retired.patchId, {
            ...access,
            companyId: "another-company"
          })
          .pipe(Effect.flip),
        Patches.PatchUnavailable
      );
    }).pipe(
      Effect.provide(
        Layer.succeed(
          Patches.Openability,
          (patch, userId) => patch.ownerUserId === userId && patch.state === "retired"
        )
      )
    )
  );

  it.effect("resolves current names and canonical ids before enforcing the requested state", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const first = yield* create({
        manifest: { ...Fixtures.manifest, name: "read-former-name" }
      });
      const live = yield* update(first.patchId, {
        manifest: { ...Fixtures.manifest, name: "read-current-name" }
      });
      const retired = yield* create({
        manifest: { ...Fixtures.manifest, name: "read-ref-retired" }
      });
      const deleted = yield* create({
        manifest: { ...Fixtures.manifest, name: "read-ref-deleted" }
      });
      yield* service.retire(retired.patchId, owner);
      const deletedPatch = yield* service.delete(deleted.patchId, owner);
      for (const [patchRef, state, actual] of [
        [retired.name, "live", "retired"],
        [deleted.patchId, "live", "deleted"],
        [live.name, "retired", "live"]
      ] as const) {
        const refused = yield* service.read({ ...access, state, patchRef }).pipe(Effect.flip);
        assert.instanceOf(refused, Patches.WrongState);
        assert.strictEqual(refused.state, actual);
      }
      for (const patchRef of [first.name, deleted.name, "unknown"]) {
        assert.instanceOf(
          yield* service.read({ ...access, state: "all", patchRef }).pipe(Effect.flip),
          Patches.PatchUnavailable
        );
      }
      const [detail] = yield* service.read({
        ...access,
        state: "all",
        patchRef: deleted.patchId
      });
      assert.strictEqual(detail!.patch.state, "deleted");
      assert.strictEqual(detail!.patch.purgeAt, deletedPatch.purgeAt);
      assert.strictEqual(
        Date.parse(detail!.patch.purgeAt!) - Date.parse(detail!.patch.deletedAt!),
        30 * DAY
      );
      yield* TestClock.adjust(30 * DAY);
      yield* service.purgeDeleted(deleted.patchId);
      assert.instanceOf(
        yield* service
          .read({
            ...access,
            state: "all",
            patchRef: deleted.patchId
          })
          .pipe(Effect.flip),
        Patches.PatchUnavailable
      );
    })
  );

  it.effect("orders mine first and joins the current version and deactivated owner", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const colleague = yield* create({
        manifest: { ...Fixtures.manifest, name: "aaa-read-colleague" }
      });
      const mine = yield* create({
        manifest: { ...Fixtures.manifest, name: "zzz-read-mine" },
        ownerUserId: reader.user.id,
        machineTokenId: reader.machine.id
      });
      const firstVersion = Option.getOrThrow(yield* service.find(mine.patchId)).version;
      yield* TestClock.adjust(1_000);
      yield* update(mine.patchId, {
        ownerUserId: reader.user.id,
        machineTokenId: reader.machine.id,
        manifest: { ...Fixtures.manifest, name: mine.name, tier: 1 }
      });
      yield* service.rollback(mine.patchId, { userId: reader.user.id, admin: false }, 1);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET deactivated_at = now() WHERE id = ${reader.user.id}`;
      const selected = new Set([colleague.patchId, mine.patchId]);
      const rows = yield* service.read({
        ...access,
        state: "live",
        canOpen: (patch) => selected.has(patch.id)
      });
      assert.deepStrictEqual(
        rows.map(({ patch }) => patch.id),
        [mine.patchId, colleague.patchId]
      );
      assert.deepStrictEqual(rows[0]!.owner, {
        id: reader.user.id,
        name: reader.user.name,
        deactivated: true
      });
      assert.strictEqual(rows[0]!.currentVersion, 1);
      assert.strictEqual(rows[0]!.tier, firstVersion.tier);
      assert.strictEqual(rows[0]!.publishedAt, firstVersion.createdAt);
      assert.deepStrictEqual(
        (yield* service.read({
          ...access,
          state: "live",
          mine: true,
          canOpen: (patch) => selected.has(patch.id)
        })).map(({ patch }) => patch.id),
        [mine.patchId]
      );
      yield* sql`UPDATE users SET deactivated_at = NULL WHERE id = ${reader.user.id}`;
    })
  );

  it.effect("keeps retained source states while redacting inaccessible source names", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const sources: Record<string, Patches.Recorded> = {};
      for (const state of ["live", "retired", "deleted", "gone", "disabled", "hidden", "foreign"])
        sources[state] = yield* create({ manifest: tableManifest(`read-source-${state}`) });
      const uses = Object.fromEntries(
        Object.entries(sources).map(([alias, source]) => [alias, declaration(source.patchId)])
      );
      const consumer = yield* create({ manifest: { ...Fixtures.manifest, uses } });
      yield* update(consumer.patchId, { manifest: { ...Fixtures.manifest, uses } });
      yield* update(consumer.patchId);
      yield* service.retire(sources.retired!.patchId, owner, true);
      yield* service.retire(sources.hidden!.patchId, owner, true);
      yield* service.delete(sources.deleted!.patchId, owner, true);
      yield* service.delete(sources.gone!.patchId, owner, true);
      yield* TestClock.adjust(30 * DAY);
      yield* service.purgeDeleted(sources.gone!.patchId);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${sources.disabled!.patchId}`;
      yield* sql`INSERT INTO companies (id, handle, name)
        VALUES ('cmp_read_foreign', 'read-foreign', 'Foreign read company')`;
      yield* sql`UPDATE patches SET company_id = 'cmp_read_foreign'
        WHERE id = ${sources.foreign!.patchId}`;
      const [detail] = yield* service.read({
        ...access,
        state: "live",
        patchRef: consumer.patchId,
        canOpen: (patch) => patch.id !== sources.hidden!.patchId
      });
      const expected = Object.entries(sources).map(([alias, source]) => ({
        alias,
        patchId: source.patchId,
        table: "notes",
        ...(["live", "retired", "deleted"].includes(alias)
          ? { name: source.name, state: alias }
          : alias === "disabled"
            ? { state: "live" }
            : alias === "hidden"
              ? { state: "retired" }
              : { state: "gone" })
      }));
      assert.deepStrictEqual(
        detail!.reads,
        expected.sort((a, b) => a.alias.localeCompare(b.alias))
      );
      for (const patchRef of [sources.foreign!.name, sources.foreign!.patchId]) {
        assert.instanceOf(
          yield* service.read({ ...access, state: "all", patchRef }).pipe(Effect.flip),
          Patches.PatchUnavailable
        );
      }
    })
  );

  it.effect("reports distinct live dependant table edges from all retained versions", () =>
    Effect.gen(function* () {
      const service = yield* Patches.Patches;
      const source = yield* create({ manifest: tableManifest("read-dependant-source") });
      const manifest = {
        ...Fixtures.manifest,
        uses: { notes: declaration(source.patchId), another: declaration(source.patchId) }
      };
      const consumer = yield* create({
        manifest,
        ownerUserId: reader.user.id,
        machineTokenId: reader.machine.id
      });
      yield* update(consumer.patchId, {
        manifest,
        ownerUserId: reader.user.id,
        machineTokenId: reader.machine.id
      });
      yield* update(consumer.patchId, {
        ownerUserId: reader.user.id,
        machineTokenId: reader.machine.id
      });
      const hidden = yield* create({ manifest });
      for (const state of ["retired", "deleted", "disabled"] as const) {
        const off = yield* create({ manifest });
        if (state === "retired") yield* service.retire(off.patchId, owner);
        else if (state === "deleted") yield* service.delete(off.patchId, owner);
        else {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE patches SET disabled_at = now() WHERE id = ${off.patchId}`;
        }
      }
      yield* service.retire(source.patchId, owner, true);
      const [detail] = yield* service.read({
        ...access,
        state: "retired",
        patchRef: source.patchId,
        canOpen: (patch) => patch.id !== hidden.patchId
      });
      assert.deepStrictEqual(detail!.dependants, [
        {
          patchId: consumer.patchId,
          name: consumer.name,
          owner: { id: reader.user.id, name: reader.user.name },
          table: "notes"
        }
      ]);
    })
  );

  it.effect(
    "recovers company operational errors without hiding identity defects or platform errors",
    () =>
      Effect.gen(function* () {
        const patch = yield* create();
        const databases = yield* CompanyDatabases.CompanyDatabases;
        const inventory = yield* Inventory.Inventory;
        const failure = new SqlError({
          reason: new ConnectionError({ cause: new Error("company database offline") })
        });
        for (const error of [
          new CompanyDatabases.Busy({ resource: "pool", limit: 1 }),
          new CompanyDatabases.CompanyDatabaseNotReady({
            companyId: access.companyId,
            status: "claimed"
          }),
          new CompanyDatabases.CompanyDatabaseError({
            companyId: access.companyId,
            operation: "connect",
            cause: failure
          })
        ]) {
          const service = yield* Patches.make.pipe(
            Effect.provide(
              Layer.succeed(CompanyDatabases.CompanyDatabases, {
                ...databases,
                withCompany: () => () => Effect.fail(error)
              })
            )
          );
          assert.isNull(yield* service.companyInventory(patch.patchId, access));
          const [detail] = yield* service.read({
            ...access,
            state: "live",
            patchRef: patch.patchId
          });
          assert.strictEqual(detail!.patch.id, patch.patchId);
        }
        const unavailable = yield* Patches.make.pipe(
          Effect.provide(
            Layer.succeed(Inventory.Inventory, {
              ...inventory,
              read: () => Effect.fail(failure)
            })
          )
        );
        assert.isNull(yield* unavailable.companyInventory(patch.patchId, access));
        const mismatch = new CompanyDatabases.CompanyIdentityMismatch({
          expectedCompanyId: access.companyId,
          actualCompanyId: "other-company"
        });
        const broken = yield* Patches.make.pipe(
          Effect.provide(
            Layer.succeed(CompanyDatabases.CompanyDatabases, {
              ...databases,
              withCompany: () => () => Effect.fail(mismatch)
            })
          )
        );
        const exit = yield* broken.companyInventory(patch.patchId, access).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) assert.deepStrictEqual(Cause.squash(exit.cause), mismatch);
        const sql = yield* SqlClient.SqlClient;
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`ALTER TABLE patches RENAME COLUMN title TO inaccessible_title`;
              const service = yield* Patches.Patches;
              assert.instanceOf(
                yield* service.read({ ...access, state: "all" }).pipe(Effect.flip),
                SqlError
              );
              return yield* Effect.fail("rollback-platform-fault" as const);
            })
          )
          .pipe(
            Effect.catch((error) =>
              error === "rollback-platform-fault" ? Effect.void : Effect.fail(error)
            )
          );
      })
  );
});
