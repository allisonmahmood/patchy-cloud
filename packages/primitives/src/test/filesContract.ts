import { createHash } from "node:crypto";
import { NodeFileSystem } from "@effect/platform-node";
import { assert } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import {
  CURRENT_RELEASE,
  FileMetadata,
  FilePage,
  Manifest,
  sharedStoreId,
  Upload,
  WIRE_VERSION
} from "@patchy/api";
import * as WideEvents from "@patchy/analytics/wide-events";
import { CompanyDatabases, Inventory, OrphanSweep } from "@patchy/company-database";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { ContractLimits, OperatingLimits } from "@patchy/limits";
import { Binding, LoadedVersions } from "@patchy/runtime";
import * as Files from "../Files.js";
import * as Tables from "../Tables.js";

const decodePage = Schema.decodeUnknownEffect(FilePage);
const decodeMetadata = Schema.decodeUnknownEffect(Schema.NullOr(FileMetadata));
const decodeUpload = Schema.decodeUnknownEffect(Upload);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const manifest: typeof Manifest.Type = {
  manifestVersion: 1,
  release: CURRENT_RELEASE,
  name: "file-test",
  tier: 0,
  tables: {},
  files: {
    docs: { description: "Documents identified by file name." },
    images: { description: "Images identified by file name." }
  },
  uses: {}
};
export const filesystem = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-files-contract-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: root })))
    );
  })
).pipe(Layer.provideMerge(NodeFileSystem.layer));

export const setup = Effect.fn("test.filesContract.setup")(function* (
  companyId: string,
  patchId: string,
  definition: typeof Manifest.Type = manifest
) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    databases.withPatchLock(patchId)(tables.provision(patchId, definition))
  );
  const handlers = yield* Files.makeLocal;
  const binding = Binding.Binding.of({
    patchId,
    companyId,
    versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
    manifest: definition,
    wireVersion: WIRE_VERSION,
    scope: "company",
    identity: null,
    principal: null,
    correlationId: "files-contract"
  });
  const put = (
    name: string,
    bytes: Uint8Array,
    contentType = "application/octet-stream",
    store = "docs"
  ) =>
    handlers["files.put"]
      .run({ store, name, contentType }, bytes)
      .pipe(Effect.provideService(Binding.Binding, binding));
  const get = (name: string, store = "docs") =>
    handlers["files.get"]
      .run({ store, name })
      .pipe(Effect.provideService(Binding.Binding, binding));
  const list = (args: { store?: string; prefix?: string; cursor?: string; limit?: number } = {}) =>
    handlers["files.list"]
      .run({ store: "docs", ...args })
      .pipe(Effect.provideService(Binding.Binding, binding));
  const remove = (name: string) =>
    handlers["files.delete"]
      .run({ store: "docs", name })
      .pipe(Effect.provideService(Binding.Binding, binding));
  const readPointer = (name: string) =>
    databases.withCompany(companyId)(
      Effect.flatMap(
        CompanyDatabases.CompanyConnection,
        (sql) => sql<{
          objectId: string;
          size: string;
          sha256: string;
          contentType: string;
          updatedAt: string;
        }>`SELECT object_id AS "objectId", size::text AS size, sha256,
          content_type AS "contentType", updated_at::text AS "updatedAt"
          FROM patchy.files WHERE patch_id = ${patchId} AND store = 'docs' AND name = ${name}`
      )
    );
  return { databases, tables, handlers, binding, put, get, list, remove, readPointer };
});

const binaryBoundaryContract = Effect.fn("test.filesContract.binaryBoundary")(function* (
  companyId: string
) {
  const { put, get, list } = yield* setup(companyId, "fileboundary");
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
    (yield* put("binary/data.bin", new Uint8Array(bytes.byteLength + 1)).pipe(Effect.flip)).code,
    "too_large"
  );
  assert.strictEqual(digest((yield* get("binary/data.bin")).bytes), digest(bytes));
});

const metadataCapContract = Effect.fn("test.filesContract.metadataCap")(function* (
  companyId: string
) {
  const { put, binding } = yield* setup(companyId, "filelistcaps");
  yield* put("one", new Uint8Array([1]), "text/plain; note=" + "x".repeat(256));
  const handlers = yield* Files.makeLocal.pipe(
    Effect.provideService(ContractLimits.overrides, { "runtime.result.bytes": 128 })
  );
  const failure = yield* handlers["files.list"]
    .run({ store: "docs" })
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip);
  assert.strictEqual(failure.code, "too_large");
});

const storageFailureContract = Effect.fn("test.filesContract.storageFailure")(function* (
  companyId: string
) {
  const { put, get, binding, databases, readPointer } = yield* setup(companyId, "filewritebad");
  const original = new Uint8Array([0, 255, 10, 128]);
  yield* put("keep.bin", original);
  const previous = yield* readPointer("keep.bin");
  const inventory = yield* Inventory.Inventory;
  const before = yield* databases.withCompany(companyId)(inventory.read(binding.patchId));
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
  const handlers = yield* Files.makeLocal.pipe(Effect.provide(fault));
  const failure = yield* handlers["files.put"]
    .run({ store: "docs", name: "keep.bin", contentType: "text/html" }, new Uint8Array([1]))
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip);
  assert.strictEqual(failure.code, "source_unavailable");
  assert.deepStrictEqual(yield* readPointer("keep.bin"), previous);
  const after = yield* databases.withCompany(companyId)(inventory.read(binding.patchId));
  assert.strictEqual(after?.stores[0]?.resourceRevision, before?.stores[0]?.resourceRevision);
  const stored = yield* get("keep.bin");
  assert.deepStrictEqual(stored.bytes, original);
  assert.strictEqual(stored.contentType, "application/octet-stream");
});

