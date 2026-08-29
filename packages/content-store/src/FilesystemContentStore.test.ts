import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ContentStore from "./ContentStore.js";
import * as FilesystemContentStore from "./FilesystemContentStore.js";

/** The store rooted in a temp directory that goes with the layer's scope. */
const storeInTempDir = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-content-store-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: dir })))
    );
  })
).pipe(Layer.provide(NodeFileSystem.layer));

it.layer(Layer.merge(storeInTempDir, NodePath.layer))("FilesystemContentStore", (it) => {
  it.effect("stores and reads an object back", () =>
    Effect.gen(function* () {
      const service = yield* ContentStore.ContentStore;
      yield* service.put("patches/abc/versions/one.html", "<h1>hi</h1>");
      assert.strictEqual(yield* service.get("patches/abc/versions/one.html"), "<h1>hi</h1>");
    })
  );

  it.effect("deletes idempotently and reports a missing object by its key", () =>
    Effect.gen(function* () {
      const service = yield* ContentStore.ContentStore;
      const key = "patches/abc/versions/gone.html";
      yield* service.put(key, "<h1>hi</h1>");
      yield* service.delete(key);
      yield* service.delete(key);
      const missing = yield* service.get(key).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "ObjectNotFound");
      assert.strictEqual(missing.key, key);
    })
  );

  it.effect("refuses a key that would leave the root", () =>
    Effect.gen(function* () {
      const service = yield* ContentStore.ContentStore;
      const escaped = yield* service.put("../escape.html", "<h1>bad</h1>").pipe(Effect.flip);
      assert.strictEqual(escaped._tag, "InvalidObjectKey");
      assert.strictEqual(escaped.key, "../escape.html");
      assert.strictEqual((yield* service.get("").pipe(Effect.flip))._tag, "InvalidObjectKey");
    })
  );
});
