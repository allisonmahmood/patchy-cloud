import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { contentStoreContract } from "../test/ContentStoreContract.js";
import * as ContentStore from "./ContentStore.js";
import * as FilesystemContentStore from "./FilesystemContentStore.js";

/** The store rooted in a temp directory that goes with the layer's scope. */
const storeInTempDir = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-content-store-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provideMerge(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: dir }))
      )
    );
  })
).pipe(Layer.provideMerge(NodeFileSystem.layer));

it.layer(Layer.merge(storeInTempDir, NodePath.layer))("FilesystemContentStore", (it) => {
  contentStoreContract(it);

  it.effect("refuses a key that would leave the root", () =>
    Effect.gen(function* () {
      const service = yield* ContentStore.ContentStore;
      const escaped = yield* service.put("../escape.html", "<h1>bad</h1>").pipe(Effect.flip);
      assert.strictEqual(escaped._tag, "InvalidObjectKey");
      assert.strictEqual(escaped.key, "../escape.html");
      assert.strictEqual(
        (yield* service.putBytes("../escape", new Uint8Array([1])).pipe(Effect.flip))._tag,
        "InvalidObjectKey"
      );
    })
  );

  it.effect("uses filesystem modification times and rejects escaping list prefixes", () =>
    Effect.gen(function* () {
      const service = yield* ContentStore.ContentStore;
      yield* service.put("files/listing/store/one", "one");
      const fs = yield* FileSystem.FileSystem;
      const root = yield* FilesystemContentStore.rootDir;
      yield* fs.utimes(`${root}/files/listing/store/one`, 123456789, 123456789);
      assert.deepStrictEqual(yield* service.list("files/listing/").pipe(Stream.runCollect), [
        { key: "files/listing/store/one", lastModified: 123456789000 }
      ]);
      assert.strictEqual(
        (yield* service.list("../").pipe(Stream.runCollect, Effect.flip))._tag,
        "InvalidObjectKey"
      );
    })
  );

  it.effect("keeps listing past an object deleted after it was enumerated", () =>
    Effect.gen(function* () {
      const service = yield* ContentStore.ContentStore;
      const keys = ["a", "b", "c", "d", "e"].map((name) => `files/overlap/store/${name}`);
      yield* Effect.forEach(keys, (key) => service.put(key, key));
      // One directory's entries are enumerated together, so every other key is
      // already enumerated by the time the first is listed.
      const survivorBeside = (first: string) => (first === keys[0] ? keys[1] : keys[0]);
      const listed = yield* service.list("files/overlap/").pipe(
        Stream.zipWithIndex,
        Stream.tap(([object, index]) =>
          index === 0
            ? Effect.forEach(
                keys.filter((key) => key !== object.key && key !== survivorBeside(object.key)),
                service.delete
              )
            : Effect.void
        ),
        Stream.map(([object]) => object.key),
        Stream.runCollect
      );
      assert.deepStrictEqual(listed.toSorted(), [listed[0], survivorBeside(listed[0]!)].sort());
    })
  );
});