const concurrentWritesContract = Effect.fn("test.filesContract.concurrentWrites")(function* (
  companyId: string
) {
  const { put, get, remove, binding, databases, readPointer } = yield* setup(
    companyId,
    "fileputraces"
  );
  const candidates = [new Uint8Array(8193).fill(19), new Uint8Array(16385).fill(251)];
  yield* Effect.all(
    candidates.map((bytes) => put("same.bin", bytes)),
    { concurrency: "unbounded" }
  );
  const [row] = yield* readPointer("same.bin");
  const result = yield* get("same.bin");
  assert.strictEqual(Number(row!.size), result.bytes.byteLength);
  assert.strictEqual(row!.sha256, digest(result.bytes));
  assert.include(candidates.map(digest), row!.sha256);
  const content = yield* ContentStore.ContentStore;
  const objects = yield* content.list(`files/${binding.patchId}/`).pipe(Stream.runCollect);
  assert.strictEqual(objects.length, 2);
  assert.strictEqual(new Set(objects.map((object) => object.key)).size, 2);
  for (const object of objects) {
    assert.include(candidates.map(digest), digest(yield* content.getBytes(object.key)));
  }
  yield* Effect.all([put("same.bin", new Uint8Array([1, 2, 3])), remove("same.bin")], {
    concurrency: "unbounded"
  });
  const remaining = yield* readPointer("same.bin");
  if (remaining.length === 0) {
    assert.strictEqual((yield* get("same.bin").pipe(Effect.flip)).code, "invalid_request");
  } else {
    const bytes = (yield* get("same.bin")).bytes;
    assert.deepStrictEqual(bytes, new Uint8Array([1, 2, 3]));
    assert.strictEqual(Number(remaining[0]!.size), bytes.byteLength);
    assert.strictEqual(remaining[0]!.sha256, digest(bytes));
  }
  const inventory = yield* Inventory.Inventory;
  const snapshot = yield* databases.withCompany(companyId)(inventory.read(binding.patchId));
  assert.strictEqual(
    snapshot?.stores.find((store) => store.name === "docs")?.resourceRevision,
    "4"
  );
  assert.strictEqual(
    snapshot?.stores.find((store) => store.name === "images")?.resourceRevision,
    "0"
  );
});

