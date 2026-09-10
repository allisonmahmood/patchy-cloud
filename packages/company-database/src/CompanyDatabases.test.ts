import { assert, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { inject } from "vitest";
import { layerFromUrl } from "@patchy/sql";
import * as CompanyDatabases from "./CompanyDatabases.js";
import * as PgCompanyDatabases from "./PgCompanyDatabases.js";
import { quoteIdentifier } from "./Inventory.js";
import * as Inventory from "./Inventory.js";
import * as Testing from "./testing.js";
import { inventoryContract } from "./test/inventoryContract.js";

const createCompany = Effect.fn("test.createCompany")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO companies (id, handle, name) VALUES (${id}, ${id}, ${id})`;
});
const currentDatabase = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ database: string }>`SELECT current_database() AS database`.pipe(
    Effect.map((rows) => rows[0]!.database)
  )
);

it.layer(Testing.layer())("CompanyDatabases", (it) => {
  it.effect("runs the portable inventory contract on real Postgres", () =>
    inventoryContract("cmp_dev")
  );

  it.effect("races independent registries against one committed claim", () =>
    Effect.gen(function* () {
      yield* createCompany("claim-race");
      const first = yield* CompanyDatabases.CompanyDatabases;
      const url = Redacted.make(inject("postgres").adminUrl);
      const secondContext = yield* Layer.build(
        Layer.effect(CompanyDatabases.CompanyDatabases, PgCompanyDatabases.make).pipe(
          Layer.provide(PgCompanyDatabases.adminLayer),
          Layer.provide(Reactivity.layer),
          Layer.provide(
            Layer.succeed(PgCompanyDatabases.CompanyDatabaseConfig, {
              adminUrl: url,
              dataUrl: url,
              maxBackends: 200,
              capacity: 100
            })
          )
        )
      );
      const second = Context.get(secondContext, CompanyDatabases.CompanyDatabases);
      const [a, b] = yield* Effect.all(
        [first.ensureReady("claim-race"), second.ensureReady("claim-race")],
        { concurrency: "unbounded" }
      );
      assert.deepStrictEqual(a, b);
      assert.strictEqual(a.status, "ready");
      assert.isNotNull(a.readyAt);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT datname FROM pg_database WHERE datname = ${a.databaseName}`,
        [{ datname: a.databaseName }]
      );
      assert.strictEqual(yield* first.withCompany("claim-race")(currentDatabase), a.databaseName);
      assert.strictEqual((yield* second.claim("claim-race")).databaseName, a.databaseName);
    }).pipe(Effect.scoped)
  );

  it.effect("provisions with a non-superuser CREATEDB login and an unprivileged data owner", () =>
    Effect.gen(function* () {
      yield* createCompany("separate-logins");
      const platform = yield* SqlClient.SqlClient;
      const placement = yield* (yield* CompanyDatabases.CompanyDatabases).claim("separate-logins");
      const suffix = yield* currentDatabase;
      const adminRole = `${suffix}_admin`;
      const dataRole = `${suffix}_data`;
      yield* Effect.acquireRelease(
        Effect.gen(function* () {
          yield* platform.unsafe(
            `CREATE ROLE ${quoteIdentifier(dataRole)} LOGIN PASSWORD 'local-test'`
          );
          yield* platform.unsafe(
            `CREATE ROLE ${quoteIdentifier(adminRole)} LOGIN CREATEDB NOINHERIT PASSWORD 'local-test'`
          );
          yield* platform.unsafe(
            `GRANT ${quoteIdentifier(dataRole)} TO ${quoteIdentifier(adminRole)}`
          );
        }),
        () =>
          Effect.gen(function* () {
            yield* platform.unsafe(
              `DROP DATABASE IF EXISTS ${quoteIdentifier(placement.databaseName)} WITH (FORCE)`
            );
            yield* platform.unsafe(`DROP ROLE ${quoteIdentifier(adminRole)}`);
            yield* platform.unsafe(`DROP ROLE ${quoteIdentifier(dataRole)}`);
          }).pipe(Effect.orDie)
      );
      const adminUrl = new URL(inject("postgres").adminUrl);
      adminUrl.username = adminRole;
      adminUrl.password = "local-test";
      const dataUrl = new URL(adminUrl);
      dataUrl.username = "ignored-authority";
      dataUrl.searchParams.append("user", "ignored-query");
      dataUrl.searchParams.append("user", dataRole);
      const restricted = Layer.effect(
        CompanyDatabases.CompanyDatabases,
        PgCompanyDatabases.make
      ).pipe(
        Layer.provide(PgCompanyDatabases.adminLayer),
        Layer.provide(Reactivity.layer),
        Layer.provide(
          Layer.succeed(PgCompanyDatabases.CompanyDatabaseConfig, {
            adminUrl: Redacted.make(adminUrl.toString()),
            dataUrl: Redacted.make(dataUrl.toString()),
            maxBackends: 4,
            capacity: 1
          })
        )
      );
      yield* Effect.gen(function* () {
        const service = yield* CompanyDatabases.CompanyDatabases;
        assert.strictEqual((yield* service.ensureReady("separate-logins")).status, "ready");
        yield* service.withCompany("separate-logins")(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(
              yield* sql`SELECT current_user AS role,
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
          (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS createdb`,
              [{ role: dataRole, superuser: false, createdb: false }]
            );
            yield* service.withPatchLock("restricted")(
              sql`CREATE TABLE patchy.permission_probe (id integer)`
            );
          })
        );
      }).pipe(Effect.provide(restricted, { local: true }));
    }).pipe(Effect.scoped)
  );

  it.effect("reads one inventory revision when provisioning commits between component reads", () =>
    Effect.gen(function* () {
      yield* createCompany("snapshot-race");
      const service = yield* CompanyDatabases.CompanyDatabases;
      const inventory = yield* Inventory.Inventory;
      const platform = yield* SqlClient.SqlClient;
      yield* service.withCompany("snapshot-race")(
        service.withPatchLock("snapshot")(inventory.ensurePatch("snapshot"))
      );
      const writerReady = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const writer = yield* service
        .withCompany("snapshot-race")(
          service.withPatchLock("snapshot")(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              // Hold the later component query behind this transaction while earlier
              // components remain readable, exposing a mixed snapshot without the lock.
              yield* sql`LOCK TABLE patchy.columns IN ACCESS EXCLUSIVE MODE`;
              yield* inventory.putTable({ patchId: "snapshot", name: "notes", shared: false });
              yield* inventory.putColumn({
                patchId: "snapshot",
                table: "notes",
                name: "body",
                kind: "text",
                optional: true,
                defaultKind: null,
                defaultValue: null
              });
              yield* inventory.bumpRevision("snapshot");
              yield* Deferred.succeed(writerReady, undefined);
              yield* Deferred.await(commit);
            })
          )
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(writerReady);
      const readerPid = yield* Deferred.make<number>();
      const reader = yield* service
        .withCompany("snapshot-race")(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
            yield* Deferred.succeed(readerPid, row!.pid);
            return yield* inventory.read("snapshot");
          })
        )
        .pipe(Effect.forkScoped);
      const pid = yield* Deferred.await(readerPid);
      yield* platform<{ waiting: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'
    ) AS waiting`.pipe(Effect.repeat({ until: (rows) => rows[0]!.waiting }));
      yield* Deferred.succeed(commit, undefined);
      yield* Fiber.join(writer);
      const snapshot = yield* Fiber.join(reader);
      assert.deepInclude(
        [
          { revision: 0, tables: [], columns: [] },
          { revision: 1, tables: ["notes"], columns: [["notes", "body"]] }
        ],
        {
          revision: snapshot?.schemaRevision,
          tables: snapshot?.tables.map((table) => table.name),
          columns: snapshot?.columns.map((column) => [column.table, column.name])
        }
      );
    }).pipe(Effect.scoped)
  );

  it.effect("commits the claim and company transaction independently of platform rollback", () =>
    Effect.gen(function* () {
      yield* createCompany("outer-rollback");
      const service = yield* CompanyDatabases.CompanyDatabases;
      const platform = yield* SqlClient.SqlClient;
      const platformName = yield* currentDatabase;
      yield* platform
        .withTransaction(
          Effect.gen(function* () {
            yield* platform`UPDATE companies SET name = 'rolled back' WHERE id = 'outer-rollback'`;
            yield* service.withCompany("outer-rollback")(
              service.withPatchLock("independent")(
                Effect.gen(function* () {
                  const sql = yield* SqlClient.SqlClient;
                  assert.notStrictEqual(yield* currentDatabase, platformName);
                  yield* sql`CREATE TABLE public.company_commit (value integer)`;
                  yield* sql`INSERT INTO public.company_commit VALUES (7)`;
                })
              )
            );
            return yield* Effect.fail("rollback");
          })
        )
        .pipe(Effect.flip);
      const placement = yield* service.claim("outer-rollback");
      assert.strictEqual(placement.status, "ready");
      assert.deepStrictEqual(
        yield* platform`SELECT name FROM companies WHERE id = 'outer-rollback'`,
        [{ name: "outer-rollback" }]
      );
      assert.deepStrictEqual(
        yield* service.withCompany("outer-rollback")(
          Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT value FROM public.company_commit`)
        ),
        [{ value: 7 }]
      );
    })
  );

  it.effect("serializes patch DDL on separate sessions and releases a rolled-back lock", () =>
    Effect.gen(function* () {
      yield* createCompany("patch-lock");
      const service = yield* CompanyDatabases.CompanyDatabases;
      const locked = yield* Deferred.make<number>();
      const release = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<number>();
      const first = yield* service
        .withCompany("patch-lock")(
          service.withPatchLock("same-patch")(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
              yield* sql`CREATE TABLE public.locked_ddl (id integer)`;
              yield* Deferred.succeed(locked, row!.pid);
              yield* Deferred.await(release);
              return yield* Effect.fail("rollback first DDL");
            })
          )
        )
        .pipe(Effect.exit, Effect.forkScoped);
      const firstPid = yield* Deferred.await(locked);
      const second = yield* service
        .withCompany("patch-lock")(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.withTransaction(
              Effect.gen(function* () {
                const [row] = yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
                yield* Deferred.succeed(waiting, row!.pid);
                return yield* service.withPatchLock("same-patch")(
                  sql`CREATE TABLE public.locked_ddl (id integer)`
                );
              })
            )
          )
        )
        .pipe(Effect.forkScoped);
      const secondPid = yield* Deferred.await(waiting);
      assert.notStrictEqual(firstPid, secondPid);
      // Inspect the server's lock wait rather than relying on a sleep or scheduler timing.
      const platform = yield* SqlClient.SqlClient;
      yield* platform<{ waiting: boolean }>`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity WHERE pid = ${secondPid} AND wait_event = 'advisory'
    ) AS waiting`.pipe(Effect.repeat({ until: (rows) => rows[0]!.waiting }));
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(first)));
      yield* Fiber.join(second);
      assert.deepStrictEqual(
        yield* service.withCompany("patch-lock")(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql`SELECT to_regclass('public.locked_ddl')::text AS name`
          )
        ),
        [{ name: "locked_ddl" }]
      );
    }).pipe(Effect.scoped)
  );

  it.effect("fails fast at four company operations and releases interrupted leases", () =>
    Effect.gen(function* () {
      yield* createCompany("operation-capacity");
      const service = yield* CompanyDatabases.CompanyDatabases;
      const entered = yield* Effect.all(Array.from({ length: 4 }, () => Deferred.make<void>()));
      const fibers = yield* Effect.forEach(entered, (signal) =>
        service
          .withCompany("operation-capacity")(
            Deferred.succeed(signal, undefined).pipe(Effect.andThen(Effect.never))
          )
          .pipe(Effect.forkScoped)
      );
      yield* Effect.forEach(entered, Deferred.await);
      const refused = yield* service
        .withCompany("operation-capacity")(currentDatabase)
        .pipe(Effect.flip);
      assert.instanceOf(refused, CompanyDatabases.Busy);
      if (refused._tag === "Busy") assert.strictEqual(refused.code, "busy");
      yield* Fiber.interrupt(fibers[0]!);
      assert.strictEqual(
        yield* service.withCompany("operation-capacity")(currentDatabase),
        (yield* service.claim("operation-capacity")).databaseName
      );
    }).pipe(Effect.scoped)
  );

  it.effect(
    "opens a new pool for a placement version instead of reusing the retained old pool",
    () =>
      Effect.gen(function* () {
        yield* createCompany("placement-version");
        const service = yield* CompanyDatabases.CompanyDatabases;
        const platform = yield* SqlClient.SqlClient;
        const pid = Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.pipe(
            Effect.map((rows) => rows[0]!.pid)
          )
        );
        const before = yield* service.withCompany("placement-version")(pid);
        yield* platform`UPDATE company_databases SET placement_version = placement_version + 1 WHERE company_id = 'placement-version'`;
        const after = yield* service.withCompany("placement-version")(pid);
        assert.notStrictEqual(before, after);
      })
  );
});

