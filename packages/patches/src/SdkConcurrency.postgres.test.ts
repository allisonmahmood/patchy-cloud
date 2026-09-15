/** Real PostgreSQL only: the dedicated runner supplies the migrated, seeded template. */
import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { inject } from "vitest";
import { FilePage, Manifest, TablePage, TableRow } from "@patchy/api";
import { Analytics } from "@patchy/analytics";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { Files, TableOperations, Tables } from "@patchy/primitives";
import { Binding, LoadedVersions } from "@patchy/runtime";
import * as Content from "./Content.js";
import * as DeletionSweep from "./DeletionSweep.js";
import * as Patches from "./Patches.js";
import * as PatchLoadedVersions from "./LoadedVersions.js";
import * as Fixtures from "./test/fixtures.js";

const DAY = 24 * 60 * 60 * 1000;
const { admin, uploader, reader } = Fixtures.identities;
const owner = { userId: uploader.user.id, admin: false };
const administrator = { userId: admin.user.id, admin: true };
const decodePage = Schema.decodeUnknownEffect(TablePage);
const decodeRow = Schema.decodeUnknownEffect(TableRow);
const decodeFiles = Schema.decodeUnknownEffect(FilePage);
const definition: typeof Manifest.Type = {
  ...Fixtures.manifest,
  name: "sdk-concurrency",
  tier: 1,
  tables: {
    notes: {
      description: "Records keyed by id.",
      columns: { title: { kind: "text" }, slug: { kind: "text" } },
      indexes: { bySlug: { columns: ["slug"], unique: true } }
    }
  },
  files: { docs: { description: "Documents keyed by file name." } }
};

const filesystem = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-sdk-concurrency-" });
    return FilesystemContentStore.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_STORAGE_DIR: root })))
    );
  })
).pipe(Layer.provide(NodeFileSystem.layer));

const realPostgres = Layer.unwrap(
  Effect.sync(() => {
    const postgres = inject("postgres");
    assert.isDefined(postgres, "Real-Postgres concurrency requires test/postgres.ts global setup");
    assert.strictEqual(
      postgres.templateDatabase,
      "patchy_test_template",
      "Migrated test template required"
    );
    const url = new URL(postgres.adminUrl);
    assert.include(["postgres:", "postgresql:"], url.protocol, "PGlite cannot run this suite");
    assert.include(
      ["127.0.0.1", "localhost", "[::1]"],
      url.hostname,
      "Only the isolated local test cluster is allowed"
    );
    return Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [session] = yield* sql<{ version: string; database: string }>`
          SELECT version() AS version, current_database() AS database`;
        assert.match(session!.version, /^PostgreSQL /);
        assert.notMatch(session!.version, /pglite/i);
        assert.match(session!.database, /^patchy_test_/);
        assert.notStrictEqual(session!.database, postgres.templateDatabase);
      }).pipe(Effect.timeout("10 seconds"), TestClock.withLive)
    ).pipe(Layer.provideMerge(Fixtures.database));
  })
);

const services = Layer.mergeAll(Content.layer, PatchLoadedVersions.layer, DeletionSweep.layer).pipe(
  Layer.provideMerge(Patches.layer),
  Layer.provideMerge(Layer.mergeAll(realPostgres, filesystem, Analytics.layerNoop))
);

const publish = Effect.fn("SdkConcurrency.publish")(function* (
  manifest: typeof Manifest.Type,
  html: string,
  patchId: string | null = null,
  identity = uploader
) {
  const content = yield* Content.Content;
  return yield* content.publish({
    ...Fixtures.publishRecord(),
    manifest,
    patchId,
    companyId: identity.company.id,
    ownerUserId: identity.user.id,
    machineTokenId: identity.machine.id,
    title: manifest.name!,
    html,
    filename: null,
    repoOrg: null,
    repoName: null,
    cliVersion: null,
    gitBranch: null,
    gitCommitSha: null,
    sourceIp: null,
    userAgent: "real-postgres-concurrency"
  });
});

const bindingFor = Effect.fn("SdkConcurrency.bindingFor")(function* (
  patchId: string,
  versionId: string
) {
  const versions = yield* LoadedVersions.LoadedVersions;
  return Binding.Binding.of({
    ...Option.getOrThrow(yield* versions.find(patchId, versionId)),
    identity: null,
    principal: null,
    correlationId: "real-postgres-concurrency"
  });
});

const saveResources = Effect.fn("SdkConcurrency.saveResources")(function* (
  patchId: string,
  versionId: string
) {
  const binding = yield* bindingFor(patchId, versionId);
  const tables = yield* TableOperations.make;
  const files = yield* Files.make;
  const row = yield* tables["tables.insert"]
    .run({ table: "notes", row: { title: "retained note", slug: "retained-note" } })
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodeRow));
  yield* files["files.put"]
    .run(
      { store: "docs", name: "retained.bin", contentType: "application/octet-stream" },
      new Uint8Array([0, 255, 19])
    )
    .pipe(Effect.provideService(Binding.Binding, binding));
  return row.id;
});