const paginationContract = Effect.fn("test.filesContract.pagination")(function* (
  companyId: string
) {
  const { put, list } = yield* setup(companyId, "filelistpage");
  const names = ["folder/%_one", "folder/%_two", "folder/XXthree", "folder/sub/a", "other/file"];
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
  const other = yield* setup(companyId, "filelistelse");
  assert.strictEqual(
    (yield* other.list({ prefix: "folder/%_", cursor: first.cursor! }).pipe(Effect.flip)).code,
    "invalid_cursor"
  );
  const all = yield* list({ prefix: "folder/", limit: 10 }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(
    all.files.map((file) => file.name),
    names.slice(0, 4)
  );
});

const namesAndDeletionContract = Effect.fn("test.filesContract.namesAndDeletion")(function* (
  companyId: string
) {
  const { put, get, remove, binding } = yield* setup(companyId, "filenamecase");
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
  const bounded = yield* Files.makeLocal.pipe(
    Effect.provideService(ContractLimits.overrides, { "runtime.file.bytes": 2 }),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
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
  const before = yield* content.list(`files/${binding.patchId}/`).pipe(Stream.runCollect);
  yield* remove("remove.bin");
  yield* remove("remove.bin");
  assert.strictEqual((yield* get("remove.bin").pipe(Effect.flip)).code, "invalid_request");
  const after = yield* content.list(`files/${binding.patchId}/`).pipe(Stream.runCollect);
  assert.deepStrictEqual(
    after.map((object) => object.key).sort(),
    before.map((object) => object.key).sort()
  );
});

const versionRetentionContract = Effect.fn("test.filesContract.versionRetention")(function* (
  companyId: string
) {
  const { put, get, handlers, binding, databases, tables } = yield* setup(
    companyId,
    "fileversions"
  );
  const html = new TextEncoder().encode("<script>parent.postMessage('not executed', '*')</script>");
  yield* put("active.html", html, "text/html");
  const omitted = { ...binding.manifest, files: {} };
  yield* databases.withCompany(companyId)(
    databases.withPatchLock(binding.patchId)(tables.provision(binding.patchId, omitted))
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
});

const wrongLockContract = Effect.fn("test.filesContract.wrongLock")(function* (companyId: string) {
  const { databases, put, get, binding, readPointer } = yield* setup(companyId, "filewronglock");
  const original = new Uint8Array([0, 255, 128, 10]);
  yield* put("keep.bin", original, "image/png");
  const previous = yield* readPointer("keep.bin");
  const wrongLock = Layer.succeed(
    CompanyDatabases.CompanyDatabases,
    CompanyDatabases.CompanyDatabases.of({
      ...databases,
      withFileLock: (patchId, store, name) => (effect) =>
        databases.withFileLock(
          patchId,
          store,
          name
        )(
          Effect.flatMap(CompanyDatabases.FileLock, (lock) =>
            Effect.provideService(effect, CompanyDatabases.FileLock, {
              ...lock,
              patchId: "another-patch"
            })
          )
        )
    })
  );
  const handlers = yield* Files.makeLocal.pipe(Effect.provide(wrongLock));
  for (const mutation of [
    handlers["files.put"].run(
      { store: "docs", name: "keep.bin", contentType: "text/html" },
      new Uint8Array([1, 2, 3])
    ),
    handlers["files.delete"].run({ store: "docs", name: "keep.bin" })
  ]) {
    const result = yield* mutation.pipe(
      Effect.provideService(Binding.Binding, binding),
      Effect.exit
    );
    assert.isTrue(Exit.isFailure(result) && Cause.hasDies(result.cause));
    assert.deepStrictEqual(yield* readPointer("keep.bin"), previous);
    assert.deepStrictEqual(yield* get("keep.bin"), { bytes: original, contentType: "image/png" });
  }
});

const blobIoContract = Effect.fn("test.filesContract.blobIo")(function* (companyId: string) {
  for (const operation of ["put", "get"] as const) {
    const { put, get, list, remove, binding } = yield* setup(companyId, `fileblob${operation}`);
    const original = new Uint8Array([0, 255, 128]);
    const pending = new Uint8Array([3, 4, 5, 6]);
    const replacement = new Uint8Array([10, 11]);
    yield* put("paused.bin", original, "image/png");
    const content = yield* ContentStore.ContentStore;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let arrivals = 0;
    // Four paused calls would exhaust the real Postgres company's four operation leases.
    const pause = Effect.gen(function* () {
      if (++arrivals === 4) yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
    });
    const paused = Layer.succeed(
      ContentStore.ContentStore,
      ContentStore.ContentStore.of({
        ...content,
        ...(operation === "put"
          ? {
              putBytes: (key: string, bytes: Uint8Array) =>
                pause.pipe(Effect.andThen(content.putBytes(key, bytes)))
            }
          : { getBytes: (key: string) => pause.pipe(Effect.andThen(content.getBytes(key))) })
      })
    );
    const handlers = yield* Files.makeLocal.pipe(Effect.provide(paused));
    const running = yield* Effect.all(
      Array.from({ length: 4 }, () =>
        (operation === "put"
          ? handlers["files.put"].run(
              { store: "docs", name: "paused.bin", contentType: "text/plain" },
              pending
            )
          : handlers["files.get"].run({ store: "docs", name: "paused.bin" })
        ).pipe(Effect.provideService(Binding.Binding, binding))
      ),
      { concurrency: "unbounded" }
    ).pipe(Effect.forkScoped);
    yield* Effect.gen(function* () {
      yield* Deferred.await(entered);
      yield* put("unrelated.bin", replacement);
      assert.deepStrictEqual((yield* get("unrelated.bin")).bytes, replacement);
      const page = yield* list().pipe(Effect.flatMap(decodePage));
      assert.deepStrictEqual(
        page.files.map((file) => file.name),
        ["paused.bin", "unrelated.bin"]
      );
      yield* remove("unrelated.bin");
      assert.strictEqual((yield* get("unrelated.bin").pipe(Effect.flip)).code, "invalid_request");
      // The paused name's lock is free too; a get retains its old immutable pointer, not the lock.
      assert.deepStrictEqual(yield* get("paused.bin"), {
        bytes: original,
        contentType: "image/png"
      });
      yield* put("paused.bin", replacement, "text/html");
      assert.deepStrictEqual(yield* get("paused.bin"), {
        bytes: replacement,
        contentType: "text/html"
      });
    }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    const results = yield* Fiber.join(running);
    if (operation === "get") {
      assert.deepStrictEqual(
        results,
        Array.from({ length: 4 }, () => ({ bytes: original, contentType: "image/png" }))
      );
      assert.deepStrictEqual(yield* get("paused.bin"), {
        bytes: replacement,
        contentType: "text/html"
      });
    } else {
      assert.deepStrictEqual(yield* get("paused.bin"), {
        bytes: pending,
        contentType: "text/plain"
      });
    }
  }
}, Effect.scoped);

const sharedStoreContract = Effect.fn("test.filesContract.sharedStore")(function* (
  companyId: string
) {
  const source = yield* setup(companyId, "sharedfilesource", {
    ...manifest,
    tier: 2,
    files: { docs: { description: "Shared documents", shared: true } }
  });
  const bytes = new Uint8Array([0, 128, 255]);
  yield* source.put("folder/a.bin", bytes);
  yield* source.put("folder/b.bin", new Uint8Array([1]));
  const declaration = {
    kind: "sharedStore" as const,
    patchId: source.binding.patchId,
    store: "docs",
    id: sharedStoreId(source.binding.patchId, "docs"),
    revision: 1
  };
  const consumer = yield* setup(companyId, "sharedfilereader", {
    ...manifest,
    tier: 1,
    files: {},
    uses: { documents: declaration, alternate: declaration }
  });
  const identity = {
    user: { id: "usr_reader", name: "Reader", email: "reader@example.test" },
    company: { id: companyId, handle: "company", name: "Company" },
    admin: false
  };
  let live = true;
  let sourceCompany = companyId;
  const handlers = yield* Files.makeLocal.pipe(
    Effect.provideService(LoadedVersions.LoadedVersions, {
      find: (patchId) =>
        Effect.sync(() =>
          live && patchId === source.binding.patchId
            ? Option.some({ ...source.binding, companyId: sourceCompany, patchTier: 2 })
            : Option.none()
        )
    })
  );
  let binding: Binding.Binding["Service"] = { ...consumer.binding, identity };
  const call = (
    op: "shared.files.list" | "shared.files.stat" | "shared.files.get",
    args: unknown
  ) => handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
  const first = yield* call("shared.files.list", {
    alias: "documents",
    prefix: "folder/",
    limit: 1
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(
    first.files.map((file) => file.name),
    ["folder/a.bin"]
  );
  assert.isString(first.cursor);
  const second = yield* call("shared.files.list", {
    alias: "alternate",
    prefix: "folder/",
    limit: 1,
    cursor: first.cursor
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(
    second.files.map((file) => file.name),
    ["folder/b.bin"]
  );
  assert.strictEqual(second.cursor, null);
  assert.deepStrictEqual(
    yield* call("shared.files.stat", { alias: "documents", name: "folder/a.bin" }),
    first.files[0]
  );
  assert.deepStrictEqual(
    yield* call("shared.files.get", { alias: "documents", name: "folder/a.bin" }),
    { bytes, contentType: "application/octet-stream" }
  );
  const inventory = yield* Inventory.Inventory;
  const sharing = (shared: boolean) =>
    source.databases.withCompany(companyId)(
      source.databases.withPatchLock(source.binding.patchId)(
        inventory.putStore({
          patchId: source.binding.patchId,
          name: "docs",
          description: "Documents",
          shared
        })
      )
    );
  const denied = Effect.gen(function* () {
    for (const [op, args] of [
      ["shared.files.list", { alias: "documents", prefix: "folder/", cursor: first.cursor }],
      ["shared.files.stat", { alias: "documents", name: "folder/a.bin" }],
      ["shared.files.get", { alias: "documents", name: "folder/a.bin" }]
    ] as const) {
      assert.propertyVal(yield* call(op, args).pipe(Effect.flip), "code", "access_denied");
    }
  });
  yield* sharing(false);
  yield* denied;
  yield* sharing(true);
  assert.deepStrictEqual(
    yield* call("shared.files.get", { alias: "documents", name: "folder/a.bin" }),
    { bytes, contentType: "application/octet-stream" }
  );
  live = false;
  yield* denied;
  live = true;
  sourceCompany = "another-company";
  yield* denied;
  sourceCompany = companyId;
  binding = { ...binding, identity: null };
  yield* denied;
  binding = { ...binding, identity };
  assert.deepStrictEqual(
    yield* call("shared.files.stat", { alias: "documents", name: "folder/a.bin" }),
    first.files[0]
  );
  binding = { ...binding, manifest: { ...binding.manifest, tier: 2 } };
  const selected = yield* call("shared.files.list", { alias: "documents" }).pipe(
    Effect.flatMap(decodePage)
  );
  const handle = selected.files[0]!.handle!;
  assert.strictEqual(handle.length, 57);
  assert.deepStrictEqual(
    yield* call("shared.files.stat", { alias: "alternate", name: "folder/a.bin" }),
    selected.files[0]
  );
  const redeem = handlers["files.redeem"]
    .run({ handle })
    .pipe(Effect.provideService(Binding.Binding, binding));
  assert.deepStrictEqual(yield* redeem, {
    bytes,
    contentType: "application/octet-stream",
    name: "folder/a.bin"
  });
  yield* sharing(false);
  assert.propertyVal(yield* redeem.pipe(Effect.flip), "code", "access_denied");
  yield* source.put("folder/a.bin", new Uint8Array([2]));
  assert.propertyVal(yield* redeem.pipe(Effect.flip), "code", "not_found");
  yield* sharing(true);
  const replacement = yield* call("shared.files.stat", {
    alias: "documents",
    name: "folder/a.bin"
  }).pipe(Effect.flatMap(decodeMetadata));
  assert.notStrictEqual(replacement!.handle, handle);
  const fresh = handlers["files.redeem"]
    .run({ handle: replacement!.handle })
    .pipe(Effect.provideService(Binding.Binding, binding));
  assert.deepStrictEqual((yield* fresh).bytes, new Uint8Array([2]));
  live = false;
  assert.propertyVal(yield* fresh.pipe(Effect.flip), "code", "access_denied");
  live = true;
  assert.deepStrictEqual((yield* fresh).bytes, new Uint8Array([2]));
});

const handlesContract = Effect.fn("test.filesContract.handles")(function* (companyId: string) {
  const fixture = yield* setup(companyId, "filehandles", { ...manifest, tier: 2 });
  const identity = {
    user: { id: "usr_selected", name: "Selected viewer", email: "selected@example.test" },
    company: { id: companyId, handle: "company", name: "Company" },
    admin: false
  };
  const binding = { ...fixture.binding, identity, principal: { userId: identity.user.id } };
  const name = "folder/雪 % report.svg";
  const bytes = new Uint8Array([0, 255, 128]);
  yield* fixture.put(name, bytes, "image/svg+xml");
  const page = yield* fixture.handlers["files.list"]
    .run({ store: "docs" })
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodePage));
  const handle = page.files[0]!.handle!;
  assert.strictEqual(handle.length, 57);
  const stat = yield* fixture.handlers["files.stat"]
    .run({ store: "docs", name })
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodeMetadata));
  assert.deepStrictEqual(stat, page.files[0]);
  yield* fixture.databases.withCompany(companyId)(Inventory.initialize);
  yield* fixture.databases.withCompany(companyId)(Inventory.initialize);
  const restarted = yield* Files.makeLocal;
  const again = yield* restarted["files.list"].run({ store: "docs" }).pipe(
    Effect.provideService(Binding.Binding, {
      ...binding,
      invocationId: "inv_nested",
      effectivePrincipal: binding.patchId,
      correlationId: "nested-call"
    })
  );
  assert.deepStrictEqual(again, page);
  const redeem = (selected: string, current = binding) =>
    restarted["files.redeem"]
      .run({ handle: selected })
      .pipe(Effect.provideService(Binding.Binding, current));
  assert.deepStrictEqual(yield* redeem(handle), { bytes, contentType: "image/svg+xml", name });
  for (const current of [
    { ...binding, identity: { ...identity, user: { ...identity.user, id: "another-viewer" } } },
    { ...binding, patchId: "another-patch" },
    { ...binding, versionId: "ver_bbbbbbbbbbbbbbbbbbbbbbbb" }
  ]) {
    assert.propertyVal(yield* redeem(handle, current).pipe(Effect.flip), "code", "access_denied");
  }
  for (const forged of [
    "",
    `${"0".repeat(24)}${handle.slice(24)}`,
    `${handle.slice(0, 25)}${handle[25] === "A" ? "B" : "A"}${handle.slice(26)}`
  ]) {
    assert.propertyVal(yield* redeem(forged).pipe(Effect.flip), "code", "access_denied");
  }
  yield* fixture.put(name, bytes, "image/svg+xml");
  assert.propertyVal(yield* redeem(handle).pipe(Effect.flip), "code", "not_found");
  const replaced = yield* restarted["files.stat"]
    .run({ store: "docs", name })
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodeMetadata));
  assert.notStrictEqual(replaced!.handle, handle);
  assert.deepStrictEqual(yield* redeem(replaced!.handle!), {
    bytes,
    contentType: "image/svg+xml",
    name
  });
  yield* fixture.remove(name);
  assert.propertyVal(yield* redeem(replaced!.handle!).pipe(Effect.flip), "code", "not_found");

  yield* fixture.put("one", bytes);
  const bounded = yield* Files.makeLocal.pipe(
    Effect.provideService(ContractLimits.overrides, { "runtime.result.bytes": 170 })
  );
  const tier1 = yield* bounded["files.list"]
    .run({ store: "docs" })
    .pipe(
      Effect.provideService(Binding.Binding, { ...binding, manifest: { ...manifest, tier: 1 } }),
      Effect.flatMap(decodePage)
    );
  assert.deepStrictEqual(
    tier1.files.map((file) => file.name),
    ["one"]
  );
  assert.notProperty(tier1.files[0], "handle");
  assert.propertyVal(
    yield* bounded["files.list"]
      .run({ store: "docs" })
      .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip),
    "code",
    "too_large"
  );
});

const stageOnlyContract = Effect.fn("test.filesContract.stageOnly")(function* (companyId: string) {
  const handlers = yield* Files.makeLocal;
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const inventory = yield* Inventory.Inventory;
  const binding = Binding.Binding.of({
    patchId: "filestageonly",
    companyId,
    versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
    manifest: { ...manifest, tier: 2, files: {} },
    wireVersion: WIRE_VERSION,
    scope: "company",
    identity: {
      user: { id: "stage-only-viewer", name: "Viewer", email: "viewer@example.test" },
      company: { id: companyId, handle: "company", name: "Company" },
      admin: false
    },
    principal: { userId: "stage-only-viewer" },
    correlationId: "stage-only"
  });
  const upload = yield* handlers["files.stage"]
    .run({ contentType: "text/plain" }, new Uint8Array([7]))
    .pipe(Effect.provideService(Binding.Binding, binding));
  assert.propertyVal(upload, "size", 1);
  assert.strictEqual(
    yield* databases.withCompany(companyId)(inventory.read(binding.patchId)),
    null
  );
  assert.propertyVal(
    yield* handlers["files.put"]
      .run({ store: "docs", name: "denied.txt", upload })
      .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip),
    "code",
    "invalid_request"
  );
  yield* handlers["files.discard"]
    .run({ upload })
    .pipe(Effect.provideService(Binding.Binding, binding));
});