// An alternate admin layer still executes real CREATE, then interrupts its caller exactly once.
const interruptedCreate = Layer.effect(
  PgCompanyDatabases.AdminClient,
  Effect.gen(function* () {
    const real = yield* PgCompanyDatabases.AdminClient;
    let interruptNextCreate = true;
    return yield* SqlClient.make({
      compiler: PgClient.makeCompiler(),
      spanAttributes: [],
      acquirer: real.reserve.pipe(
        Effect.map((connection) => ({
          execute: (statement, params, transformRows) =>
            connection.execute(statement, params, transformRows).pipe(
              Effect.tap(() => {
                if (!statement.startsWith("CREATE DATABASE") || !interruptNextCreate)
                  return Effect.void;
                interruptNextCreate = false;
                return Effect.interrupt;
              })
            ),
          executeRaw: connection.executeRaw.bind(connection),
          executeStream: connection.executeStream.bind(connection),
          executeValues: connection.executeValues.bind(connection),
          executeValuesUnprepared: connection.executeValuesUnprepared.bind(connection),
          executeUnprepared: connection.executeUnprepared.bind(connection)
        }))
      )
    });
  })
).pipe(Layer.provide(PgCompanyDatabases.adminLayer), Layer.provide(Reactivity.layer));

it.layer(Testing.layer({ adminLayer: interruptedCreate }))("Interrupted company creation", (it) => {
  it.effect(
    "resumes the claimed database after CREATE succeeded but readiness did not commit",
    () =>
      Effect.gen(function* () {
        const service = yield* CompanyDatabases.CompanyDatabases;
        const attempt = yield* service.ensureReady("cmp_dev").pipe(Effect.forkChild);
        const interrupted = yield* Fiber.await(attempt);
        assert.isTrue(Exit.hasInterrupts(interrupted));
        const claim = yield* service.claim("cmp_dev");
        assert.strictEqual(claim.status, "claimed");
        const platform = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* platform`SELECT datname FROM pg_database WHERE datname = ${claim.databaseName}`,
          [{ datname: claim.databaseName }]
        );
        const ready = yield* service.ensureReady("cmp_dev");
        assert.strictEqual(ready.databaseName, claim.databaseName);
        assert.strictEqual(ready.status, "ready");
        assert.deepStrictEqual(
          yield* service.withCompany("cmp_dev")(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) => sql`SELECT to_regclass('patchy.files')::text AS name`
            )
          ),
          [{ name: "patchy.files" }]
        );
      })
  );
});

