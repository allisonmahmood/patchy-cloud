import { NodeFileSystem } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CURRENT_RELEASE, Manifest, WIRE_VERSION } from "@patchy/api";
import { CompanyDatabases } from "@patchy/company-database";
import * as Testing from "@patchy/company-database/testing";
import { FilesystemContentStore } from "@patchy/content-store";
import { Binding } from "@patchy/runtime";
import * as Files from "../Files.js";
import * as Tables from "../Tables.js";

export const companyId = "cmp_dev";
export const versionId = "ver_aaaaaaaaaaaaaaaaaaaaaaaa";
export const manifest: typeof Manifest.Type = {
  manifestVersion: 1,
  release: CURRENT_RELEASE,
  name: "file-test",
  tier: 0,
  tables: {},
  files: { docs: {}, images: {} },
  uses: {}
};
export const filesystem = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-files-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: root })))
    );
  })
).pipe(Layer.provideMerge(NodeFileSystem.layer));
export const services = Layer.merge(
  filesystem,
  Tables.layer.pipe(Layer.provideMerge(Testing.layer()))
);
export const setup = Effect.fn("test.files.setup")(function* (patchId: string) {
  const platform = yield* SqlClient.SqlClient;
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name, expires_at)
    VALUES (${patchId}, ${companyId}, 'usr_dev', 'File test', ${patchId}, '2040-01-01')`;
  yield* databases.ensureReady(companyId);
  yield* platform.withTransaction(
    Effect.gen(function* () {
      yield* platform`SELECT id FROM patches WHERE id = ${patchId} FOR UPDATE`;
      yield* databases.withCompany(companyId)(
        databases.withPatchLock(patchId)(tables.provision(patchId, manifest))
      );
    })
  );
  const handlers = yield* Files.make;
  const binding = Binding.Binding.of({
    patchId,
    companyId,
    versionId,
    manifest,
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
  return { platform, databases, tables, handlers, binding, put, get, list, remove };
});