const setupStaged = Effect.fn("test.filesContract.setupStaged")(function* (
  companyId: string,
  patchId: string
) {
  const fixture = yield* setup(companyId, patchId, { ...manifest, tier: 2 });
  const identity = {
    user: { id: "usr_staging", name: "Staging viewer", email: "staging@example.test" },
    company: { id: companyId, handle: "company", name: "Company" },
    admin: false
  };
  const binding = { ...fixture.binding, identity, principal: { userId: identity.user.id } };
  const stage = (bytes: Uint8Array, contentType = "text/plain") =>
    fixture.handlers["files.stage"]
      .run({ contentType }, bytes)
      .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodeUpload));
  const adopt = (upload: typeof Upload.Type, name = "adopted.txt") =>
    fixture.handlers["files.put"]
      .run({ store: "docs", name, upload })
      .pipe(Effect.provideService(Binding.Binding, binding));
  const discard = (upload: typeof Upload.Type) =>
    fixture.handlers["files.discard"]
      .run({ upload })
      .pipe(Effect.provideService(Binding.Binding, binding));
  return { ...fixture, binding, stage, adopt, discard };
});

const stagedLifecycleContract = Effect.fn("test.filesContract.stagedLifecycle")(function* (
  companyId: string
) {
  const fixture = yield* setupStaged(companyId, "filestaged");
  const bytes = new Uint8Array([0, 255, 128, 9]);
  const upload = yield* fixture.stage(bytes, "image/svg+xml");
  assert.deepStrictEqual(
    { size: upload.size, contentType: upload.contentType },
    { size: bytes.byteLength, contentType: "image/svg+xml" }
  );
  const content = yield* ContentStore.ContentStore;
  const objects = yield* content.list(`files/${fixture.binding.patchId}/`).pipe(Stream.runCollect);
  assert.lengthOf(objects, 1);
  assert.lengthOf(objects[0]!.key.split("/"), 3);
  assert.notInclude(upload.token, objects[0]!.key.split("/")[2]!);
  const replica = yield* Files.makeLocal;
  for (const current of [
    {
      ...fixture.binding,
      identity: {
        ...fixture.binding.identity,
        user: { ...fixture.binding.identity.user, id: "other-viewer" }
      }
    },
    { ...fixture.binding, patchId: "other-patch" },
    { ...fixture.binding, versionId: "ver_bbbbbbbbbbbbbbbbbbbbbbbb" }
  ]) {
    for (const operation of [
      replica["files.inspectUpload"].run({ upload }),
      replica["files.discard"].run({ upload }),
      replica["files.put"].run({ store: "docs", name: "forged.txt", upload })
    ])
      assert.propertyVal(
        yield* operation.pipe(Effect.provideService(Binding.Binding, current), Effect.flip),
        "code",
        "not_found"
      );
  }
  const forged = { ...upload, token: `${upload.token}x` };
  assert.propertyVal(yield* fixture.adopt(forged).pipe(Effect.flip), "code", "not_found");
  const metadataForgery = { ...upload, size: 999, contentType: "text/html" };
  assert.deepStrictEqual(
    yield* replica["files.inspectUpload"]
      .run({ upload: metadataForgery })
      .pipe(Effect.provideService(Binding.Binding, fixture.binding)),
    upload
  );
  yield* replica["files.put"]
    .run({ store: "images", name: "image.svg", upload: metadataForgery })
    .pipe(
      Effect.provideService(Binding.Binding, {
        ...fixture.binding,
        invocationId: "inv_second_action"
      })
    );
  assert.deepStrictEqual(yield* fixture.get("image.svg", "images"), {
    bytes,
    contentType: "image/svg+xml"
  });
  assert.deepStrictEqual(
    (yield* content.list(`files/${fixture.binding.patchId}/`).pipe(Stream.runCollect)).map(
      (object) => object.key
    ),
    objects.map((object) => object.key)
  );
  assert.propertyVal(yield* fixture.adopt(upload).pipe(Effect.flip), "code", "not_found");
  assert.propertyVal(yield* fixture.discard(upload).pipe(Effect.flip), "code", "not_found");
  const discarded = yield* fixture.stage(new Uint8Array([5]));
  yield* fixture.discard(discarded);
  assert.propertyVal(yield* fixture.adopt(discarded).pipe(Effect.flip), "code", "not_found");
  assert.deepStrictEqual(yield* fixture.get("image.svg", "images"), {
    bytes,
    contentType: "image/svg+xml"
  });
});

