import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import * as SqlTesting from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CompanyDatabases from "./CompanyDatabases.js";
import * as Inventory from "./Inventory.js";
import * as OrphanSweep from "./OrphanSweep.js";
import * as PgliteCompanyDatabases from "./PgliteCompanyDatabases.js";
import * as Testing from "./testing.js";

const NOW = Date.UTC(2035, 0, 3);
const DAY = 24 * 60 * 60 * 1_000;
const COMPANY = "cmp_dev";

const filesystem = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-company-orphans-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provideMerge(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: root }))
      )
    );
  })
).pipe(Layer.provideMerge(NodeFileSystem.layer));

const pglite = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-orphans-pglite-" });
    return Layer.merge(
      Inventory.layer,
      PgliteCompanyDatabases.layer({ companyId: COMPANY, dataDir })
    );
  })
).pipe(Layer.provide(NodeFileSystem.layer), Layer.provideMerge(SqlTesting.layer()));

for (const [name, database] of [
  ["Postgres", Testing.layer()],
  ["PGlite", pglite]
] as const) {
  const services = OrphanSweep.layer.pipe(Layer.provideMerge(Layer.merge(database, filesystem)));

  it.layer(services)(`OrphanSweep (${name})`, (it) => {
    it.effect(
      "drops old orphan namespaces and their inventory, but preserves live and young namespaces",
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const platform = yield* SqlClient.SqlClient;
          const companies = yield* CompanyDatabases.CompanyDatabases;
          const inventory = yield* Inventory.Inventory;
          const sweeper = yield* OrphanSweep.OrphanSweep;
          yield* companies.ensureReady(COMPANY);
          yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name, expires_at)
        VALUES ('sweep_live', ${COMPANY}, 'usr_dev', 'Live', 'sweep-live', '2040-01-01')`;
          yield* companies.withCompany(COMPANY)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              for (const patchId of ["sweep_live", "sweep_orphan", "sweep_young"]) {
                yield* companies.withPatchLock(patchId)(inventory.ensurePatch(patchId));
              }
              yield* companies.withPatchLock("sweep_orphan")(
                Effect.gen(function* () {
                  yield* sql.unsafe('CREATE TABLE "p_sweep_orphan"."notes" (value text)');
                  yield* inventory.putTable({
                    patchId: "sweep_orphan",
                    name: "notes",
                    shared: false
                  });
                  yield* inventory.putStore({ patchId: "sweep_orphan", name: "documents" });
                })
              );
              yield* sql`UPDATE patchy.patches SET created_at = '2035-01-01'
          WHERE patch_id IN ('sweep_live', 'sweep_orphan')`;
              yield* sql`UPDATE patchy.patches SET created_at = '2035-01-02T12:00:00Z'
          WHERE patch_id = 'sweep_young'`;
            })
          );

          yield* sweeper.sweep;
          yield* companies.withCompany(COMPANY)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const remaining = yield* sql<{
                namespace: string;
              }>`SELECT nspname AS namespace FROM pg_namespace
          WHERE nspname IN ('p_sweep_live', 'p_sweep_orphan', 'p_sweep_young') ORDER BY nspname`;
              assert.deepStrictEqual(
                remaining.map((row) => row.namespace),
                ["p_sweep_live", "p_sweep_young"]
              );
              assert.strictEqual(yield* inventory.read("sweep_orphan"), null);
              assert.deepStrictEqual(
                yield* sql`SELECT * FROM patchy.stores WHERE patch_id = 'sweep_orphan'`,
                []
              );
            })
          );
          const live = yield* platform`SELECT id FROM patches WHERE id = 'sweep_live'`;
          assert.deepStrictEqual(live, [{ id: "sweep_live" }]);
        })
    );

    it.effect(
      "waits a full day after first observing an untracked namespace, across sweep instances",
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const companies = yield* CompanyDatabases.CompanyDatabases;
          const sweeper = yield* OrphanSweep.OrphanSweep;
          yield* companies.ensureReady(COMPANY);
          const namespace = 'p_untracked."quoted';
          yield* companies.withCompany(COMPANY)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe(`CREATE SCHEMA ${Inventory.quoteIdentifier(namespace)}`);
            })
          );
          yield* sweeper.sweep;
          yield* TestClock.adjust(DAY);
          // Reconstructing the service must retain the persisted first-seen age.
          const restarted = yield* OrphanSweep.make;
          yield* restarted.sweep;
          yield* companies.withCompany(COMPANY)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              assert.deepStrictEqual(
                yield* sql`SELECT nspname FROM pg_namespace WHERE nspname = ${namespace}`,
                [{ nspname: namespace }]
              );
            })
          );
          yield* TestClock.adjust(1);
          yield* restarted.sweep;
          yield* companies.withCompany(COMPANY)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              assert.deepStrictEqual(
                yield* sql`SELECT nspname FROM pg_namespace WHERE nspname = ${namespace}`,
                []
              );
            })
          );
        })
    );

    it.effect(
      "keeps referenced and young files, and reclaims old objects even without patch inventory",
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const platform = yield* SqlClient.SqlClient;
          const companies = yield* CompanyDatabases.CompanyDatabases;
          const inventory = yield* Inventory.Inventory;
          const sweeper = yield* OrphanSweep.OrphanSweep;
          const store = yield* ContentStore.ContentStore;
          const fs = yield* FileSystem.FileSystem;
          const root = yield* FilesystemContentStore.rootDir;
          yield* companies.ensureReady(COMPANY);
          yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name, expires_at)
        VALUES ('sweep_files', ${COMPANY}, 'usr_dev', 'Files', 'sweep-files', '2040-01-01')`;
          yield* companies.withCompany(COMPANY)(
            companies.withPatchLock("sweep_files")(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                yield* inventory.ensurePatch("sweep_files");
                yield* inventory.putStore({ patchId: "sweep_files", name: "docs" });
                yield* sql`INSERT INTO patchy.files (patch_id, store, name, object_id, size, content_type, sha256)
          VALUES ('sweep_files', 'docs', 'report.txt', 'referenced', 5, 'text/plain', 'hash')`;
              })
            )
          );
          const referenced = "files/sweep_files/docs/referenced";
          const orphan = "files/no_patch_or_inventory/docs/orphan";
          const young = "files/no_patch_or_inventory/docs/young";
          const boundary = "files/no_patch_or_inventory/docs/boundary";
          for (const [key, time] of [
            [referenced, NOW - 2 * DAY],
            [orphan, NOW - 2 * DAY],
            [young, NOW - DAY / 2],
            [boundary, NOW - DAY]
          ] as const) {
            yield* store.put(key, "bytes");
            yield* fs.utimes(`${root}/${key}`, time / 1_000, time / 1_000);
          }
          yield* sweeper.sweep;
          assert.strictEqual(yield* store.get(referenced), "bytes");
          assert.strictEqual(yield* store.get(young), "bytes");
          assert.strictEqual(yield* store.get(boundary), "bytes");
          assert.strictEqual((yield* store.get(orphan).pipe(Effect.flip))._tag, "ObjectNotFound");
        })
    );

    it.effect("fails closed when a ready company's file index is unavailable", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const companies = yield* CompanyDatabases.CompanyDatabases;
        const sweeper = yield* OrphanSweep.OrphanSweep;
        const store = yield* ContentStore.ContentStore;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* FilesystemContentStore.rootDir;
        yield* companies.ensureReady(COMPANY);
        const key = "files/unavailable_index/docs/old";
        yield* store.put(key, "keep until absence is proven");
        yield* fs.utimes(`${root}/${key}`, (NOW - 2 * DAY) / 1_000, (NOW - 2 * DAY) / 1_000);
        yield* companies.withCompany(COMPANY)(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`ALTER TABLE patchy.files RENAME TO unavailable_files`;
          })
        );
        yield* Effect.gen(function* () {
          const result = yield* sweeper.sweep;
          assert.isAbove(result.failed, 0);
          assert.strictEqual(yield* store.get(key), "keep until absence is proven");
        }).pipe(
          Effect.ensuring(
            companies
              .withCompany(COMPANY)(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql`ALTER TABLE patchy.unavailable_files RENAME TO files`;
                })
              )
              .pipe(Effect.orDie)
          )
        );
        yield* sweeper.sweep;
        assert.strictEqual((yield* store.get(key).pipe(Effect.flip))._tag, "ObjectNotFound");
      })
    );
  });
}
