import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { PublishRequest } from "@patchy/api";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as State from "./State.js";
import { MANIFEST_VERSION, RELEASE } from "./release.js";

const pending = (publishKey: string) =>
  new State.PendingPublish({
    ownerUserId: "owner",
    target: { mode: "repo" },
    request: new PublishRequest({
      publishKey,
      manifest: {
        release: RELEASE,
        manifestVersion: MANIFEST_VERSION,
        tier: 0,
        tables: {},
        files: {},
        uses: {}
      },
      html: "<!doctype html><title>State</title>",
      metadata: {}
    })
  });
const apiUrl = "https://instance.test";
const services = Layer.merge(NodeFileSystem.layer, NodePath.layer);

it.layer(services)("pending publish state", (it) => {
  it.effect("a stale clear cannot delete a replacement installed between check and unlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-publish-race-" });
      const config = ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STATE_DIR: root }));
      const state = yield* State.make.pipe(Effect.provide(config));
      yield* state.lockPublish(apiUrl, pending("K1"), root);
      let replaced = false;
      const delayed = yield* State.make.pipe(
        Effect.provide(config),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          remove: (file, options) =>
            Effect.gen(function* () {
              if (!replaced) {
                replaced = true;
                yield* state.forgetPendingPublish(apiUrl, "K1", root);
                yield* state.lockPublish(apiUrl, pending("K2"), root);
              }
              return yield* fs.remove(file, options);
            })
        })
      );
      yield* delayed.forgetPendingPublish(apiUrl, "K1", root);
      assert.deepStrictEqual(
        Option.map(
          yield* state.readPendingPublish(apiUrl, root),
          (attempt) => attempt.request.publishKey
        ),
        Option.some("K2")
      );
      yield* state.forgetPendingPublish(apiUrl, "K2", root);
      assert.isTrue(Option.isNone(yield* state.readPendingPublish(apiUrl, root)));
    }).pipe(Effect.scoped)
  );

  it.effect("repo attempts do not need a writable global state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-publish-local-" });
      const unavailable = path.join(root, "not-a-directory");
      yield* fs.writeFileString(unavailable, "leave me alone");
      const state = yield* State.make.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STATE_DIR: unavailable }))
        )
      );
      yield* state.lockPublish(apiUrl, pending("local"), root);
      assert.deepStrictEqual(
        Option.map(
          yield* state.readPendingPublish(apiUrl, root),
          (attempt) => attempt.request.publishKey
        ),
        Option.some("local")
      );
      yield* state.forgetPendingPublish(apiUrl, "local", root);
      assert.strictEqual(yield* fs.readFileString(unavailable), "leave me alone");
    }).pipe(Effect.scoped)
  );
});