const stagedBoundsContract = Effect.fn("test.filesContract.stagedBounds")(function* (
  companyId: string
) {
  const fixture = yield* setupStaged(companyId, "filestagebounds");
  const byteLimit = yield* ContractLimits.get("files.stage.bytes");
  assert.propertyVal(
    yield* fixture.stage(new Uint8Array(byteLimit + 1)).pipe(Effect.flip),
    "limitId",
    "files.stage.bytes"
  );
  const boundary = yield* fixture.stage(new Uint8Array(byteLimit));
  yield* fixture.discard(boundary);
  const replica = yield* Files.makeLocal;
  const uploads: Array<typeof Upload.Type> = [];
  for (let index = 0; index < 15; index++)
    uploads.push(yield* fixture.stage(new Uint8Array([index])));
  const competing = yield* Effect.all(
    [
      fixture.stage(new Uint8Array([15])).pipe(Effect.result),
      replica["files.stage"]
        .run({ contentType: "text/plain" }, new Uint8Array([16]))
        .pipe(Effect.provideService(Binding.Binding, fixture.binding), Effect.result)
    ],
    { concurrency: "unbounded" }
  );
  assert.strictEqual(competing.filter((result) => result._tag === "Success").length, 1);
  const refused = competing.find((result) => result._tag === "Failure")!;
  assert.strictEqual(refused._tag, "Failure");
  if (refused._tag === "Failure")
    assert.propertyVal(refused.failure, "limitId", "files.stage.count");
  assert.propertyVal(
    yield* fixture.stage(new Uint8Array([17])).pipe(Effect.flip),
    "limitId",
    "files.stage.count"
  );
  yield* fixture.discard(uploads[0]!);
  const replacement = yield* fixture.stage(new Uint8Array([18]));
  yield* fixture.discard(replacement);
  for (const upload of uploads.slice(1)) yield* fixture.discard(upload);
  // Lower byte bounds exercise quota precedence without allocating a company's full allowance.
  const bounded = yield* Files.makeLocal.pipe(
    Effect.provideService(ContractLimits.overrides, {
      "files.stage.bytes": 4,
      "files.stage.viewerBytes": 5
    })
  );
  const stage = (bytes: Uint8Array, current = fixture.binding) =>
    bounded["files.stage"]
      .run({ contentType: "text/plain" }, bytes)
      .pipe(Effect.provideService(Binding.Binding, current));
  assert.propertyVal(
    yield* stage(new Uint8Array(5)).pipe(Effect.flip),
    "limitId",
    "files.stage.bytes"
  );
  const boundedUpload = yield* stage(new Uint8Array(4)).pipe(Effect.flatMap(decodeUpload));
  assert.propertyVal(
    yield* stage(new Uint8Array(1)).pipe(Effect.flip),
    "limitId",
    "files.stage.viewerBytes"
  );
  yield* fixture.discard(boundedUpload);
  for (const result of competing)
    if (result._tag === "Success") yield* fixture.discard(yield* decodeUpload(result.success));
});

