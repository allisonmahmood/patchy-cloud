import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import { Analytics } from "@patchy/analytics";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import * as ConfigProvider from "effect/ConfigProvider";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Content from "./Content.js";
import * as DeletionSweep from "./DeletionSweep.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const { uploader } = Fixtures.identities;
const actor = { userId: uploader.user.id, admin: false };
const rootDir = `/tmp/patchy-deletion-sweep-${process.pid}-${Date.now()}`;
const filesystem = FilesystemContentStore.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: rootDir })))
);
const publish = (name: string, resources = false) =>
  Effect.flatMap(Content.Content, (content) =>
    content.publish({
      ...Fixtures.publishRecord(),
      manifest: {
        ...Fixtures.manifest,
        name,
        files: resources ? { docs: { description: "Documents keyed by file name." } } : {}
      },
      patchId: null,
      companyId: uploader.company.id,
      ownerUserId: uploader.user.id,
      machineTokenId: uploader.machine.id,
      title: name,
      html: `<p>${name}</p>`,
      filename: null,
      repoOrg: null,
      repoName: null,
      cliVersion: null,
      gitBranch: null,
      gitCommitSha: null,
      sourceIp: null,
      userAgent: null
    })
  );
const sweep = Effect.flatMap(DeletionSweep.DeletionSweep, (service) => service.sweep);
const services = Layer.mergeAll(DeletionSweep.layer, Content.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Patches.layer, filesystem, Analytics.layerNoop)),
  Layer.provideMerge(Fixtures.database),
  Layer.provideMerge(NodeFileSystem.layer)
);