const assertResources = Effect.fn("SdkConcurrency.assertResources")(function* (
  patchId: string,
  versionId: string,
  rowId: string
) {
  const binding = yield* bindingFor(patchId, versionId);
  const tables = yield* TableOperations.make;
  const files = yield* Files.make;
  const row = yield* tables["tables.get"]
    .run({ table: "notes", id: rowId })
    .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodeRow));
  assert.strictEqual(row.title, "retained note");
  assert.strictEqual(row.slug, "retained-note");
  const file = yield* files["files.get"]
    .run({ store: "docs", name: "retained.bin" })
    .pipe(Effect.provideService(Binding.Binding, binding));
  assert.strictEqual(file.contentType, "application/octet-stream");
  assert.deepStrictEqual(file.bytes, new Uint8Array([0, 255, 19]));
});

const backendPid = (sql: SqlClient.SqlClient) =>
  sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.pipe(Effect.map((rows) => rows[0]!.pid));

// Observe actual lock waiters by backend identity; pg_stat_activity truncates query text.
const blockedBy = Effect.fn("SdkConcurrency.blockedBy")(function* (blocker: number, count = 1) {
  const observer = yield* SqlClient.SqlClient;
  const rows = yield* observer<{ pid: number }>`
    SELECT pid FROM pg_stat_activity
    WHERE ${blocker} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'`.pipe(
    Effect.repeat({ until: (rows) => rows.length >= count }),
    Effect.timeout("10 seconds"),
    TestClock.withLive
  );
  const pids = rows.map((row) => row.pid);
  assert.strictEqual(new Set(pids).size, count);
  assert.notInclude(pids, blocker);
  return pids;
});

const gate = Effect.fn("SdkConcurrency.gate")(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  return {
    entered,
    release,
    pause: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
  };
});

// Real filesystem puts finish before this scheduling gate; Content still owns the whole publish.
const stagedContent = Effect.fn("SdkConcurrency.stagedContent")(function* (
  pause: Effect.Effect<void>,
  patches: Patches.Patches["Service"]
) {
  const store = yield* ContentStore.ContentStore;
  return yield* Content.make.pipe(
    Effect.provideService(Patches.Patches, patches),
    Effect.provideService(
      ContentStore.ContentStore,
      ContentStore.ContentStore.of({
        ...store,
        put: (key, html) => store.put(key, html).pipe(Effect.andThen(pause))
      })
    )
  );
});

// Capture publication and sweep backends inside their transactions, before their locks.
const observedPatches = Effect.fn("SdkConcurrency.observedPatches")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const patches = yield* Patches.Patches;
  const session = yield* Deferred.make<number>();
  const withTransaction: SqlClient.SqlClient["withTransaction"] = (operation) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* Deferred.succeed(session, yield* backendPid(sql));
        return yield* operation;
      })
    );
  const observedSql = new Proxy(sql, {
    get: (target, property, receiver) =>
      property === "withTransaction" ? withTransaction : Reflect.get(target, property, receiver)
  });
  const observed = yield* Patches.make.pipe(
    Effect.provideService(SqlClient.SqlClient, observedSql)
  );
  return {
    session,
    patches: Patches.Patches.of({
      ...patches,
      record: observed.record,
      purgeDeleted: observed.purgeDeleted
    })
  };
});

// Pause after real DDL/inventory writes, with both publication transactions still open.
const heldProvision = Effect.fn("SdkConcurrency.heldProvision")(function* () {
  const platform = yield* SqlClient.SqlClient;
  const tables = yield* Tables.Tables;
  const held = yield* gate();
  const sessions = yield* Deferred.make<{ platform: number; company: number }>();
  const patches = yield* Patches.make.pipe(
    Effect.provideService(
      Tables.Tables,
      Tables.Tables.of({
        ...tables,
        provision: (patchId, manifest) =>
          tables.provision(patchId, manifest).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                const company = yield* CompanyDatabases.CompanyConnection;
                yield* Deferred.succeed(sessions, {
                  platform: yield* backendPid(platform),
                  company: yield* backendPid(company)
                });
                yield* held.pause;
              })
            )
          )
      })
    )
  );
  return { ...held, sessions, patches };
});