const stagedRaceContract = Effect.fn("test.filesContract.stagedRace")(function* (
  companyId: string
) {
  const fixture = yield* setupStaged(companyId, "filestagerace");
  const replica = yield* Files.makeLocal;
  const bytes = new Uint8Array([3, 1, 4]);
  const upload = yield* fixture.stage(bytes);
  const [adoption, discard] = yield* Effect.all(
    [
      fixture.adopt(upload).pipe(Effect.result),
      replica["files.discard"]
        .run({ upload })
        .pipe(Effect.provideService(Binding.Binding, fixture.binding), Effect.result)
    ],
    { concurrency: "unbounded" }
  );
  if (adoption._tag === "Success") {
    assert.strictEqual(discard._tag, "Failure");
    if (discard._tag === "Failure") assert.propertyVal(discard.failure, "code", "not_found");
    assert.deepStrictEqual((yield* fixture.get("adopted.txt")).bytes, bytes);
  } else {
    assert.propertyVal(adoption.failure, "code", "not_found");
    assert.strictEqual(discard._tag, "Success");
    assert.deepStrictEqual(yield* fixture.readPointer("adopted.txt"), []);
  }
  assert.propertyVal(yield* fixture.adopt(upload).pipe(Effect.flip), "code", "not_found");
});

const stagedExpiryContract = Effect.fn("test.filesContract.stagedExpiry")(function* (
  companyId: string
) {
  const fixture = yield* setupStaged(companyId, "filestageexpiry");
  const expires = yield* fixture.stage(new Uint8Array([1]));
  const adopted = yield* fixture.stage(new Uint8Array([2]));
  yield* TestClock.adjust("3599999 millis");
  yield* fixture.adopt(adopted);
  yield* TestClock.adjust("1 millis");
  assert.propertyVal(yield* fixture.adopt(expires).pipe(Effect.flip), "code", "not_found");
  assert.propertyVal(yield* fixture.discard(expires).pipe(Effect.flip), "code", "not_found");
  assert.deepStrictEqual((yield* fixture.get("adopted.txt")).bytes, new Uint8Array([2]));
  const fresh = yield* fixture.stage(new Uint8Array([3]));
  yield* fixture.discard(fresh);
});

export const contracts = {
  "stages bytes without a declared store or patch namespace": stageOnlyContract,
  "adopts staged bytes without copying, restores authoritative metadata and rejects forged bindings":
    stagedLifecycleContract,
  "bounds stages atomically across replicas and frees consumed quota": stagedBoundsContract,
  "serializes adoption and discard so only one consumes a stage": stagedRaceContract,
  "expires stages at one hour without revoking adopted files": stagedExpiryContract,
  "binds deterministic handles to the selected viewer and document across replicas and replacements":
    handlesContract,
  "rechecks source sharing and liveness for metadata and bytes, and recovers unchanged consumers":
    sharedStoreContract,
  "round-trips 20 MiB as binary and refuses one more byte without replacing it":
    binaryBoundaryContract,
  "refuses metadata pages above the runtime result byte cap": metadataCapContract,
  "retains the previous pointer and bytes after an object-store write failure":
    storageFailureContract,
  "serializes concurrent puts and put/delete without mismatched or dangling pointers":
    concurrentWritesContract,
  "pages literal prefixes by name and binds cursors to patch, store and prefix": paginationContract,
  "rejects malformed names, enforces configured bounds and deletes only the row idempotently":
    namesAndDeletionContract,
  "omitting a store denies that version without destroying files reachable from an older version":
    versionRetentionContract,
  "rejects put and delete under a different patch's file lock without changing the indexed file":
    wrongLockContract,
  "releases company leases and name locks before blocked blob writes and reads": blobIoContract
};