for (const [name, limits, resource] of [
  ["retained backend budget", { maxBackends: 4 }, "backend budget"],
  ["registry capacity", { capacity: 1 }, "pool registry"]
] as const) {
  it.layer(Testing.layer(limits))(name, (it) => {
    it.effect(
      "counts idle pools, evicts after 60 seconds, and admits the previously refused company",
      () =>
        Effect.gen(function* () {
          yield* createCompany("capacity-second");
          const service = yield* CompanyDatabases.CompanyDatabases;
          yield* service.withCompany("cmp_dev")(currentDatabase);
          const refused = yield* service
            .withCompany("capacity-second")(currentDatabase)
            .pipe(Effect.flip);
          assert.strictEqual(refused._tag, "Busy");
          if (refused._tag === "Busy") assert.strictEqual(refused.resource, resource);
          assert.strictEqual((yield* service.claim("capacity-second")).status, "claimed");
          yield* TestClock.adjust("59 seconds");
          assert.strictEqual(
            (yield* service.withCompany("capacity-second")(currentDatabase).pipe(Effect.flip))._tag,
            "Busy"
          );
          yield* TestClock.adjust("1 second");
          assert.strictEqual(
            yield* service.withCompany("capacity-second")(currentDatabase),
            (yield* service.claim("capacity-second")).databaseName
          );
        })
    );
  });
}

it.effect("closes company pools before dropping a test block's databases", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(Testing.layer(), scope);
    const service = Context.get(context, CompanyDatabases.CompanyDatabases);
    const placement = yield* service.ensureReady("cmp_dev");
    yield* service.withCompany("cmp_dev")(currentDatabase);
    yield* Scope.close(scope, Exit.void);
    const rows = yield* Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`SELECT datname FROM pg_database WHERE datname = ${placement.databaseName}`
    ).pipe(Effect.provide(layerFromUrl(Redacted.make(inject("postgres").adminUrl))));
    assert.deepStrictEqual(rows, []);
  })
);
