import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import * as SqlTesting from "@patchy/sql/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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

    if (name === "Postgres") {
      it.effect(
        "preserves an old object referenced after the batch scan by a concurrent publisher",
        () =>
          Effect.gen(function* () {
            yield* TestClock.setTime(NOW);
            const platform = yield* SqlClient.SqlClient;
            const companies = yield* CompanyDatabases.CompanyDatabases;
            const inventory = yield* Inventory.Inventory;
            const store = yield* ContentStore.ContentStore;
            const fs = yield* FileSystem.FileSystem;
            const root = yield* FilesystemContentStore.rootDir;
            const patchId = "sweep_reference_race";
            const key = `files/${patchId}/docs/old`;
            yield* companies.ensureReady(COMPANY);
            yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name, expires_at)
            VALUES (${patchId}, ${COMPANY}, 'usr_dev', 'Race', 'sweep-reference-race', '2040-01-01')`;
            yield* companies.withCompany(COMPANY)(
              companies.withPatchLock(patchId)(
                Effect.gen(function* () {
                  yield* inventory.ensurePatch(patchId);
                  yield* inventory.putStore({ patchId, name: "docs" });
                })
              )
            );
            yield* store.put(key, "newly referenced bytes");
            yield* fs.utimes(`${root}/${key}`, (NOW - 2 * DAY) / 1_000, (NOW - 2 * DAY) / 1_000);

            const publisherLocked = yield* Deferred.make<void>();
            const indexScanned = yield* Deferred.make<void>();
            const published = yield* Deferred.make<void>();
            let listing = false;
            // Pause after the real company reference query returns its snapshot.
            // The publisher uses separate real Postgres transactions, not fake refs.
            const observed = Layer.merge(
              Layer.succeed(CompanyDatabases.CompanyDatabases, {
                ...companies,
                withCompany: (companyId) => (effect) =>
                  companies
                    .withCompany(companyId)(effect)
                    .pipe(
                      Effect.tap(() =>
                        listing
                          ? Deferred.succeed(indexScanned, undefined).pipe(
                              Effect.andThen(Deferred.await(published))
                            )
                          : Effect.void
                      )
                    )
              }),
              Layer.succeed(ContentStore.ContentStore, {
                ...store,
                list: (prefix) =>
                  Stream.suspend(() => {
                    listing = true;
                    return store.list(prefix);
                  })
              })
            );
            const sweeper = yield* OrphanSweep.make.pipe(Effect.provide(observed));
            const publisher = yield* platform
              .withTransaction(
                Effect.gen(function* () {
                  yield* platform`SELECT id FROM patches WHERE id = ${patchId} FOR UPDATE`;
                  yield* Deferred.succeed(publisherLocked, undefined);
                  yield* Deferred.await(indexScanned);
                  yield* companies.withCompany(COMPANY)(
                    companies.withPatchLock(patchId)(
                      Effect.gen(function* () {
                        const { sql } = yield* CompanyDatabases.PatchLock;
                        yield* sql`INSERT INTO patchy.files (patch_id, store, name, object_id, size, content_type, sha256)
                      VALUES (${patchId}, 'docs', 'report.txt', 'old', 22, 'text/plain', 'hash')`;
                      })
                    )
                  );
                })
              )
              .pipe(
                Effect.tap(() => Deferred.succeed(published, undefined)),
                Effect.forkScoped
              );
            yield* Deferred.await(publisherLocked);
            const result = yield* sweeper.sweep;
            yield* Fiber.join(publisher);
            assert.strictEqual(result.failed, 0);
            assert.strictEqual(yield* store.get(key), "newly referenced bytes");
          }).pipe(Effect.scoped)
      );
    }
  });
}

it.layer(Layer.merge(Testing.layer({ maxBackends: 4 }), filesystem))(
  "OrphanSweep retained pool pressure",
  (it) => {
    it.effect(
      "waits past the idle TTL and finishes scans larger than the retained pool budget",
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const platform = yield* SqlClient.SqlClient;
          const companies = yield* CompanyDatabases.CompanyDatabases;
          const store = yield* ContentStore.ContentStore;
          const fs = yield* FileSystem.FileSystem;
          const root = yield* FilesystemContentStore.rootDir;
          yield* platform`INSERT INTO companies (id, handle, name)
          VALUES ('sweep_pool_a', 'sweep-pool-a', 'Pool A'), ('sweep_pool_b', 'sweep-pool-b', 'Pool B')`;
          for (const companyId of ["sweep_pool_a", "sweep_pool_b"]) {
            yield* companies.ensureReady(companyId);
          }
          const key = "files/absent_pool_patch/docs/old";
          yield* store.put(key, "reclaim after every index responds");
          yield* fs.utimes(`${root}/${key}`, (NOW - 2 * DAY) / 1_000, (NOW - 2 * DAY) / 1_000);
          const busy = yield* Queue.unbounded<void>();
          let admitted = 0;
          const observed = Layer.succeed(CompanyDatabases.CompanyDatabases, {
            ...companies,
            withCompany: (companyId) => (effect) =>
              companies
                .withCompany(companyId)(effect)
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      admitted += 1;
                    })
                  ),
                  Effect.tapError((error) =>
                    error._tag === "Busy" ? Queue.offer(busy, undefined) : Effect.void
                  )
                )
          });
          const sweeper = yield* OrphanSweep.make.pipe(Effect.provide(observed));
          const running = yield* sweeper.sweep.pipe(Effect.forkScoped);
          // Two pools against one retained slot is the same pressure as 51 against
          // the default 50 slots. Namespace and file-index scans each turn pools over.
          for (let pause = 0; pause < 3; pause += 1) {
            yield* Queue.take(busy);
            const before = admitted;
            yield* TestClock.adjust("60 seconds");
            assert.strictEqual(admitted, before, "the background retry waits the full 61 seconds");
            assert.strictEqual(yield* store.get(key), "reclaim after every index responds");
            yield* TestClock.adjust("1 second");
          }
          assert.deepStrictEqual(yield* Fiber.join(running), {
            namespacesDeleted: 0,
            filesDeleted: 1,
            failed: 0
          });
          assert.strictEqual((yield* store.get(key).pipe(Effect.flip))._tag, "ObjectNotFound");
        }).pipe(Effect.scoped)
    );
  }
);

it.layer(Layer.merge(Testing.layer(), filesystem))(
  "OrphanSweep persistent admission pressure",
  (it) => {
    it.effect(
      "retries persistent admission pressure only once per company before deferring work",
      () =>
        Effect.gen(function* () {
          const companies = yield* CompanyDatabases.CompanyDatabases;
          yield* companies.ensureReady(COMPANY);
          const placements = yield* companies.listReady;
          const attempts = yield* Queue.unbounded<void>();
          const unavailable = Layer.succeed(CompanyDatabases.CompanyDatabases, {
            ...companies,
            withCompany: () => () =>
              Queue.offer(attempts, undefined).pipe(
                Effect.andThen(
                  Effect.fail(new CompanyDatabases.Busy({ resource: "backend budget", limit: 4 }))
                )
              )
          });
          const sweeper = yield* OrphanSweep.make.pipe(Effect.provide(unavailable));
          const running = yield* sweeper.sweep.pipe(Effect.forkScoped);
          for (let index = 0; index < placements.length; index++) {
            yield* Queue.take(attempts);
            yield* TestClock.adjust("61 seconds");
            yield* Queue.take(attempts);
          }
          assert.deepStrictEqual(yield* Fiber.join(running), {
            namespacesDeleted: 0,
            filesDeleted: 0,
            failed: placements.length
          });
        }).pipe(Effect.scoped)
    );
  }
);
