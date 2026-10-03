import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { Analytics } from "@patchy/analytics";
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
const publish = (name: string) =>
  Effect.flatMap(Content.Content, (content) =>
    content.publish(
      Fixtures.publishInput(uploader, {
        manifest: { ...Fixtures.manifest, name },
        title: name,
        html: `<p>${name}</p>`
      })
    )
  );
const sweep = Effect.flatMap(DeletionSweep.DeletionSweep, (service) => service.sweep);
const services = Layer.mergeAll(DeletionSweep.layer, Content.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(Patches.layer, filesystem, Analytics.layerNoop)),
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
});
