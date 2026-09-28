import { randomUUID } from "node:crypto";
import { assert, type Vitest } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ContentStore from "../src/ContentStore.js";

/** Track exact keys so failed listing tests cannot prevent cleanup or delete unrelated objects. */
const testObjects = Effect.gen(function* () {
  const store = yield* ContentStore.ContentStore;
  const prefix = `content-store-contract/${randomUUID()}/`;
  const keys = new Set<string>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach(keys, (key) => store.delete(key), {
      concurrency: 16,
      discard: true
    }).pipe(Effect.orDie)
  );
  return {
    store,
    prefix,
    key: (name: string) => {
      const key = `${prefix}${name}`;
      keys.add(key);
      return key;
    }
  };
});

export const contentStoreContract = (
  it: Pick<Vitest.MethodsNonLive<ContentStore.ContentStore>, "effect">
) => {
  it.effect("preserves binary bytes, including a view into a larger buffer", () =>
    Effect.gen(function* () {
      const { store, key } = yield* testObjects;
      const objectKey = key("binary");
      const bytes = new Uint8Array([42, 0, 255, 254, 128, 13, 10, 195, 169, 42]);
      yield* store.putBytes(objectKey, bytes.subarray(1, -1));
      assert.deepStrictEqual(
        Array.from(yield* store.getBytes(objectKey)),
        [0, 255, 254, 128, 13, 10, 195, 169]
      );
    })
  );

  it.effect("preserves UTF-8 text and its leading byte-order mark", () =>
    Effect.gen(function* () {
      const { store, key } = yield* testObjects;
      const objectKey = key("unicode.html");
      yield* store.put(objectKey, "\uFEFF<p>café 日本語</p>");
      assert.strictEqual(yield* store.get(objectKey), "\uFEFF<p>café 日本語</p>");
      assert.deepStrictEqual(
        Array.from((yield* store.getBytes(objectKey)).subarray(0, 3)),
        [239, 187, 191]
      );
    })
  );

  it.effect("stores empty text and empty bytes as existing objects", () =>
    Effect.gen(function* () {
      const { store, key } = yield* testObjects;
      const textKey = key("empty.html");
      const bytesKey = key("empty.bin");
      yield* store.put(textKey, "");
      yield* store.putBytes(bytesKey, new Uint8Array());
      assert.strictEqual(yield* store.get(textKey), "");
      assert.deepStrictEqual(Array.from(yield* store.getBytes(textKey)), []);
      assert.strictEqual(yield* store.get(bytesKey), "");
      assert.deepStrictEqual(Array.from(yield* store.getBytes(bytesKey)), []);
    })
  );

  it.effect("replaces existing content across text and binary writes", () =>
    Effect.gen(function* () {
      const { store, key } = yield* testObjects;
      const objectKey = key("replacement");
      yield* store.put(objectKey, "the original content is longer");
      yield* store.putBytes(objectKey, new Uint8Array([0, 255]));
      assert.deepStrictEqual(Array.from(yield* store.getBytes(objectKey)), [0, 255]);
      yield* store.put(objectKey, "new");
      assert.strictEqual(yield* store.get(objectKey), "new");
      assert.deepStrictEqual(Array.from(yield* store.getBytes(objectKey)), [110, 101, 119]);
    })
  );

  it.effect("deletes idempotently and reports absent text and bytes by key", () =>
    Effect.gen(function* () {
      const { store, key } = yield* testObjects;
      const objectKey = key("deleted");
      yield* store.delete(objectKey);
      yield* store.put(objectKey, "present");
      yield* store.delete(objectKey);
      yield* store.delete(objectKey);
      for (const read of [
        store.get(objectKey).pipe(Effect.asVoid),
        store.getBytes(objectKey).pipe(Effect.asVoid)
      ]) {
        const missing = yield* read.pipe(Effect.flip);
        assert.strictEqual(missing._tag, "ObjectNotFound");
        assert.strictEqual(missing.key, objectKey);
      }
    })
  );

  it.effect("lists nested and partial prefixes with actual modification timestamps", () =>
    Effect.gen(function* () {
      const { store, key, prefix } = yield* testObjects;
      const first = key("listing/nested/one");
      const second = key("listing/nested/two");
      const other = key("other/three");
      const before = Date.now();
      yield* store.put(first, "one");
      yield* store.put(second, "two");
      yield* store.put(other, "three");
      const objects = yield* store.list(`${prefix}listing/`).pipe(Stream.runCollect);
      const after = Date.now();
      assert.deepStrictEqual(objects.map((object) => object.key).sort(), [first, second]);
      for (const object of objects) {
        assert.isTrue(Number.isFinite(object.lastModified));
        // S3 timestamps have second precision; live servers may have minor clock skew.
        assert.isAtLeast(object.lastModified, before - 60_000);
        assert.isAtMost(object.lastModified, after + 60_000);
      }
      assert.deepStrictEqual(
        (yield* store.list(`${prefix}listing/nested/o`).pipe(Stream.runCollect)).map(
          (object) => object.key
        ),
        [first]
      );
      yield* store.delete(first);
      assert.deepStrictEqual(
        (yield* store.list(`${prefix}listing/`).pipe(Stream.runCollect)).map(
          (object) => object.key
        ),
        [second]
      );
      assert.deepStrictEqual(yield* store.list(`${prefix}absent/`).pipe(Stream.runCollect), []);
    })
  );

  it.effect("rejects empty and NUL object keys for every operation", () =>
    Effect.gen(function* () {
      const store = yield* ContentStore.ContentStore;
      const prefix = `content-store-contract/${randomUUID()}/`;
      for (const key of ["", `${prefix}invalid\0key`]) {
        const operations = [
          store.put(key, "invalid"),
          store.putBytes(key, new Uint8Array([1])),
          store.get(key).pipe(Effect.asVoid),
          store.getBytes(key).pipe(Effect.asVoid),
          store.delete(key)
        ];
        for (const operation of operations) {
          const invalid = yield* operation.pipe(Effect.flip);
          assert.strictEqual(invalid._tag, "InvalidObjectKey");
          assert.strictEqual(invalid.key, key);
        }
      }
      const nulPrefix = `${prefix}invalid\0`;
      const invalid = yield* store.list(nulPrefix).pipe(Stream.runCollect, Effect.flip);
      assert.strictEqual(invalid._tag, "InvalidObjectKey");
      assert.strictEqual(invalid.key, nulPrefix);
    })
  );

  it.effect(
    "lists every object beyond a single S3 page without duplicates",
    () =>
      Effect.gen(function* () {
        const { store, key, prefix } = yield* testObjects;
        const keys = Array.from({ length: 1005 }, (_, index) =>
          key(`pages/${String(index).padStart(4, "0")}`)
        );
        yield* Effect.forEach(keys, (key) => store.put(key, "page"), {
          concurrency: 16,
          discard: true
        });
        yield* store.put(key("outside-pages"), "not in this listing");
        const listed = yield* store.list(`${prefix}pages/`).pipe(Stream.runCollect);
        assert.deepStrictEqual(listed.map((object) => object.key).sort(), keys);
      }),
    180_000
  );
};