export const independentNamesContract = Effect.fn("test.filesContract.independentNames")(function* (
  companyId: string
) {
  const { databases, put, get, list, remove, binding } = yield* setup(companyId, "fileindependent");
  const original = new Uint8Array([1]);
  const replacement = new Uint8Array([2, 3]);
  yield* put("held.bin", original);
  const locked = yield* Deferred.make<number>();
  const waiting = yield* Deferred.make<number>();
  const release = yield* Deferred.make<void>();
  const holder = yield* databases
    .withCompany(companyId)(
      databases.withFileLock(
        binding.patchId,
        "docs",
        "held.bin"
      )(
        Effect.gen(function* () {
          const { sql } = yield* CompanyDatabases.FileLock;
          const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
          yield* Deferred.succeed(locked, row!.pid);
          yield* Deferred.await(release);
        })
      )
    )
    .pipe(Effect.forkScoped);
  const holderPid = yield* Deferred.await(locked);
  const observed = Layer.succeed(
    CompanyDatabases.CompanyDatabases,
    CompanyDatabases.CompanyDatabases.of({
      ...databases,
      withFileLock: (patchId, store, name) => (effect) =>
        Effect.flatMap(CompanyDatabases.CompanyConnection, (sql) =>
          sql.withTransaction(
            sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.pipe(
              Effect.tap((rows) => Deferred.succeed(waiting, rows[0]!.pid)),
              Effect.andThen(databases.withFileLock(patchId, store, name)(effect))
            )
          )
        )
    })
  );
  const handlers = yield* Files.makeLocal.pipe(Effect.provide(observed));
  const writer = yield* handlers["files.put"]
    .run({ store: "docs", name: "held.bin", contentType: "text/plain" }, replacement)
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.forkScoped);
  yield* Effect.gen(function* () {
    const writerPid = yield* Deferred.await(waiting);
    assert.notStrictEqual(writerPid, holderPid);
    // Observe the real advisory-lock wait, not elapsed time or fiber scheduling.
    yield* databases.withCompany(companyId)(
      Effect.flatMap(CompanyDatabases.CompanyConnection, (sql) =>
        sql<{
          waiting: boolean;
        }>`SELECT ${holderPid} = ANY(pg_blocking_pids(${writerPid})) AS waiting`.pipe(
          Effect.repeat({ until: (rows) => rows[0]!.waiting })
        )
      )
    );
    yield* put("independent.bin", replacement);
    assert.deepStrictEqual((yield* get("independent.bin")).bytes, replacement);
    const page = yield* list().pipe(Effect.flatMap(decodePage));
    assert.deepStrictEqual(
      page.files.map((file) => [file.name, file.size]),
      [
        ["held.bin", original.byteLength],
        ["independent.bin", replacement.byteLength]
      ]
    );
    yield* remove("independent.bin");
    assert.strictEqual((yield* get("independent.bin").pipe(Effect.flip)).code, "invalid_request");
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  yield* Fiber.join(holder);
  yield* Fiber.join(writer);
  assert.deepStrictEqual(yield* get("held.bin"), { bytes: replacement, contentType: "text/plain" });
}, Effect.scoped);

export const lateStageSweepContract = Effect.fn("test.filesContract.lateStageSweep")(function* (
  companyId: string
) {
  const now = Date.UTC(2035, 0, 3);
  const platform = yield* SqlClient.SqlClient;
  const content = yield* ContentStore.ContentStore;
  for (const failDelete of [false, true]) {
    yield* TestClock.setTime(now);
    const patchId = failDelete ? "filelatestageretry" : "filelatestage";
    const fixture = yield* setupStaged(companyId, patchId);
    yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name)
      VALUES (${patchId}, ${companyId}, 'usr_dev', 'Late stage', ${patchId})`;
    const entered = yield* Deferred.make<string>();
    const release = yield* Deferred.make<void>();
    const deleted = yield* Deferred.make<void>();
    const acknowledgeDelete = yield* Deferred.make<void>();
    // Keep the blob inside the listing grace so a failed late cleanup must retain
    // its tombstone even when an older sweep DELETE has not acknowledged yet.
    const sweeper = yield* OrphanSweep.make.pipe(
      Effect.provideService(ContentStore.ContentStore, {
        ...content,
        list: (prefix) =>
          content.list(prefix).pipe(Stream.map((object) => ({ ...object, lastModified: now }))),
        delete: (key) =>
          content
            .delete(key)
            .pipe(
              Effect.tap(() =>
                failDelete
                  ? Deferred.succeed(deleted, undefined).pipe(
                      Effect.andThen(Deferred.await(acknowledgeDelete))
                    )
                  : Effect.void
              )
            )
      })
    );
    const paused = yield* Files.makeLocal.pipe(
      Effect.provideService(ContentStore.ContentStore, {
        ...content,
        putBytes: (key, bytes) =>
          Deferred.succeed(entered, key).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(content.putBytes(key, bytes))
          ),
        delete: failDelete
          ? (key) =>
              Effect.fail(
                new ContentStore.StoreUnavailable({
                  operation: "delete",
                  key,
                  cause: new Error("injected late cleanup deletion failure")
                })
              )
          : content.delete
      })
    );
    const writing = yield* paused["files.stage"]
      .run({ contentType: "application/octet-stream" }, new Uint8Array([8]))
      .pipe(
        Effect.provideService(Binding.Binding, fixture.binding),
        Effect.result,
        Effect.forkScoped
      );
    const key = yield* Deferred.await(entered);
    yield* TestClock.adjust("1 hour");
    const sweeping = yield* sweeper.sweep.pipe(Effect.forkScoped);
    if (failDelete) yield* Deferred.await(deleted);
    else yield* Fiber.join(sweeping);
    assert.propertyVal(yield* content.getBytes(key).pipe(Effect.flip), "_tag", "ObjectNotFound");
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(writing);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure")
      assert.propertyVal(result.failure, "code", failDelete ? "source_unavailable" : "not_found");
    if (failDelete) {
      yield* Deferred.succeed(acknowledgeDelete, undefined);
      yield* Fiber.join(sweeping);
      assert.deepStrictEqual(yield* content.getBytes(key), new Uint8Array([8]));
      yield* sweeper.sweep;
    }
    assert.propertyVal(yield* content.getBytes(key).pipe(Effect.flip), "_tag", "ObjectNotFound");
  }
}, Effect.scoped);

export const slowSweepDeleteContract = Effect.fn("test.filesContract.slowSweepDelete")(function* (
  companyId: string
) {
  const content = yield* ContentStore.ContentStore;
  const platform = yield* SqlClient.SqlClient;
  for (const expiredStage of [true, false]) {
    yield* TestClock.setTime(Date.UTC(2035, 0, 3));
    const patchId = expiredStage ? "fileslowstagegc" : "filesloworphangc";
    const fixture = yield* setupStaged(companyId, patchId);
    yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name)
      VALUES (${patchId}, ${companyId}, 'usr_dev', 'Slow file cleanup', ${patchId})`;
    const upload = expiredStage ? yield* fixture.stage(new Uint8Array([1])) : undefined;
    if (expiredStage) yield* TestClock.adjust("1 hour");
    else {
      yield* fixture.put("replace.bin", new Uint8Array([1]));
      yield* fixture.put("replace.bin", new Uint8Array([2]));
    }
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const sweeper = yield* OrphanSweep.make.pipe(
      Effect.provideService(ContentStore.ContentStore, {
        ...content,
        list: (prefix) =>
          content.list(prefix).pipe(
            Stream.map((object) => ({
              ...object,
              lastModified: object.key.startsWith(`files/${patchId}/`) ? 0 : object.lastModified
            }))
          ),
        delete: (key) =>
          key.startsWith(`files/${patchId}/`)
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(content.delete(key))
              )
            : content.delete(key)
      })
    );
    const sweeping = yield* sweeper.sweep.pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Effect.gen(function* () {
      // Blob deletion must not retain a lease or serialize unrelated file work.
      yield* fixture.put("unrelated.bin", new Uint8Array([3]));
      const next = yield* fixture.stage(new Uint8Array([4]));
      yield* fixture.adopt(next, "live.bin");
      assert.deepStrictEqual((yield* fixture.get("unrelated.bin")).bytes, new Uint8Array([3]));
      assert.deepStrictEqual((yield* fixture.get("live.bin")).bytes, new Uint8Array([4]));
      if (upload !== undefined)
        assert.propertyVal(yield* fixture.adopt(upload).pipe(Effect.flip), "code", "not_found");
      else assert.deepStrictEqual((yield* fixture.get("replace.bin")).bytes, new Uint8Array([2]));
    }).pipe(
      Effect.timeout("5 seconds"),
      TestClock.withLive,
      Effect.ensuring(Deferred.succeed(release, undefined))
    );
    assert.strictEqual((yield* Fiber.join(sweeping)).failed, 0);
  }
}, Effect.scoped);

