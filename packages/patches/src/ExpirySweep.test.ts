import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { Analytics } from "@patchy/analytics";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Content from "./Content.js";
import * as ExpirySweep from "./ExpirySweep.js";
import * as Patches from "./Patches.js";
import * as Fixtures from "./test/fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const { uploader } = Fixtures.identities;

const events: Analytics.AnalyticsEvent[] = [];
const recording = Layer.succeed(
  Analytics.Analytics,
  Analytics.Analytics.of({ track: (event) => Effect.sync(() => void events.push(event)) })
);

const rootDir = `/tmp/patchy-sweep-${process.pid}-${Date.now()}`;
const filesystem = FilesystemContentStore.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: rootDir })))
);

const publish = (title: string) =>
  Effect.flatMap(Content.Content, (content) =>
    content.publish({
      ...Fixtures.publishRecord(),
      patchId: null,
      companyId: uploader.company.id,
      ownerUserId: uploader.user.id,
      machineTokenId: uploader.machine.id,
      title,
      html: `<p>${title}</p>`,
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

const isServed = (patchId: string) =>
  Effect.map(
    Effect.flatMap(Patches.Patches, (patches) => patches.find(patchId)),
    Option.isSome
  );

const sweep = Effect.flatMap(ExpirySweep.ExpirySweep, (service) => service.sweep);

it.layer(
  Layer.mergeAll(ExpirySweep.layer, Content.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(Patches.layer, filesystem, recording)),
    Layer.provideMerge(Fixtures.database),
    Layer.provideMerge(NodeFileSystem.layer)
  )
)("ExpirySweep", (it) => {
  it.effect("takes expired patches — record, bytes and quota slot — on the hourly schedule", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const files = yield* FileSystem.FileSystem;
      yield* TestClock.setTime(Date.UTC(2026, 0, 1));
      const abandoned = yield* publish("Abandoned");
      yield* TestClock.adjust(80 * DAY);
      const fresh = yield* publish("Fresh");

      // Start at the retention anchor: expiry is strictly after it.
      yield* TestClock.adjust(10 * DAY);

      // What the server forks: one run on the way up, then one an hour. Each
      // run reports into the queue, which is how the test waits for one to end.
      const runs = yield* Queue.unbounded<ExpirySweep.SweepResult>();
      yield* Effect.forkScoped(
        Effect.repeat(
          sweep.pipe(Effect.tap((result) => Queue.offer(runs, result))),
          Schedule.spaced("1 hour")
        )
      );
      assert.strictEqual((yield* Queue.take(runs)).deleted, 0, "nothing has expired yet");
      assert.isTrue(yield* isServed(abandoned.patchId));

      // Cross expiry before the next hourly tick. A multi-hour jump can queue
      // several runs if SQL completes before TestClock advances again.
      yield* TestClock.adjust(1);
      assert.isFalse(yield* isServed(abandoned.patchId), "expired the moment its clock ran out");
      yield* TestClock.adjust("1 hour");
      assert.deepStrictEqual(yield* Queue.take(runs), {
        deleted: 1,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });
      assert.isFalse(
        yield* files.exists(
          `${rootDir}/${Content.objectKey(abandoned.patchId, abandoned.versionId)}`
        )
      );
      assert.isTrue(yield* isServed(fresh.patchId));
      assert.strictEqual(yield* patches.countLive(uploader.user.id), 1);
      assert.deepStrictEqual(
        events.filter((event) => event.name === "patch.expired"),
        [
          {
            name: "patch.expired",
            principalId: null,
            properties: { patchId: abandoned.patchId, versionsRemoved: 1 }
          }
        ]
      );
    })
  );

  it.effect("retries object deletion after the expired patch record is gone", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const objects = yield* ContentStore.ContentStore;
      const failing = Layer.succeed(
        ContentStore.ContentStore,
        ContentStore.ContentStore.of({
          ...objects,
          list: (key) =>
            Stream.fail(
              new ContentStore.StoreUnavailable({
                operation: "list",
                key,
                cause: new Error()
              })
            ),
          put: () => Effect.void,
          get: (key) => Effect.fail(new ContentStore.ObjectNotFound({ key })),
          delete: (key) =>
            Effect.fail(
              new ContentStore.StoreUnavailable({ operation: "delete", key, cause: new Error() })
            )
        })
      );
      yield* TestClock.setTime(Date.UTC(2027, 0, 1));
      // Whatever the block's earlier patches left behind goes first, with a store that works.
      yield* sweep;
      const orphaned = yield* publish("Orphaned");
      const key = Content.objectKey(orphaned.patchId, orphaned.versionId);
      yield* TestClock.adjust(91 * DAY);

      // A fresh sweep over the failing store: `ExpirySweep.layer` itself is memoised by the block.
      const result = yield* sweep.pipe(
        Effect.provide(
          Layer.effect(ExpirySweep.ExpirySweep, ExpirySweep.make).pipe(
            Layer.provide(Layer.mergeAll(failing, recording))
          )
        )
      );
      assert.deepStrictEqual(result, { deleted: 1, skipped: 0, failed: 0, orphanedObjects: 1 });
      assert.strictEqual(yield* patches.countLive(uploader.user.id), 0);
      assert.isTrue(Option.isNone(yield* patches.find(orphaned.patchId)));
      assert.strictEqual(yield* objects.get(key), "<p>Orphaned</p>");
      // Its durable intent survives the lost version row and the failed delete.
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
