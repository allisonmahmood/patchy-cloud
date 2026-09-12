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
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { inject } from "vitest";
import { FilePage, Manifest, TablePage, TableRow } from "@patchy/api";
import { CompanyDatabases } from "@patchy/company-database";
import { ContentStore, FilesystemContentStore } from "@patchy/content-store";
import { Files, TableOperations, Tables } from "@patchy/primitives";
import { Binding, LoadedVersions } from "@patchy/runtime";
import * as Content from "./Content.js";
import * as Patches from "./Patches.js";
import * as PatchLoadedVersions from "./LoadedVersions.js";
import * as Fixtures from "./test/fixtures.js";

const { uploader } = Fixtures.identities;
const decodePage = Schema.decodeUnknownEffect(TablePage);
const decodeRow = Schema.decodeUnknownEffect(TableRow);
const decodeFiles = Schema.decodeUnknownEffect(FilePage);
const definition: typeof Manifest.Type = {
  ...Fixtures.manifest,
  name: "sdk-concurrency",
  tier: 1,
  tables: {
    notes: {
      columns: { title: { kind: "text" }, slug: { kind: "text" } },
      indexes: { bySlug: { columns: ["slug"], unique: true } }
    }
  },
  files: { docs: {} }
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

const services = Layer.mergeAll(Content.layer, PatchLoadedVersions.layer).pipe(
  Layer.provideMerge(Patches.layer),
  Layer.provideMerge(Layer.merge(realPostgres, filesystem))
);

const publish = Effect.fn("SdkConcurrency.publish")(function* (
  manifest: typeof Manifest.Type,
  html: string,
  patchId: string | null = null
) {
  const content = yield* Content.Content;
  return yield* content.publish({
    ...Fixtures.publishRecord(),
    manifest,
    patchId,
    companyId: uploader.company.id,
    ownerUserId: uploader.user.id,
    machineTokenId: uploader.machine.id,
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

const backendPid = (sql: SqlClient.SqlClient) =>
  sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.pipe(Effect.map((rows) => rows[0]!.pid));

// Observe actual lock waiters, rather than assuming that fork order caused a race.
const blockedBy = Effect.fn("SdkConcurrency.blockedBy")(function* (
  blocker: number,
  query: string,
  count = 1
) {
  const observer = yield* SqlClient.SqlClient;
  const rows = yield* observer<{ pid: number }>`
    SELECT pid FROM pg_stat_activity
    WHERE ${blocker} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'
      AND position(${query} IN query) > 0`.pipe(
    Effect.repeat({ until: (rows) => rows.length >= count }),
    Effect.timeout("10 seconds"),
    TestClock.withLive
  );
  assert.strictEqual(new Set(rows.map((row) => row.pid)).size, count);
  assert.isFalse(rows.some((row) => row.pid === blocker));
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
        yield* blockedBy(pid, "INSERT INTO company_databases", 2);
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
            { docs: {} }
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
          files: { docs: {}, images: {} }
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
        const firstContent = yield* stagedContent(firstStored.pause, provisioning.patches);
        const secondContent = yield* stagedContent(secondStored.pause, patches);
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
        yield* blockedBy(pids.platform, "FOR UPDATE OF patches");
        yield* blockedBy(pids.company, "INSERT INTO");
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
        assert.deepStrictEqual(cumulative.files, { docs: {}, images: {} });
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
        yield* blockedBy(winnerPid, "INSERT INTO");
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
        yield* blockedBy(fileLockPid, "pg_advisory_xact_lock", 2);
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
          files: { docs: {}, images: {} }
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
        // There is no rollback service yet; this is the existing locked pointer-change seam.
        const rollback = yield* platform
          .withTransaction(
            Effect.gen(function* () {
              const [current] = yield* platform<{ version: string }>`
          SELECT current_version_id AS version FROM patches WHERE id = ${original.patchId} FOR UPDATE`;
              yield* platform`UPDATE patches SET current_version_id = ${original.versionId} WHERE id = ${original.patchId}`;
              return current!.version;
            })
          )
          .pipe(Effect.forkScoped);
        yield* blockedBy(pids.platform, "FOR UPDATE");
        yield* Deferred.succeed(held.release, undefined);
        const published = yield* Fiber.join(publication);
        assert.strictEqual(yield* Fiber.join(rollback), published.versionId);
        const rolledBack = Option.getOrThrow(yield* patches.find(original.patchId));
        assert.strictEqual(rolledBack.patch.currentVersionId, original.versionId);
        assert.strictEqual(yield* content.read(rolledBack.version), "<p>rollback target</p>");
        const inventory = yield* patches.inventory(original.patchId, uploader.user.id);
        assert.strictEqual(inventory.schemaRevision, 2);
        assert.deepStrictEqual(inventory.files, { docs: {}, images: {} });
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
        const staged = yield* stagedContent(stored.pause, patches);
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
              yield* patches.setScope(original.patchId, uploader.user.id, "public");
              yield* Deferred.succeed(scopePid, yield* backendPid(platform));
              yield* scopeHeld.pause;
            })
          )
          .pipe(Effect.forkScoped);
        const pid = yield* Deferred.await(scopePid);
        yield* Deferred.succeed(stored.release, undefined);
        yield* blockedBy(pid, "FOR UPDATE OF patches");
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
});