it.layer(services)("DeletionSweep", (it) => {
  it.effect("keeps names and bytes through recovery, then reclaims at the hourly tick", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const patches = yield* Patches.Patches;
      const objects = yield* ContentStore.ContentStore;
      const deleted = yield* publish("recoverable");
      const key = Content.objectKey(deleted.patchId, deleted.versionId);
      const removed = yield* patches.delete(deleted.patchId, actor);
      const retired = yield* publish("kept-retired");
      yield* patches.retire(retired.patchId, actor);
      const live = yield* publish("kept-live");
      yield* TestClock.adjust(29 * DAY);
      const newer = yield* publish("newer-delete");
      yield* patches.delete(newer.patchId, actor);
      const restored = yield* publish("restored-before-sweep");
      yield* patches.delete(restored.patchId, actor);
      yield* patches.restore(restored.patchId, actor);
      yield* TestClock.adjust(DAY - 1);
      assert.strictEqual(removed.purgeAt, "2026-01-31T00:00:00.000Z");
      assert.strictEqual(yield* objects.get(key), "<p>recoverable</p>");
      assert.strictEqual((yield* publish("recoverable").pipe(Effect.flip))._tag, "NameTaken");
      const runs = yield* Queue.unbounded<DeletionSweep.SweepResult>();
      yield* Effect.forkScoped(
        Effect.repeat(
          sweep.pipe(Effect.tap((result) => Queue.offer(runs, result))),
          Schedule.spaced("1 hour")
        )
      );
      assert.strictEqual((yield* Queue.take(runs)).deleted, 0);
      yield* TestClock.adjust(1);
      assert.include(yield* patches.listDeleted(100), deleted.patchId);
      yield* TestClock.adjust("1 hour");
      assert.deepStrictEqual(yield* Queue.take(runs), {
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });
      assert.strictEqual((yield* objects.get(key).pipe(Effect.flip))._tag, "ObjectNotFound");
      assert.strictEqual(
        (yield* patches.restore(deleted.patchId, actor).pipe(Effect.flip))._tag,
        "PatchUnavailable"
      );
      const replacement = yield* publish("recoverable");
      assert.notStrictEqual(replacement.patchId, deleted.patchId);
      assert.isTrue(Option.isSome(yield* patches.find(live.patchId)));
      assert.isTrue(Option.isSome(yield* patches.find(restored.patchId)));
      yield* patches.restore(retired.patchId, actor);
      yield* patches.restore(newer.patchId, actor);
    })
  );

  it.effect("never reclaims live or retired patches merely because time passes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.UTC(2027, 0, 1));
      const patches = yield* Patches.Patches;
      const kept = yield* publish("indefinite-retire");
      yield* patches.retire(kept.patchId, actor);
      yield* TestClock.adjust(365 * DAY);
      assert.strictEqual((yield* sweep).deleted, 0);
      yield* patches.restore(kept.patchId, actor);
      assert.isTrue(Option.isSome(yield* patches.find(kept.patchId)));
    })
  );

  it.effect("retries version-object deletion after the patch row is gone", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const objects = yield* ContentStore.ContentStore;
      const orphaned = yield* publish("failed-object-delete");
      const key = Content.objectKey(orphaned.patchId, orphaned.versionId);
      yield* patches.delete(orphaned.patchId, actor);
      yield* TestClock.adjust(30 * DAY);
      const failing = Layer.succeed(ContentStore.ContentStore, {
        ...objects,
        delete: (objectKey) =>
          Effect.fail(
            new ContentStore.StoreUnavailable({
              operation: "delete",
              key: objectKey,
              cause: new Error()
            })
          )
      });
      const broken = yield* DeletionSweep.make.pipe(Effect.provide(failing));
      assert.deepStrictEqual(yield* broken.sweep, {
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 1
      });
      assert.strictEqual(yield* objects.get(key), "<p>failed-object-delete</p>");
      assert.deepStrictEqual(yield* sweep, {
        deleted: 0,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });
      assert.strictEqual((yield* objects.get(key).pipe(Effect.flip))._tag, "ObjectNotFound");
      assert.deepStrictEqual(yield* patches.claimObjects(100), []);
    })
  );

  it.effect("skips a stale sweep candidate when a pre-deadline restore commits first", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const platform = yield* SqlClient.SqlClient;
      const companies = yield* CompanyDatabases.CompanyDatabases;
      const inventory = yield* Inventory.Inventory;
      const objects = yield* ContentStore.ContentStore;
      const created = yield* publish("restore-wins-reclamation", true);
      const key = Content.objectKey(created.patchId, created.versionId);
      yield* patches.delete(created.patchId, actor);
      yield* TestClock.adjust(30 * DAY - 1);
      const restored = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const restoring = yield* platform
        .withTransaction(
          patches.restore(created.patchId, actor).pipe(
            Effect.tap(() => Deferred.succeed(restored, undefined)),
            Effect.tap(() => Deferred.await(commit))
          )
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(restored);
      yield* TestClock.adjust(1);
      assert.include(yield* patches.listDeleted(100), created.patchId);
      const sweepPid = yield* Deferred.make<number>();
      const purging = yield* platform
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* platform<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            yield* Deferred.succeed(sweepPid, row!.pid);
            return yield* patches.purgeDeleted(created.patchId);
          })
        )
        .pipe(Effect.forkScoped);
      const pid = yield* Deferred.await(sweepPid);
      yield* platform<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'
      ) AS waiting`.pipe(Effect.repeat({ until: (rows) => rows[0]!.waiting }));
      yield* Deferred.succeed(commit, undefined);
      yield* Fiber.join(restoring);
      assert.isTrue(Option.isNone(yield* Fiber.join(purging)));
      assert.strictEqual(
        Option.getOrThrow(yield* patches.find(created.patchId)).version.id,
        created.versionId
      );
      assert.isNotNull(
        yield* companies.withCompany(uploader.company.id)(inventory.read(created.patchId))
      );
      assert.strictEqual(yield* objects.get(key), "<p>restore-wins-reclamation</p>");
    }).pipe(Effect.scoped)
  );

  it.effect("purges under both locks before reclaiming its namespace and file objects", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const platform = yield* SqlClient.SqlClient;
      const companies = yield* CompanyDatabases.CompanyDatabases;
      const inventory = yield* Inventory.Inventory;
      const objects = yield* ContentStore.ContentStore;
      const created = yield* publish("locked-reclamation", true);
      const fileKey = `files/${created.patchId}/docs/object`;
      yield* objects.put(fileKey, "retained file");
      yield* patches.delete(created.patchId, actor);
      yield* TestClock.adjust(30 * DAY);
      const locked = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const withPatchLock: CompanyDatabases.CompanyDatabases["Service"]["withPatchLock"] =
        (patchId) => (effect) =>
          companies.withPatchLock(patchId)(
            patchId === created.patchId
              ? Deferred.succeed(locked, undefined).pipe(
                  Effect.andThen(Deferred.await(resume)),
                  Effect.andThen(effect)
                )
              : effect
          );
      const gated = yield* Patches.make.pipe(
        Effect.provideService(CompanyDatabases.CompanyDatabases, { ...companies, withPatchLock })
      );
      const sweeper = yield* DeletionSweep.make.pipe(Effect.provideService(Patches.Patches, gated));
      const purging = yield* sweeper.sweep.pipe(Effect.forkScoped);
      yield* Deferred.await(locked);
      const platformPid = yield* Deferred.make<number>();
      const restoring = yield* platform
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* platform<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            yield* Deferred.succeed(platformPid, row!.pid);
            return yield* patches.restore(created.patchId, actor).pipe(Effect.flip);
          })
        )
        .pipe(Effect.forkScoped);
      const companyPid = yield* Deferred.make<number>();
      const competing = yield* companies
        .withCompany(uploader.company.id)(
          Effect.gen(function* () {
            const sql = yield* CompanyDatabases.CompanyConnection;
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
                yield* Deferred.succeed(companyPid, row!.pid);
                yield* companies.withPatchLock(created.patchId)(Effect.void);
              })
            );
          })
        )
        .pipe(Effect.forkScoped);
      const first = yield* Deferred.await(platformPid);
      const second = yield* Deferred.await(companyPid);
      yield* platform<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE pid IN (${first}, ${second}) AND wait_event_type = 'Lock'`.pipe(
        Effect.repeat({ until: (rows) => rows[0]!.waiting === 2 })
      );
      yield* Deferred.succeed(resume, undefined);
      assert.strictEqual((yield* Fiber.join(restoring))._tag, "PatchUnavailable");
      yield* Fiber.join(competing);
      assert.deepStrictEqual(yield* Fiber.join(purging), {
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });
      assert.isNull(
        yield* companies.withCompany(uploader.company.id)(inventory.read(created.patchId))
      );
      assert.strictEqual((yield* objects.get(fileKey).pipe(Effect.flip))._tag, "ObjectNotFound");
    }).pipe(Effect.scoped)
  );
});
