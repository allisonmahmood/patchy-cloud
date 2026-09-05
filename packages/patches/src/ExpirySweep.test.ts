import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
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

const upload = (title: string) =>
  Effect.flatMap(Content.Content, (content) =>
    content.upload({
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
      const abandoned = yield* upload("Abandoned");
      yield* TestClock.adjust(80 * DAY);
      const fresh = yield* upload("Fresh");

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

  it.effect("counts an object it could not delete once the record is already gone", () =>
    Effect.gen(function* () {
      const patches = yield* Patches.Patches;
      const failing = Layer.succeed(
        ContentStore.ContentStore,
        ContentStore.ContentStore.of({
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
      yield* upload("Orphaned");
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
      // The record went, so no later run finds it: storage to reclaim by hand.
      assert.deepStrictEqual(yield* sweep, {
        deleted: 0,
        skipped: 0,
        failed: 0,
        orphanedObjects: 0
      });
    })
  );
});
