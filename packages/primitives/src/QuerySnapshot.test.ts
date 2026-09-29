import { assert, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { runtimeOperations, sharedTableId, TablePage } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { PgliteCompanyDatabases } from "@patchy/company-database/dev";
import { Binding, InvocationCapabilities, LoadedVersions } from "@patchy/runtime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Files from "./Files.js";
import * as QuerySnapshot from "./QuerySnapshot.js";
import * as ReadSnapshot from "./ReadSnapshot.js";
import * as ResourceRevisions from "./ResourceRevisions.js";
import * as TableOperations from "./TableOperations.js";
import * as Tables from "./Tables.js";
import * as TestWakes from "./test/wakes.js";
import * as FileFixtures from "./test/files.js";
import { manifest, setup } from "./test/operationsContract.js";

const page = Schema.decodeUnknownEffect(TablePage);
const filePage = Schema.decodeUnknownEffect(runtimeOperations["files.list"].response);
const snapshotSql = Effect.gen(function* () {
  const snapshot = yield* Effect.serviceOption(ReadSnapshot.ReadSnapshot);
  if (Option.isNone(snapshot)) return yield* Effect.die("Missing query snapshot");
  return snapshot.value.sql;
});
const open = Effect.fn("test.openQuerySnapshot")(function* (
  binding: Binding.Binding["Service"],
  budget = 3_000
) {
  const capabilities = yield* InvocationCapabilities.make;
  const snapshots = yield* QuerySnapshot.make.pipe(
    Effect.provideService(InvocationCapabilities.InvocationCapabilities, capabilities)
  );
  const identity = {
    user: { id: "usr_dev", name: "Viewer", email: "viewer@example.test" },
    company: { id: binding.companyId, handle: "company", name: "Company" },
    admin: false
  };
  const capability = yield* capabilities.issue({
    binding: { ...binding, identity, principal: { userId: identity.user.id } },
    kind: "query",
    attempt: {
      invocationId: `inv_${binding.patchId}`,
      attemptId: "attempt_one",
      processGeneration: 1,
      deadline: (yield* Clock.currentTimeMillis) + budget
    },
    reauthorize: Effect.succeed(identity)
  });
  const resource = yield* snapshots.open(capability);
  capability.snapshot.value = resource;
  yield* Effect.addFinalizer(() =>
    resource.cancel.pipe(
      Effect.andThen(capabilities.settle(capability.token, "returned")),
      Effect.asVoid
    )
  );
  return { resource, capabilities, capability };
});
const layer = FileFixtures.services.pipe(
  Layer.provideMerge(
    Layer.succeed(LoadedVersions.LoadedVersions, { find: () => Effect.succeed(Option.none()) })
  )
);

it.layer(layer)("Invocation query snapshots", (it) => {
  it.effect("keeps resource-free callbacks fenced without using absent or ready storage", () =>
    Effect.gen(function* () {
      const platform = yield* SqlClient.SqlClient;
      const databases = yield* CompanyDatabases.CompanyDatabases;
      const companyId = "cmp_snapshot_free";
      yield* platform`INSERT INTO companies (id, handle, name)
        VALUES (${companyId}, 'snapshot-free', 'Resource-free snapshots')`;
      const binding = Binding.Binding.of({
        companyId,
        patchId: "snapshotfree",
        versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
        manifest: { ...manifest, tier: 2, tables: {} },
        wireVersion: 1,
        scope: "company",
        identity: null,
        principal: null,
        correlationId: "resource-free-snapshot"
      });
      for (const provisioned of [false, true]) {
        if (provisioned) {
          yield* databases.ensureReady(companyId);
          assert.deepStrictEqual(
            yield* databases.withCompany(companyId)(ResourceRevisions.read([])),
            {}
          );
        }
        const { resource, capability, capabilities } = yield* open(binding);
        assert.deepStrictEqual(resource.watermark, {});
        const viewer = yield* resource.run(
          Effect.map(Binding.Binding, (current) => current.identity?.user.id).pipe(
            Effect.provideService(Binding.Binding, capability.binding)
          )
        );
        assert.strictEqual(viewer, "usr_dev");
        const entered = yield* Deferred.make<void>();
        const running = yield* resource
          .run(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(3_000);
        assert.isTrue(yield* capabilities.settle(capability.token, "deadline"));
        assert.isTrue(Exit.isFailure(yield* Fiber.join(running)));
        yield* resource.settled;
        assert.strictEqual(resource.dbMs, 0);
        assert.propertyVal(
          yield* resource.run(Effect.succeed("late callback")).pipe(Effect.flip),
          "_tag",
          "CapabilityRefused"
        );
        if (!provisioned)
          assert.deepStrictEqual(
            yield* platform`SELECT company_id FROM company_databases WHERE company_id = ${companyId}`,
            []
          );
      }
    }).pipe(Effect.scoped)
  );

  it.effect("keeps count, list and file metadata on one snapshot across committed writes", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("cmp_dev", "snapshotdata", {
        ...manifest,
        files: { docs: { description: "Query snapshot files." } }
      });
      yield* fixture.call("tables.insert", {
        table: "notes",
        row: { title: "before", slug: "before" }
      });
      const files = yield* Files.make;
      const put = (name: string, value: string) =>
        files["files.put"]
          .run({ store: "docs", name, contentType: "text/plain" }, new TextEncoder().encode(value))
          .pipe(Effect.provideService(Binding.Binding, fixture.binding));
      yield* put("first.txt", "old");
      const { resource, capabilities, capability } = yield* open(fixture.binding);
      const beforeVector = { ...resource.watermark };
      const initial = yield* resource.run(
        Effect.gen(function* () {
          const sql = yield* snapshotSql;
          return yield* sql.unsafe<{ count: number; pid: number }>(
            `SELECT count(*)::int AS count, pg_backend_pid() AS pid FROM ${Inventory.quoteIdentifier(Inventory.namespace(fixture.binding.patchId))}.notes`
          );
        })
      );
      const beforeFiles = yield* resource
        .run(
          files["files.list"]
            .run({ store: "docs" })
            .pipe(Effect.provideService(Binding.Binding, fixture.binding))
        )
        .pipe(Effect.flatMap(filePage));
      yield* fixture.call("tables.insert", {
        table: "notes",
        row: { title: "after", slug: "after" }
      });
      yield* put("first.txt", "replacement");
      yield* put("second.txt", "new");
      const listed = yield* resource
        .run(fixture.call("tables.list", { table: "notes" }))
        .pipe(Effect.flatMap(page));
      assert.strictEqual(initial[0]!.count, 1);
      assert.deepStrictEqual(
        listed.rows.map((row) => row.title),
        ["before"]
      );
      const secondPid = yield* resource.run(
        Effect.flatMap(snapshotSql, (sql) => sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)
      );
      assert.strictEqual(secondPid[0]!.pid, initial[0]!.pid);
      assert.deepStrictEqual(
        yield* resource.run(
          files["files.list"]
            .run({ store: "docs" })
            .pipe(Effect.provideService(Binding.Binding, fixture.binding))
        ),
        beforeFiles
      );
      const stat = yield* resource.run(
        files["files.stat"]
          .run({ store: "docs", name: "first.txt" })
          .pipe(Effect.provideService(Binding.Binding, fixture.binding))
      );
      assert.deepStrictEqual(stat, beforeFiles.files[0]);
      assert.isNull(
        yield* resource.run(
          files["files.stat"]
            .run({ store: "docs", name: "second.txt" })
            .pipe(Effect.provideService(Binding.Binding, fixture.binding))
        )
      );
      assert.isTrue(yield* capabilities.settle(capability.token, "returned"));
      assert.deepStrictEqual(resource.watermark, beforeVector);
      const next = yield* open(fixture.binding);
      const tableKey = `table:${fixture.binding.patchId}:notes`;
      const storeKey = `store:${fixture.binding.patchId}:docs`;
      assert.strictEqual(
        next.resource.watermark[tableKey],
        String(BigInt(resource.watermark[tableKey]!) + 1n)
      );
      assert.strictEqual(
        next.resource.watermark[storeKey],
        String(BigInt(resource.watermark[storeKey]!) + 2n)
      );
      assert.deepStrictEqual(Object.keys(resource.watermark).sort(), [storeKey, tableKey].sort());
      const fresh = yield* fixture
        .call("tables.list", { table: "notes" })
        .pipe(Effect.flatMap(page));
      assert.deepStrictEqual(fresh.rows.map((row) => row.title).sort(), ["after", "before"]);
    }).pipe(Effect.scoped)
  );

  it.effect("serializes entire callback effects, not only their SQL statements", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("cmp_dev", "snapshotjobs");
      const { resource } = yield* open(fixture.binding);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: string[] = [];
      const first = yield* resource
        .run(
          Effect.gen(function* () {
            order.push("first starts");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            order.push("first ends");
          })
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* resource
        .run(Effect.sync(() => order.push("second")))
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(order, ["first starts"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(order, ["first starts", "first ends", "second"]);
    }).pipe(Effect.scoped)
  );

  it.effect("rechecks unshare live with all retained shared-query slots occupied", () =>
    Effect.gen(function* () {
      const source = yield* setup("cmp_dev", "snapshotsrc", {
        ...manifest,
        tables: { notes: { ...manifest.tables.notes!, shared: true } }
      });
      yield* source.call("tables.insert", {
        table: "notes",
        row: { title: "shared", slug: "one" }
      });
      const consumer = yield* setup("cmp_dev", "snapshotuse", {
        ...manifest,
        uses: {
          contacts: {
            kind: "sharedTable",
            patchId: source.binding.patchId,
            table: "notes",
            id: sharedTableId(source.binding.patchId, "notes"),
            revision: 1
          }
        }
      });
      const handlers = yield* TableOperations.make.pipe(
        Effect.provideService(LoadedVersions.LoadedVersions, {
          find: () => Effect.succeed(Option.some(source.binding))
        })
      );
      const readers = yield* Effect.forEach([1, 2, 3], () => open(consumer.binding));
      for (const reader of readers) {
        const result = yield* reader.resource
          .run(
            handlers["shared.list"]
              .run({ alias: "contacts" })
              .pipe(Effect.provideService(Binding.Binding, reader.capability.binding))
          )
          .pipe(Effect.flatMap(page));
        assert.deepStrictEqual(
          result.rows.map((row) => row.title),
          ["shared"]
        );
      }
      const inventory = yield* Inventory.Inventory;
      yield* source.databases.withCompany("cmp_dev")(
        source.databases.withPatchLock(source.binding.patchId)(
          inventory.putTable({
            patchId: source.binding.patchId,
            name: "notes",
            description: "Unshared while queries retain an older snapshot.",
            shared: false
          })
        )
      );
      for (const reader of readers) {
        const error = yield* reader.resource
          .run(
            handlers["shared.list"]
              .run({ alias: "contacts" })
              .pipe(Effect.provideService(Binding.Binding, reader.capability.binding))
          )
          .pipe(Effect.flip);
        assert.propertyVal(error, "code", "access_denied");
      }
    }).pipe(Effect.scoped)
  );

  it.effect(
    "cancels an active PostgreSQL statement at the deadline and recovers all pool slots",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup("cmp_dev", "snapshottime");
        const platform = yield* SqlClient.SqlClient;
        const { resource, capability, capabilities } = yield* open(fixture.binding);
        const [backend] = yield* resource.run(
          Effect.flatMap(snapshotSql, (sql) => sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)
        );
        const slow = yield* resource
          .run(Effect.flatMap(snapshotSql, (sql) => sql`SELECT pg_sleep(60)`))
          .pipe(Effect.exit, Effect.forkChild);
        yield* platform<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE pid = ${backend!.pid} AND wait_event = 'PgSleep'
      ) AS waiting`.pipe(Effect.repeat({ until: (rows) => rows[0]!.waiting }));
        yield* TestClock.adjust(3_000);
        assert.isTrue(yield* capabilities.settle(capability.token, "deadline"));
        assert.isTrue(Exit.isFailure(yield* Fiber.join(slow)));
        const rows = yield* platform<{
          state: string;
        }>`SELECT state FROM pg_stat_activity WHERE pid = ${backend!.pid}`;
        assert.isFalse(rows.some((row) => row.state === "idle in transaction"));
        const entered = yield* Queue.unbounded<void>();
        const release = yield* Deferred.make<void>();
        const holders = yield* Effect.forEach([1, 2, 3, 4], () =>
          fixture.databases
            .withCompany("cmp_dev")(
              Effect.flatMap(CompanyDatabases.CompanyConnection, (sql) =>
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`SELECT 1`;
                    yield* Queue.offer(entered, undefined);
                    yield* Deferred.await(release);
                  })
                )
              )
            )
            .pipe(Effect.forkChild)
        );
        for (let index = 0; index < 4; index++) yield* Queue.take(entered);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(holders, Fiber.join);
        assert.strictEqual(resource.dbMs, 3_000);
      }).pipe(Effect.scoped)
  );
});

const local = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-query-snapshot-" });
    return Tables.layer.pipe(
      Layer.provideMerge(
        Layer.merge(
          Inventory.layer,
          PgliteCompanyDatabases.layer({ companyId: "local-company", dataDir })
        )
      )
    );
  })
).pipe(
  Layer.provideMerge(TestWakes.layer),
  Layer.provide(NodeFileSystem.layer),
  Layer.provideMerge(
    Layer.succeed(LoadedVersions.LoadedVersions, { find: () => Effect.succeed(Option.none()) })
  )
);

it.layer(local)("Invocation query snapshots / PGlite", (it) => {
  it.effect("reads own and shared fixtures through the single retained connection", () =>
    Effect.gen(function* () {
      const source = yield* setup("local-company", "snapshotlocal", {
        ...manifest,
        tables: { notes: { ...manifest.tables.notes!, shared: true } },
        uses: {
          contacts: {
            kind: "sharedTable",
            patchId: "snapshotlocal",
            table: "notes",
            id: sharedTableId("snapshotlocal", "notes"),
            revision: 1
          }
        }
      });
      yield* source.call("tables.insert", {
        table: "notes",
        row: { title: "local", slug: "one" }
      });
      const handlers = yield* TableOperations.make.pipe(
        Effect.provideService(LoadedVersions.LoadedVersions, {
          find: () => Effect.succeed(Option.some(source.binding))
        })
      );
      const { resource, capability } = yield* open(source.binding);
      const own = yield* resource
        .run(source.call("tables.list", { table: "notes" }))
        .pipe(Effect.flatMap(page));
      const shared = yield* resource
        .run(
          handlers["shared.list"]
            .run({ alias: "contacts" })
            .pipe(Effect.provideService(Binding.Binding, capability.binding))
        )
        .pipe(Effect.flatMap(page));
      assert.deepStrictEqual(
        own.rows.map((row) => row.title),
        ["local"]
      );
      assert.deepStrictEqual(shared.rows, own.rows);
    }).pipe(Effect.scoped)
  );
});