it.layer(services, { timeout: "60 seconds" })("SDK orchestration / real PostgreSQL only", (it) => {
  it.effect(
    "races two first Content publishes into one company database with usable resources",
    () =>
      Effect.gen(function* () {
        const platform = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const databases = yield* CompanyDatabases.CompanyDatabases;
        const held = yield* gate();
        const locked = yield* Deferred.make<number>();
        assert.deepStrictEqual(yield* platform`SELECT company_id FROM company_databases`, []);
        const blocker = yield* platform
          .withTransaction(
            Effect.gen(function* () {
              yield* platform`LOCK TABLE company_databases IN SHARE MODE`;
              yield* Deferred.succeed(locked, yield* backendPid(platform));
              yield* held.pause;
            })
          )
          .pipe(Effect.forkScoped);
        const pid = yield* Deferred.await(locked);
        const publications = yield* Effect.all(
          ["first-company-left", "first-company-right"].map((name) =>
            publish({ ...definition, name }, `<p>${name}</p>`).pipe(Effect.forkScoped)
          )
        );
        yield* blockedBy(pid, 2);
        yield* Deferred.succeed(held.release, undefined);
        yield* Fiber.join(blocker);
        const results = yield* Effect.forEach(publications, Fiber.join);
        assert.strictEqual(new Set(results.map((result) => result.patchId)).size, 2);
        const placements = yield* platform<{ database: string; status: string }>`
        SELECT database_name AS database, status FROM company_databases
        WHERE company_id = ${uploader.company.id}`;
        assert.strictEqual(placements.length, 1);
        assert.strictEqual(placements[0]!.status, "ready");
        assert.deepStrictEqual(
          yield* platform`SELECT datname FROM pg_database WHERE datname = ${placements[0]!.database}`,
          [{ datname: placements[0]!.database }]
        );
        const handlers = yield* TableOperations.make;
        for (const result of results) {
          assert.strictEqual(result.schemaRevision, 1);
          assert.deepStrictEqual(
            (yield* patches.inventory(result.patchId, uploader.user.id)).files,
            { docs: { description: "Documents keyed by file name." } }
          );
          const binding = yield* bindingFor(result.patchId, result.versionId);
          const inserted = yield* handlers["tables.insert"]
            .run({
              table: "notes",
              row: { title: result.name, slug: "same-key-in-each-patch" }
            })
            .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodeRow));
          assert.strictEqual(inserted.title, result.name);
          const page = yield* handlers["tables.list"]
            .run({ table: "notes" })
            .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodePage));
          assert.deepStrictEqual(
            page.rows.map((row) => row.title),
            [result.name]
          );
        }
        const company = yield* databases.withCompany(uploader.company.id)(
          Effect.gen(function* () {
            const sql = yield* CompanyDatabases.CompanyConnection;
            return yield* sql<{ database: string }>`SELECT current_database() AS database`;
          })
        );
        assert.deepStrictEqual(company, [{ database: placements[0]!.database }]);
      }).pipe(Effect.scoped),
    60_000
  );

  it.effect(
    "serializes whole publishes while old and new bundles contend on their cumulative tables and files",
    () =>
      Effect.gen(function* () {
        const patches = yield* Patches.Patches;
        const content = yield* Content.Content;
        const databases = yield* CompanyDatabases.CompanyDatabases;
        const initial = yield* publish(definition, "<p>original bundle</p>");
        const oldBinding = yield* bindingFor(initial.patchId, initial.versionId);
        const handlers = yield* TableOperations.make;
        const firstManifest: typeof Manifest.Type = {
          ...definition,
          tables: {
            notes: {
              ...definition.tables.notes!,
              columns: {
                ...definition.tables.notes!.columns,
                label: { kind: "text", optional: true }
              }
            }
          },
          files: {
            docs: { description: "Documents keyed by file name." },
            images: { description: "Images keyed by file name." }
          }
        };
        const secondManifest: typeof Manifest.Type = {
          ...definition,
          tables: {
            notes: {
              ...definition.tables.notes!,
              columns: {
                ...definition.tables.notes!.columns,
                priority: { kind: "integer", default: 0 }
              }
            }
          }
        };
        const firstStored = yield* gate();
        const secondStored = yield* gate();
        const provisioning = yield* heldProvision();
        const secondRecord = yield* observedPatches();
        const firstContent = yield* stagedContent(firstStored.pause, provisioning.patches);
        const secondContent = yield* stagedContent(secondStored.pause, secondRecord.patches);
        const first = yield* publish(firstManifest, "<p>label bundle</p>", initial.patchId).pipe(
          Effect.provideService(Content.Content, firstContent),
          Effect.forkScoped
        );
        const second = yield* publish(
          secondManifest,
          "<p>priority bundle</p>",
          initial.patchId
        ).pipe(Effect.provideService(Content.Content, secondContent), Effect.forkScoped);
        yield* Deferred.await(firstStored.entered);
        yield* Deferred.await(secondStored.entered);
        yield* Deferred.succeed(firstStored.release, undefined);
        const pids = yield* Deferred.await(provisioning.sessions);
        assert.notStrictEqual(pids.platform, pids.company);
        yield* Deferred.succeed(secondStored.release, undefined);
        const oldInsert = yield* handlers["tables.insert"]
          .run({
            table: "notes",
            row: { title: "old bundle during DDL", slug: "old-during-ddl" }
          })
          .pipe(
            Effect.provideService(Binding.Binding, oldBinding),
            Effect.flatMap(decodeRow),
            Effect.forkScoped
          );
        assert.deepStrictEqual(yield* blockedBy(pids.platform), [
          yield* Deferred.await(secondRecord.session)
        ]);
        yield* blockedBy(pids.company);
        const before = Option.getOrThrow(yield* patches.find(initial.patchId));
        assert.strictEqual(before.version.id, initial.versionId);
        assert.strictEqual(yield* content.read(before.version), "<p>original bundle</p>");
        yield* Deferred.succeed(provisioning.release, undefined);
        const firstResult = yield* Fiber.join(first);
        const secondResult = yield* Fiber.join(second);
        const inserted = yield* Fiber.join(oldInsert);
        assert.deepStrictEqual([firstResult.versionNumber, secondResult.versionNumber], [2, 3]);
        assert.deepStrictEqual([firstResult.schemaRevision, secondResult.schemaRevision], [2, 3]);
        assert.deepStrictEqual(firstResult.provisioned.columns, ["notes.label"]);
        assert.deepStrictEqual(secondResult.provisioned.columns, ["notes.priority"]);
        assert.deepStrictEqual(secondResult.unused.columns, ["notes.label"]);
        assert.deepStrictEqual(secondResult.unused.stores, ["images"]);
        const cumulative = yield* patches.inventory(initial.patchId, uploader.user.id);
        assert.strictEqual(cumulative.schemaRevision, 3);
        assert.deepStrictEqual(Object.keys(cumulative.tables.notes!.columns).sort(), [
          "label",
          "priority",
          "slug",
          "title"
        ]);
        assert.deepStrictEqual(cumulative.files, {
          docs: { description: "Documents keyed by file name." },
          images: { description: "Images keyed by file name." }
        });
        const current = Option.getOrThrow(yield* patches.find(initial.patchId));
        assert.strictEqual(current.version.id, secondResult.versionId);
        assert.strictEqual(yield* content.read(current.version), "<p>priority bundle</p>");
        const labelBinding = yield* bindingFor(initial.patchId, firstResult.versionId);
        const priorityBinding = yield* bindingFor(initial.patchId, secondResult.versionId);
        const labelRow = yield* handlers["tables.get"]
          .run({ table: "notes", id: inserted.id })
          .pipe(Effect.provideService(Binding.Binding, labelBinding), Effect.flatMap(decodeRow));
        const priorityRow = yield* handlers["tables.get"]
          .run({ table: "notes", id: inserted.id })
          .pipe(Effect.provideService(Binding.Binding, priorityBinding), Effect.flatMap(decodeRow));
        assert.strictEqual(labelRow.label, null);
        assert.strictEqual(priorityRow.priority, 0);
        assert.strictEqual(priorityRow.title, "old bundle during DDL");

        // A current bundle's complete batch holds its real transaction while an older bundle conflicts.
        const batchHeld = yield* gate();
        const batchPid = yield* Deferred.make<number>();
        const withCompany: CompanyDatabases.CompanyDatabases["Service"]["withCompany"] =
          (companyId) => (effect) =>
            databases.withCompany(companyId)(
              Effect.gen(function* () {
                const sql = yield* CompanyDatabases.CompanyConnection;
                const withTransaction: SqlClient.SqlClient["withTransaction"] = (operation) =>
                  sql.withTransaction(
                    operation.pipe(
                      Effect.tap(() =>
                        Effect.gen(function* () {
                          yield* Deferred.succeed(batchPid, yield* backendPid(sql));
                          yield* batchHeld.pause;
                        })
                      )
                    )
                  );
                const heldSql = new Proxy(sql, {
                  get: (target, property, receiver) =>
                    property === "withTransaction"
                      ? withTransaction
                      : Reflect.get(target, property, receiver)
                });
                return yield* effect.pipe(
                  Effect.provideService(CompanyDatabases.CompanyConnection, heldSql)
                );
              })
            );
        const heldHandlers = yield* TableOperations.make.pipe(
          Effect.provideService(
            CompanyDatabases.CompanyDatabases,
            CompanyDatabases.CompanyDatabases.of({ ...databases, withCompany })
          )
        );
        const winningBatch = yield* heldHandlers["tables.insertMany"]
          .run({
            table: "notes",
            rows: [
              { title: "current winner", slug: "winner-private", priority: 7 },
              { title: "current winner", slug: "contested", priority: 7 }
            ]
          })
          .pipe(Effect.provideService(Binding.Binding, priorityBinding), Effect.forkScoped);
        const winnerPid = yield* Deferred.await(batchPid);
        const losingBatch = yield* handlers["tables.insertMany"]
          .run({
            table: "notes",
            rows: [
              { title: "old loser", slug: "loser-private" },
              { title: "old loser", slug: "contested" }
            ]
          })
          .pipe(Effect.provideService(Binding.Binding, oldBinding), Effect.flip, Effect.forkScoped);
        yield* blockedBy(winnerPid);
        yield* Deferred.succeed(batchHeld.release, undefined);
        yield* Fiber.join(winningBatch);
        assert.strictEqual((yield* Fiber.join(losingBatch)).code, "unique_violation");
        const rows = yield* handlers["tables.list"]
          .run({ table: "notes", index: "bySlug" })
          .pipe(
            Effect.provideService(Binding.Binding, priorityBinding),
            Effect.flatMap(decodePage)
          );
        assert.deepStrictEqual(
          rows.rows.map((row) => [row.slug, row.title, row.priority]),
          [
            ["contested", "current winner", 7],
            ["old-during-ddl", "old bundle during DDL", 0],
            ["winner-private", "current winner", 7]
          ]
        );

        // Both immutable bundles write the store provisioned by Content, not a separately seeded index.
        const files = yield* Files.make;
        const fileHeld = yield* gate();
        const filePid = yield* Deferred.make<number>();
        const fileBlocker = yield* databases
          .withCompany(uploader.company.id)(
            databases.withFileLock(
              initial.patchId,
              "docs",
              "same.bin"
            )(
              Effect.gen(function* () {
                yield* Deferred.succeed(
                  filePid,
                  yield* backendPid(yield* CompanyDatabases.CompanyConnection)
                );
                yield* fileHeld.pause;
              })
            )
          )
          .pipe(Effect.forkScoped);
        const fileLockPid = yield* Deferred.await(filePid);
        const candidates = [
          {
            bytes: new Uint8Array([0, 255, 19]),
            contentType: "application/octet-stream",
            binding: oldBinding
          },
          {
            bytes: new Uint8Array([81, 82, 83, 84, 85]),
            contentType: "text/plain",
            binding: priorityBinding
          }
        ];
        const puts = yield* Effect.forEach(candidates, (candidate) =>
          files["files.put"]
            .run(
              { store: "docs", name: "same.bin", contentType: candidate.contentType },
              candidate.bytes
            )
            .pipe(Effect.provideService(Binding.Binding, candidate.binding), Effect.forkScoped)
        );
        yield* blockedBy(fileLockPid, 2);
        yield* Deferred.succeed(fileHeld.release, undefined);
        yield* Fiber.join(fileBlocker);
        yield* Effect.forEach(puts, Fiber.join);
        const stored = yield* files["files.get"]
          .run({ store: "docs", name: "same.bin" })
          .pipe(Effect.provideService(Binding.Binding, oldBinding));
        const winner = candidates.find(
          (candidate) => candidate.contentType === stored.contentType
        )!;
        assert.isDefined(winner);
        assert.deepStrictEqual(stored.bytes, winner.bytes);
        const listed = yield* files["files.list"]
          .run({ store: "docs" })
          .pipe(
            Effect.provideService(Binding.Binding, priorityBinding),
            Effect.flatMap(decodeFiles)
          );
        assert.deepStrictEqual(
          listed.files.map(({ name, size, contentType }) => ({ name, size, contentType })),
          [{ name: "same.bin", size: stored.bytes.byteLength, contentType: stored.contentType }]
        );
        assert.isNull(listed.cursor);
        assert.strictEqual(
          (yield* patches.inventory(initial.patchId, uploader.user.id)).schemaRevision,
          3
        );
      }).pipe(Effect.scoped),
    60_000
  );

  it.effect(
    "keeps rollback inventory cumulative and prevents a stale publish from losing a locked patch-row update",
    () =>
      Effect.gen(function* () {
        const platform = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const content = yield* Content.Content;
        const manifest = { ...definition, name: "rollback-concurrency" };
        const original = yield* publish(manifest, "<p>rollback target</p>");
        const expanded: typeof Manifest.Type = {
          ...manifest,
          tables: {
            notes: {
              ...manifest.tables.notes!,
              columns: {
                ...manifest.tables.notes!.columns,
                label: { kind: "text", optional: true }
              }
            }
          },
          files: {
            docs: { description: "Documents keyed by file name." },
            images: { description: "Images keyed by file name." }
          }
        };
        const held = yield* heldProvision();
        const heldContent = yield* Content.make.pipe(
          Effect.provideService(Patches.Patches, held.patches)
        );
        const publication = yield* publish(
          expanded,
          "<p>expanded bundle</p>",
          original.patchId
        ).pipe(Effect.provideService(Content.Content, heldContent), Effect.forkScoped);
        const pids = yield* Deferred.await(held.sessions);
        const rollbackPid = yield* Deferred.make<number>();
        const rollback = yield* platform
          .withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(rollbackPid, yield* backendPid(platform));
              return yield* patches.rollback(original.patchId, owner, 1);
            })
          )
          .pipe(Effect.forkScoped);
        assert.deepStrictEqual(yield* blockedBy(pids.platform), [
          yield* Deferred.await(rollbackPid)
        ]);
        yield* Deferred.succeed(held.release, undefined);
        const published = yield* Fiber.join(publication);
        yield* Fiber.join(rollback);
        const rolledBack = Option.getOrThrow(yield* patches.find(original.patchId));
        assert.strictEqual(rolledBack.patch.currentVersionId, original.versionId);
        assert.strictEqual(yield* content.read(rolledBack.version), "<p>rollback target</p>");
        const inventory = yield* patches.inventory(original.patchId, uploader.user.id);
        assert.strictEqual(inventory.schemaRevision, 2);
        assert.deepStrictEqual(inventory.files, {
          docs: { description: "Documents keyed by file name." },
          images: { description: "Images keyed by file name." }
        });
        assert.deepStrictEqual(Object.keys(inventory.tables.notes!.columns).sort(), [
          "label",
          "slug",
          "title"
        ]);
        const handlers = yield* TableOperations.make;
        const oldBinding = yield* bindingFor(original.patchId, original.versionId);
        const inserted = yield* handlers["tables.insert"]
          .run({
            table: "notes",
            row: { title: "after rollback", slug: "after-rollback" }
          })
          .pipe(Effect.provideService(Binding.Binding, oldBinding), Effect.flatMap(decodeRow));
        const expandedBinding = yield* bindingFor(original.patchId, published.versionId);
        const row = yield* handlers["tables.get"]
          .run({ table: "notes", id: inserted.id })
          .pipe(Effect.provideService(Binding.Binding, expandedBinding), Effect.flatMap(decodeRow));
        assert.strictEqual(row.label, null);
        assert.strictEqual(row.title, "after rollback");

        // Preflight saw company scope. A later row-locked change must survive record's whole-row update.
        const stored = yield* gate();
        const nextRecord = yield* observedPatches();
        const staged = yield* stagedContent(stored.pause, nextRecord.patches);
        const next = yield* publish(
          manifest,
          "<p>after locked scope change</p>",
          original.patchId
        ).pipe(Effect.provideService(Content.Content, staged), Effect.forkScoped);
        yield* Deferred.await(stored.entered);
        const scopeHeld = yield* gate();
        const scopePid = yield* Deferred.make<number>();
        const scopeChange = yield* platform
          .withTransaction(
            Effect.gen(function* () {
              yield* platform`SELECT id FROM patches WHERE id = ${original.patchId} FOR UPDATE`;
              yield* patches.setScope(
                original.patchId,
                { userId: uploader.user.id, admin: false },
                "public"
              );
              yield* Deferred.succeed(scopePid, yield* backendPid(platform));
              yield* scopeHeld.pause;
            })
          )
          .pipe(Effect.forkScoped);
        const pid = yield* Deferred.await(scopePid);
        yield* Deferred.succeed(stored.release, undefined);
        assert.deepStrictEqual(yield* blockedBy(pid), [yield* Deferred.await(nextRecord.session)]);
        yield* Deferred.succeed(scopeHeld.release, undefined);
        yield* Fiber.join(scopeChange);
        const nextResult = yield* Fiber.join(next);
        assert.strictEqual(nextResult.scope, "public");
        assert.strictEqual(nextResult.versionNumber, 3);
        assert.strictEqual(nextResult.schemaRevision, 2);
        assert.deepStrictEqual(nextResult.unused.columns, ["notes.label"]);
        assert.deepStrictEqual(nextResult.unused.stores, ["images"]);
        const final = Option.getOrThrow(yield* patches.find(original.patchId));
        assert.strictEqual(final.patch.scope, "public");
        assert.strictEqual(final.patch.currentVersionId, nextResult.versionId);
        assert.strictEqual(final.version.id, nextResult.versionId);
        assert.strictEqual(yield* content.read(final.version), "<p>after locked scope change</p>");
        assert.deepStrictEqual(
          yield* patches.inventory(original.patchId, uploader.user.id),
          inventory
        );
      }).pipe(Effect.scoped),
    60_000
  );

  it.effect(
    "refuses a staged publish after retire commits and restores the unchanged resources",
    () =>
      Effect.gen(function* () {
        const platform = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const content = yield* Content.Content;
        const manifest = { ...definition, name: "retire-wins-publish" };
        const initial = yield* publish(manifest, "<p>kept through retirement</p>");
        const rowId = yield* saveResources(initial.patchId, initial.versionId);
        const inventory = yield* patches.inventory(initial.patchId, uploader.user.id);
        const stored = yield* gate();
        const observed = yield* observedPatches();
        const staged = yield* stagedContent(stored.pause, observed.patches);
        const publication = yield* publish(
          { ...manifest, files: { ...manifest.files, images: { description: "New images." } } },
          "<p>must not replace the retired bundle</p>",
          initial.patchId
        ).pipe(Effect.provideService(Content.Content, staged), Effect.flip, Effect.forkScoped);
        yield* Deferred.await(stored.entered);
        const held = yield* gate();
        const session = yield* Deferred.make<number>();
        const retiring = yield* platform
          .withTransaction(
            Effect.gen(function* () {
              const retired = yield* patches.retire(initial.patchId, owner);
              yield* Deferred.succeed(session, yield* backendPid(platform));
              yield* held.pause;
              return retired;
            })
          )
          .pipe(Effect.forkScoped);
        const pid = yield* Deferred.await(session);
        yield* Deferred.succeed(stored.release, undefined);
        assert.deepStrictEqual(yield* blockedBy(pid), [yield* Deferred.await(observed.session)]);
        yield* Deferred.succeed(held.release, undefined);
        assert.strictEqual((yield* Fiber.join(retiring)).state, "retired");
        assert.instanceOf(yield* Fiber.join(publication), Patches.PatchRetired);
        assert.isTrue(Option.isNone(yield* patches.find(initial.patchId)));
        const retained = Option.getOrThrow(yield* patches.findRetained(initial.patchId));
        assert.strictEqual(retained.version.id, initial.versionId);
        assert.strictEqual(yield* content.read(retained.version), "<p>kept through retirement</p>");
        assert.isTrue(Option.isNone(yield* patches.findRetained(initial.patchId, 2)));
        assert.deepStrictEqual(
          yield* patches.inventory(initial.patchId, uploader.user.id),
          inventory
        );
        assert.strictEqual((yield* patches.restore(initial.patchId, owner)).state, "live");
        yield* assertResources(initial.patchId, initial.versionId, rowId);
      }).pipe(Effect.scoped),
    60_000
  );

  it.effect(
    "refuses the old owner's staged publish after reassignment and lets the new owner continue",
    () =>
      Effect.gen(function* () {
        const platform = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const content = yield* Content.Content;
        const manifest = { ...definition, name: "reassign-wins-publish" };
        const initial = yield* publish(manifest, "<p>original owner's bundle</p>");
        const rowId = yield* saveResources(initial.patchId, initial.versionId);
        const inventory = yield* patches.inventory(initial.patchId, uploader.user.id);
        const expanded = {
          ...manifest,
          files: { ...manifest.files, images: { description: "New owner's images." } }
        };
        const stored = yield* gate();
        const observed = yield* observedPatches();
        const staged = yield* stagedContent(stored.pause, observed.patches);
        const publication = yield* publish(
          expanded,
          "<p>former owner's late bundle</p>",
          initial.patchId
        ).pipe(Effect.provideService(Content.Content, staged), Effect.flip, Effect.forkScoped);
        yield* Deferred.await(stored.entered);
        const held = yield* gate();
        const session = yield* Deferred.make<number>();
        const reassigning = yield* platform
          .withTransaction(
            Effect.gen(function* () {
              const reassigned = yield* patches.reassign(
                initial.patchId,
                administrator,
                reader.user.id,
                uploader.user.id
              );
              yield* Deferred.succeed(session, yield* backendPid(platform));
              yield* held.pause;
              return reassigned;
            })
          )
          .pipe(Effect.forkScoped);
        const pid = yield* Deferred.await(session);
        yield* Deferred.succeed(stored.release, undefined);
        assert.deepStrictEqual(yield* blockedBy(pid), [yield* Deferred.await(observed.session)]);
        yield* Deferred.succeed(held.release, undefined);
        assert.strictEqual((yield* Fiber.join(reassigning)).ownerUserId, reader.user.id);
        const refusal = yield* Fiber.join(publication);
        assert.instanceOf(refusal, Patches.NotOwner);
        assert.deepStrictEqual(refusal.owner, { id: reader.user.id, name: reader.user.name });
        const unchanged = Option.getOrThrow(yield* patches.find(initial.patchId));
        assert.strictEqual(unchanged.patch.ownerUserId, reader.user.id);
        assert.strictEqual(unchanged.version.id, initial.versionId);
        assert.strictEqual(unchanged.version.createdByMachineTokenId, uploader.machine.id);
        assert.strictEqual(
          yield* content.read(unchanged.version),
          "<p>original owner's bundle</p>"
        );
        assert.isTrue(Option.isNone(yield* patches.find(initial.patchId, 2)));
        assert.deepStrictEqual(
          yield* patches.inventory(initial.patchId, reader.user.id),
          inventory
        );
        const next = yield* publish(expanded, "<p>new owner's bundle</p>", initial.patchId, reader);
        assert.strictEqual(next.versionNumber, 2);
        assert.deepStrictEqual(next.provisioned.stores, ["images"]);
        const current = Option.getOrThrow(yield* patches.find(initial.patchId));
        assert.strictEqual(current.patch.ownerUserId, reader.user.id);
        assert.strictEqual(current.version.createdByMachineTokenId, reader.machine.id);
        assert.strictEqual(yield* content.read(current.version), "<p>new owner's bundle</p>");
        yield* assertResources(initial.patchId, next.versionId, rowId);
      }).pipe(Effect.scoped),
    60_000
  );

  it.effect(
    "skips a stale sweep candidate after a pre-deadline restore wins the row lock",
    () =>
      Effect.gen(function* () {
        const platform = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const content = yield* Content.Content;
        const initial = yield* publish(
          { ...definition, name: "restore-wins-sweep" },
          "<p>restored with its data</p>"
        );
        const rowId = yield* saveResources(initial.patchId, initial.versionId);
        yield* patches.delete(initial.patchId, owner);
        yield* TestClock.adjust(30 * DAY - 1);
        const held = yield* gate();
        const session = yield* Deferred.make<number>();
        const restoring = yield* platform
          .withTransaction(
            Effect.gen(function* () {
              const restored = yield* patches.restore(initial.patchId, owner);
              yield* Deferred.succeed(session, yield* backendPid(platform));
              yield* held.pause;
              return restored;
            })
          )
          .pipe(Effect.forkScoped);
        const pid = yield* Deferred.await(session);
        yield* TestClock.adjust(1);
        assert.include(yield* patches.listDeleted(100), initial.patchId);
        const observed = yield* observedPatches();
        const sweeper = yield* DeletionSweep.make.pipe(
          Effect.provideService(Patches.Patches, observed.patches)
        );
        const sweeping = yield* sweeper.sweep.pipe(Effect.forkScoped);
        assert.deepStrictEqual(yield* blockedBy(pid), [yield* Deferred.await(observed.session)]);
        yield* Deferred.succeed(held.release, undefined);
        assert.strictEqual((yield* Fiber.join(restoring)).state, "live");
        assert.deepStrictEqual(yield* Fiber.join(sweeping), {
          deleted: 0,
          skipped: 1,
          failed: 0,
          orphanedObjects: 0
        });
        const current = Option.getOrThrow(yield* patches.find(initial.patchId));
        assert.strictEqual(current.version.id, initial.versionId);
        assert.strictEqual(yield* content.read(current.version), "<p>restored with its data</p>");
        assert.strictEqual(
          Option.getOrThrow(yield* patches.resolveName(uploader.company.handle, initial.name))
            .patchId,
          initial.patchId
        );
        yield* assertResources(initial.patchId, initial.versionId, rowId);
      }).pipe(Effect.scoped),
    60_000
  );

  it.effect(
    "refuses a restore waiting on the sweep and never revives its reclaimed namespace",
    () =>
      Effect.gen(function* () {
        const platform = yield* SqlClient.SqlClient;
        const patches = yield* Patches.Patches;
        const companies = yield* CompanyDatabases.CompanyDatabases;
        const inventory = yield* Inventory.Inventory;
        const objects = yield* ContentStore.ContentStore;
        const manifest = { ...definition, name: "sweep-wins-restore" };
        const initial = yield* publish(manifest, "<p>reclaimed bundle</p>");
        yield* saveResources(initial.patchId, initial.versionId);
        yield* patches.delete(initial.patchId, owner);
        yield* TestClock.adjust(30 * DAY);
        const held = yield* gate();
        const session = yield* Deferred.make<number>();
        const withPatchLock: CompanyDatabases.CompanyDatabases["Service"]["withPatchLock"] =
          (patchId) => (effect) =>
            companies.withPatchLock(patchId)(
              Effect.gen(function* () {
                yield* Deferred.succeed(session, yield* backendPid(platform));
                yield* held.pause;
                return yield* effect;
              })
            );
        const gated = yield* Patches.make.pipe(
          Effect.provideService(
            CompanyDatabases.CompanyDatabases,
            CompanyDatabases.CompanyDatabases.of({ ...companies, withPatchLock })
          )
        );
        const sweeper = yield* DeletionSweep.make.pipe(
          Effect.provideService(Patches.Patches, gated)
        );
        const sweeping = yield* sweeper.sweep.pipe(Effect.forkScoped);
        const pid = yield* Deferred.await(session);
        const restoreSession = yield* Deferred.make<number>();
        const restoring = yield* platform
          .withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(restoreSession, yield* backendPid(platform));
              return yield* patches.restore(initial.patchId, owner);
            })
          )
          .pipe(Effect.flip, Effect.forkScoped);
        assert.deepStrictEqual(yield* blockedBy(pid), [yield* Deferred.await(restoreSession)]);
        yield* Deferred.succeed(held.release, undefined);
        assert.instanceOf(yield* Fiber.join(restoring), Patches.PatchUnavailable);
        assert.deepStrictEqual(yield* Fiber.join(sweeping), {
          deleted: 1,
          skipped: 0,
          failed: 0,
          orphanedObjects: 0
        });
        assert.isTrue(Option.isNone(yield* patches.findRetained(initial.patchId)));
        assert.isTrue(
          Option.isNone(yield* patches.resolveName(uploader.company.handle, initial.name))
        );
        assert.isNull(
          yield* companies.withCompany(uploader.company.id)(inventory.read(initial.patchId))
        );
        assert.instanceOf(
          yield* objects
            .get(Content.objectKey(initial.patchId, initial.versionId))
            .pipe(Effect.flip),
          ContentStore.ObjectNotFound
        );
        assert.deepStrictEqual(
          yield* objects.list(`files/${initial.patchId}/`).pipe(Stream.runCollect),
          []
        );
        assert.instanceOf(
          yield* patches.restore(initial.patchId, owner).pipe(Effect.flip),
          Patches.PatchUnavailable
        );
        const replacement = yield* publish(manifest, "<p>new patch at the reclaimed name</p>");
        assert.notStrictEqual(replacement.patchId, initial.patchId);
        const tables = yield* TableOperations.make;
        const binding = yield* bindingFor(replacement.patchId, replacement.versionId);
        const page = yield* tables["tables.list"]
          .run({ table: "notes" })
          .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodePage));
        assert.deepStrictEqual(page.rows, []);
        const rowId = yield* saveResources(replacement.patchId, replacement.versionId);
        yield* assertResources(replacement.patchId, replacement.versionId, rowId);
      }).pipe(Effect.scoped),
    60_000
  );
});
