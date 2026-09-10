import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FilePage } from "@patchy/api";
import { CompanyDatabases } from "@patchy/company-database";
import { ContentStore } from "@patchy/content-store";
import { Binding } from "@patchy/runtime";
import * as Files from "./Files.js";
import { companyId, services, setup } from "./test/files.js";

const decodePage = Schema.decodeUnknownEffect(FilePage);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it.layer(services)("Files / real Postgres and filesystem", (it) => {
  it.effect(
    "round-trips 20 MiB as binary and refuses one more byte without replacing it",
    () =>
      Effect.gen(function* () {
        const { put, get, list } = yield* setup("fileboundary");
        const bytes = new Uint8Array(20 * 1024 * 1024).fill(255);
        bytes[0] = 0;
        bytes[1] = 128;
        yield* put("binary/data.bin", bytes);
        const result = yield* get("binary/data.bin");
        assert.strictEqual(result.contentType, "application/octet-stream");
        assert.strictEqual(digest(result.bytes), digest(bytes));
        const page = yield* list().pipe(Effect.flatMap(decodePage));
        assert.strictEqual(page.files[0]!.size, bytes.byteLength);
        assert.strictEqual(
          (yield* put("binary/data.bin", new Uint8Array(bytes.byteLength + 1)).pipe(Effect.flip))
            .code,
          "too_large"
        );
        assert.strictEqual(digest((yield* get("binary/data.bin")).bytes), digest(bytes));
      }),
    60_000
  );

  it.effect("retains the previous pointer and bytes after an object-store write failure", () =>
    Effect.gen(function* () {
      const { put, get, binding } = yield* setup("filewritebad");
      const original = new Uint8Array([0, 255, 10, 128]);
      yield* put("keep.bin", original);
      const content = yield* ContentStore.ContentStore;
      const cause = new Error("injected storage outage");
      const fault = Layer.succeed(
        ContentStore.ContentStore,
        ContentStore.ContentStore.of({
          ...content,
          putBytes: (key) =>
            Effect.fail(new ContentStore.StoreUnavailable({ operation: "put", key, cause }))
        })
      );
      const handlers = yield* Files.make.pipe(Effect.provide(fault));
      const failure = yield* handlers["files.put"]
        .run({ store: "docs", name: "keep.bin", contentType: "text/html" }, new Uint8Array([1]))
        .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip);
      assert.strictEqual(failure.code, "source_unavailable");
      const stored = yield* get("keep.bin");
      assert.deepStrictEqual(stored.bytes, original);
      assert.strictEqual(stored.contentType, "application/octet-stream");
    })
  );

  it.effect(
    "serializes concurrent puts and put/delete without mismatched or dangling pointers",
    () =>
      Effect.gen(function* () {
        const { put, get, remove, databases, binding } = yield* setup("fileputraces");
        const candidates = [new Uint8Array(8193).fill(19), new Uint8Array(16385).fill(251)];
        yield* Effect.all(
          candidates.map((bytes) => put("same.bin", bytes)),
          { concurrency: "unbounded" }
        );
        const readPointer = databases.withCompany(companyId)(
          Effect.gen(function* () {
            const sql = yield* CompanyDatabases.CompanyConnection;
            return yield* sql<{
              objectId: string;
              size: string;
              sha256: string;
            }>`SELECT object_id AS "objectId", size::text AS size, sha256
        FROM patchy.files WHERE patch_id = ${binding.patchId} AND store = 'docs' AND name = 'same.bin'`;
          })
        );
        const [row] = yield* readPointer;
        const result = yield* get("same.bin");
        assert.strictEqual(Number(row!.size), result.bytes.byteLength);
        assert.strictEqual(row!.sha256, digest(result.bytes));
        assert.include(candidates.map(digest), row!.sha256);
        const content = yield* ContentStore.ContentStore;
        const objects = yield* content
          .list(`files/${binding.patchId}/docs/`)
          .pipe(Stream.runCollect);
        assert.strictEqual(objects.length, 2);
        assert.strictEqual(new Set(objects.map((object) => object.key)).size, 2);
        for (const object of objects) {
          assert.include(candidates.map(digest), digest(yield* content.getBytes(object.key)));
        }
        yield* Effect.all([put("same.bin", new Uint8Array([1, 2, 3])), remove("same.bin")], {
          concurrency: "unbounded"
        });
        const remaining = yield* readPointer;
        if (remaining.length === 0) {
          assert.strictEqual((yield* get("same.bin").pipe(Effect.flip)).code, "invalid_request");
        } else {
          const bytes = (yield* get("same.bin")).bytes;
          assert.deepStrictEqual(bytes, new Uint8Array([1, 2, 3]));
          assert.strictEqual(Number(remaining[0]!.size), bytes.byteLength);
          assert.strictEqual(remaining[0]!.sha256, digest(bytes));
        }
      }),
    60_000
  );

  it.effect("pages literal prefixes by name and binds cursors to patch, store and prefix", () =>
    Effect.gen(function* () {
      const { put, list } = yield* setup("filelistpage");
      const names = [
        "folder/%_one",
        "folder/%_two",
        "folder/XXthree",
        "folder/sub/a",
        "other/file"
      ];
      for (const name of names) yield* put(name, new Uint8Array([1]), "image/svg+xml");
      const first = yield* list({ prefix: "folder/%_", limit: 1 }).pipe(Effect.flatMap(decodePage));
      assert.deepStrictEqual(
        first.files.map((file) => file.name),
        ["folder/%_one"]
      );
      assert.strictEqual(first.files[0]!.contentType, "image/svg+xml");
      assert.strictEqual(first.files[0]!.size, 1);
      assert.isString(first.files[0]!.updatedAt);
      assert.isString(first.cursor);
      const second = yield* list({ prefix: "folder/%_", limit: 1, cursor: first.cursor! }).pipe(
        Effect.flatMap(decodePage)
      );
      assert.deepStrictEqual(
        second.files.map((file) => file.name),
        ["folder/%_two"]
      );
      assert.isNull(second.cursor);
      for (const args of [
        { prefix: "folder/", cursor: first.cursor! },
        { store: "images", prefix: "folder/%_", cursor: first.cursor! },
        { cursor: "not-a-cursor" }
      ]) {
        assert.strictEqual((yield* list(args).pipe(Effect.flip)).code, "invalid_cursor");
      }
      const other = yield* setup("filelistelse");
      assert.strictEqual(
        (yield* other.list({ prefix: "folder/%_", cursor: first.cursor! }).pipe(Effect.flip)).code,
        "invalid_cursor"
      );
      const all = yield* list({ prefix: "folder/", limit: 10 }).pipe(Effect.flatMap(decodePage));
      assert.deepStrictEqual(
        all.files.map((file) => file.name),
        names.slice(0, 4)
      );
    })
  );

  it.effect(
    "rejects malformed names, enforces configured bounds and deletes only the row idempotently",
    () =>
      Effect.gen(function* () {
        const { put, get, remove, binding } = yield* setup("filenamecase");
        for (const name of [
          "",
          "a/../b",
          "a/./b",
          "/a",
          "a//b",
          "x".repeat(513),
          "é".repeat(257),
          "nul\u0000"
        ]) {
          assert.strictEqual(
            (yield* put(name, new Uint8Array()).pipe(Effect.flip)).code,
            "invalid_request"
          );
        }
        yield* put("é".repeat(256), new Uint8Array([0]));
        const bounded = yield* Files.make.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                PATCHY_RUNTIME_FILE_BYTES: "2",
                PATCHY_FILE_DEFAULT_PAGE: "1",
                PATCHY_FILE_MAX_PAGE: "2"
              })
            )
          )
        );
        assert.strictEqual(
          (yield* bounded["files.put"]
            .run({ store: "docs", name: "a", contentType: "text/plain" }, new Uint8Array(3))
            .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip)).code,
          "too_large"
        );
        assert.strictEqual(
          (yield* bounded["files.list"]
            .run({ store: "docs", limit: 3 })
            .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip)).code,
          "too_large"
        );
        yield* put("remove.bin", new Uint8Array([9]));
        const content = yield* ContentStore.ContentStore;
        const before = yield* content
          .list(`files/${binding.patchId}/docs/`)
          .pipe(Stream.runCollect);
        yield* remove("remove.bin");
        yield* remove("remove.bin");
        assert.strictEqual((yield* get("remove.bin").pipe(Effect.flip)).code, "invalid_request");
        const after = yield* content.list(`files/${binding.patchId}/docs/`).pipe(Stream.runCollect);
        assert.deepStrictEqual(
          after.map((object) => object.key).sort(),
          before.map((object) => object.key).sort()
        );
      })
  );

  it.effect(
    "omitting a store denies that version without destroying files reachable from an older version",
    () =>
      Effect.gen(function* () {
        const { put, get, handlers, binding, databases, tables, platform } =
          yield* setup("fileversions");
        const html = new TextEncoder().encode(
          "<script>parent.postMessage('not executed', '*')</script>"
        );
        yield* put("active.html", html, "text/html");
        const omitted = { ...binding.manifest, files: {} };
        yield* platform.withTransaction(
          Effect.gen(function* () {
            yield* platform`SELECT id FROM patches WHERE id = ${binding.patchId} FOR UPDATE`;
            yield* databases.withCompany(companyId)(
              databases.withPatchLock(binding.patchId)(tables.provision(binding.patchId, omitted))
            );
          })
        );
        const newer = { ...binding, versionId: "ver_bbbbbbbbbbbbbbbbbbbbbbbb", manifest: omitted };
        assert.strictEqual(
          (yield* handlers["files.get"]
            .run({ store: "docs", name: "active.html" })
            .pipe(Effect.provideService(Binding.Binding, newer), Effect.flip)).code,
          "invalid_request"
        );
        const original = yield* get("active.html");
        assert.deepStrictEqual(original, { bytes: html, contentType: "text/html" });
        // Selecting another stored version changes only the binding, never the object namespace.
        const rollback = { ...binding, versionId: "ver_cccccccccccccccccccccccc" };
        assert.deepStrictEqual(
          yield* handlers["files.get"]
            .run({ store: "docs", name: "active.html" })
            .pipe(Effect.provideService(Binding.Binding, rollback)),
          original
        );
      })
  );
});