export const companyStageBoundsContract = Effect.fn("test.filesContract.companyStageBounds")(
  function* (baseCompanyId: string) {
    const operating = yield* OperatingLimits.OperatingLimits;
    const companyId = `${baseCompanyId}_stage_limits`;
    const platform = yield* SqlClient.SqlClient;
    yield* platform`INSERT INTO companies (id, handle, name)
    VALUES (${companyId}, 'file-stage-limits', 'File stage limits')`;
    const limit = { companyId, limitId: "files.stage.companyBytes", actor: "stage-contract" };
    const fixture = yield* setupStaged(companyId, "filecompanybounds");
    const otherPatch = yield* setupStaged(companyId, "filecompanyboundstwo");
    const handlers = yield* Files.make;
    const records = yield* Queue.unbounded<WideEvents.WideEvent>();
    const events = yield* WideEvents.make.pipe(
      Effect.provideService(WideEvents.Sink, {
        write: (event) => Queue.offer(records, event).pipe(Effect.asVoid)
      })
    );
    const stage = (target: typeof fixture, bytes: Uint8Array) =>
      handlers["files.stage"]
        .run({ contentType: "text/plain" }, bytes)
        .pipe(
          Effect.provideService(Binding.Binding, target.binding),
          Effect.flatMap(Schema.decodeUnknownEffect(Upload))
        );
    const uploads: Array<{
      readonly upload: typeof Upload.Type;
      readonly discard: typeof fixture.discard;
    }> = [];
    yield* operating.setOverride({ ...limit, value: 8 });
    const initialLimit = yield* operating.get(limit);
    yield* Effect.gen(function* () {
      uploads.push({
        upload: yield* events.withEvent({ type: "request" }, stage(fixture, new Uint8Array(4))),
        discard: fixture.discard
      });
      assert.deepInclude((yield* Queue.take(records)).limits ?? [], {
        limitId: limit.limitId,
        value: 8,
        peak: 4,
        configRevision: initialLimit.configRevision
      });
      uploads.push({
        upload: yield* stage(otherPatch, new Uint8Array(4)),
        discard: otherPatch.discard
      });
      const full = yield* events
        .withEvent({ type: "request" }, stage(fixture, new Uint8Array(1)))
        .pipe(Effect.flip);
      const refusedEvent = yield* Queue.take(records);
      assert.isDefined(refusedEvent.limits);
      assert.deepInclude(refusedEvent.limits, {
        limitId: limit.limitId,
        value: 8,
        peak: 9,
        configRevision: initialLimit.configRevision
      });
      assert.deepInclude(refusedEvent.limits, {
        limitId: "files.stage.count",
        value: 16,
        peak: 2,
        configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
      });
      assert.deepInclude(refusedEvent.limits, {
        limitId: "files.stage.viewerBytes",
        value: 100 * 1024 * 1024,
        peak: 5,
        configRevision: { deploymentRevision: "contract", overrideRevision: "0" }
      });
      assert.propertyVal(full, "limitId", "files.stage.companyBytes");
      assert.propertyVal(full, "value", 8);
      // Existing handler instances must observe new company overrides on the next stage.
      yield* operating.setOverride({ ...limit, value: 16 });
      const updatedLimit = yield* operating.get(limit);
      uploads.push({ upload: yield* stage(fixture, new Uint8Array(8)), discard: fixture.discard });
      const changed = yield* events
        .withEvent({ type: "request" }, stage(otherPatch, new Uint8Array(1)))
        .pipe(Effect.flip);
      assert.deepInclude((yield* Queue.take(records)).limits ?? [], {
        limitId: limit.limitId,
        value: 16,
        peak: 17,
        configRevision: updatedLimit.configRevision
      });
      assert.propertyVal(changed, "limitId", "files.stage.companyBytes");
      assert.propertyVal(changed, "value", 16);
      const unavailable = yield* Files.make.pipe(
        Effect.provideService(OperatingLimits.OperatingLimits, {
          ...operating,
          get: () => Effect.fail(new OperatingLimits.CompanyNotFound({ companyId }))
        })
      );
      assert.propertyVal(
        yield* unavailable["files.stage"]
          .run({ contentType: "text/plain" }, new Uint8Array())
          .pipe(Effect.provideService(Binding.Binding, fixture.binding), Effect.flip),
        "code",
        "source_unavailable"
      );
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach(uploads, ({ upload, discard }) => discard(upload), { discard: true })
        ).pipe(Effect.ensuring(operating.removeOverride(limit).pipe(Effect.orDie)), Effect.orDie)
      )
    );
  }
);
