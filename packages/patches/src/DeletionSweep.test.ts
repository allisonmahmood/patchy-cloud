import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { Analytics } from "@patchy/analytics";
import { CompanyDatabases, OrphanSweep } from "@patchy/company-database";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { newInternalId, newPatchId, sha256 } from "@patchy/core";
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
const publish = (name: string, files = false) =>
  Effect.flatMap(Content.Content, (content) =>
    content.publish(
      Fixtures.publishInput(uploader, {
        manifest: {
          ...Fixtures.manifest,
          name,
          files: files ? { docs: { description: "Documents keyed by file name." } } : {}
        },
        title: name,
        html: `<p>${name}</p>`
      })
    )
  );
const sweep = Effect.flatMap(DeletionSweep.DeletionSweep, (service) => service.sweep);
const keys = (prefix: string) =>
  Effect.flatMap(ContentStore.ContentStore, (objects) =>
    objects.list(prefix).pipe(
      Stream.runCollect,
      Effect.map((listed) => listed.map(({ key }) => key).sort())
    )
  );
/** The same store, refusing to delete the keys `refuses` picks. */
const refusing = (
  objects: ContentStore.ContentStore["Service"],
  refuses: (key: string) => boolean
) =>
  Layer.succeed(ContentStore.ContentStore, {
    ...objects,
    delete: (key) =>
      refuses(key)
        ? Effect.fail(
            new ContentStore.StoreUnavailable({ operation: "delete", key, cause: new Error() })
          )
        : objects.delete(key)
  });
const events: Analytics.AnalyticsEvent[] = [];
const recordingAnalytics = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
);
const services = Layer.mergeAll(DeletionSweep.layer, Content.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Patches.layer, filesystem)),
  Layer.provideMerge(recordingAnalytics),
  Layer.provideMerge(Fixtures.database),
  Layer.provideMerge(NodeFileSystem.layer)
);

it.layer(services)("DeletionSweep", (it) => {
  it.effect("keeps names and bytes through recovery, then reclaims once the window ends", () =>
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
      assert.strictEqual((yield* sweep).deleted, 0);
      yield* TestClock.adjust(1);
      assert.include(yield* patches.listDeleted(100), deleted.patchId);
      assert.deepStrictEqual(yield* sweep, {
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });
      assert.deepStrictEqual(
        events.filter(
          (event) => event.name === "patch.purged" && event.properties.patchId === deleted.patchId
        ),
        [
          {
            name: "patch.purged",
            principalId: null,
            companyId: uploader.company.id,
            properties: {
              patchId: deleted.patchId,
              ownerUserId: uploader.user.id,
              versionsRemoved: 1
            }
          }
        ]
      );
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

  it.effect("retries version-object deletion after the patch row is gone", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const objects = yield* ContentStore.ContentStore;
      const orphaned = yield* publish("failed-object-delete");
      const key = Content.objectKey(orphaned.patchId, orphaned.versionId);
      yield* patches.delete(orphaned.patchId, actor);
      yield* TestClock.adjust(30 * DAY);
      const broken = yield* DeletionSweep.make.pipe(Effect.provide(refusing(objects, () => true)));
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

  it.effect("queues and reclaims every retained server artifact of a purged tier 2 patch", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const objects = yield* ContentStore.ContentStore;
      const patchId = newPatchId();
      const serverKeys: string[] = [];
      // Two tier 2 versions around a tier 1 one, which has no server artifact.
      for (const [intent, tier] of [
        ["create", 2],
        ["update", 1],
        ["update", 2]
      ] as const) {
        const versionId = newInternalId("ver");
        const objectKey = Content.objectKey(patchId, versionId);
        const server =
          tier === 2
            ? {
                objectKey: Content.serverObjectKey(patchId, versionId),
                sha256: sha256(versionId),
                bytes: 1
              }
            : undefined;
        yield* Fixtures.record(
          Fixtures.recordInput(uploader, {
            intent,
            patchId,
            versionId,
            objectKey,
            server,
            manifest: { ...Fixtures.manifest, name: "purged-tier-two", tier }
          })
        );
        yield* objects.put(objectKey, "<p>page</p>");
        if (server !== undefined) {
          yield* objects.put(server.objectKey, "export default {};");
          serverKeys.push(server.objectKey);
        }
      }
      assert.lengthOf(yield* keys(`patches/${patchId}/`), 5);
      yield* patches.delete(patchId, actor);
      yield* TestClock.adjust(30 * DAY);
      const stuck = serverKeys[0]!;
      const broken = yield* DeletionSweep.make.pipe(
        Effect.provide(refusing(objects, (key) => key === stuck))
      );
      assert.deepStrictEqual(yield* broken.sweep, {
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 1
      });
      assert.deepStrictEqual(yield* keys(`patches/${patchId}/`), [stuck]);
      assert.deepStrictEqual(yield* sweep, {
        deleted: 0,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });
      assert.deepStrictEqual(yield* keys(`patches/${patchId}/`), []);
      assert.deepStrictEqual(yield* patches.claimObjects(100), []);
    })
  );

  it.effect("leaves a partly reclaimed patch's files to the orphan sweep, sparing others", () =>
    Effect.gen(function* () {
      // Stored files carry wall-clock times; the orphan sweep's one-day grace reads this clock.
      yield* TestClock.setTime(Date.UTC(2035, 0, 1));
      const patches = yield* Patches.Patches;
      const objects = yield* ContentStore.ContentStore;
      const companies = yield* CompanyDatabases.CompanyDatabases;
      const reclaimed = yield* publish("partly-reclaimed", true);
      const kept = yield* publish("files-kept", true);
      for (const objectId of ["first", "second", "third"])
        yield* objects.put(`files/${reclaimed.patchId}/${objectId}`, objectId);
      yield* objects.put(`files/${kept.patchId}/kept`, "kept");
      yield* companies.withCompany(uploader.company.id)(
        companies.withPatchLock(kept.patchId)(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`INSERT INTO patchy.files
              (patch_id, store, name, object_id, size, content_type, sha256)
              VALUES (${kept.patchId}, 'docs', 'kept.txt', 'kept', 4, 'text/plain',
                ${createHash("sha256").update("kept").digest("hex")})`
          )
        )
      );
      yield* patches.delete(reclaimed.patchId, actor);
      yield* TestClock.adjust(30 * DAY);
      // The store fails after one file object: the namespace and the row are already gone.
      let deletes = 0;
      const broken = yield* DeletionSweep.make.pipe(
        Effect.provide(
          refusing(objects, (key) => key.startsWith(`files/${reclaimed.patchId}/`) && ++deletes > 1)
        )
      );
      assert.strictEqual((yield* broken.sweep).deleted, 1);
      assert.lengthOf(yield* keys(`files/${reclaimed.patchId}/`), 2);
      // A restarted deletion sweep no longer sees the patch; the orphan sweep takes the rest.
      assert.strictEqual((yield* sweep).deleted, 0);
      assert.lengthOf(yield* keys(`files/${reclaimed.patchId}/`), 2);
      const orphans = yield* OrphanSweep.make;
      assert.deepStrictEqual(yield* orphans.sweep, {
        namespacesDeleted: 0,
        filesDeleted: 2,
        failed: 0
      });
      assert.deepStrictEqual(yield* keys(`files/${reclaimed.patchId}/`), []);
      assert.deepStrictEqual(yield* keys(`files/${kept.patchId}/`), [`files/${kept.patchId}/kept`]);
    })
  );
});
