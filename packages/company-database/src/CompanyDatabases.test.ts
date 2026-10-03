import { assert, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { inject } from "vitest";
import { layerFromUrl } from "@patchy/sql";
import * as WideEvents from "@patchy/analytics/wide-events";
import * as DatabaseMeter from "@patchy/analytics/database-meter";
import { OperatingLimits } from "@patchy/limits";
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

const holdConnections = Effect.fn("test.holdConnections")(function* (
  companyId: string,
  count: number
) {
  const service = yield* CompanyDatabases.CompanyDatabases;
  return yield* Effect.forEach(Array.from({ length: count }), () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const fiber = yield* service
        .withCompany(companyId)(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.withTransaction(
              currentDatabase.pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Effect.never)
              )
            )
          )
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      return fiber;
    })
  );
});

it.layer(Testing.layer().pipe(Layer.provideMerge(Testing.resourceChangesLayer)))(
  "CompanyDatabases",
  (it) => {
    it.effect("runs the portable inventory contract on real Postgres", () =>
      inventoryContract("cmp_dev")
    );

    it.effect("destroys a retained session instead of returning it to the company pool", () =>
      Effect.gen(function* () {
        const companyId = "retained-destroy";
        yield* createCompany(companyId);
        const databases = yield* CompanyDatabases.CompanyDatabases;
        yield* databases.ensureReady(companyId);
        const scope = yield* Scope.make();
        const lease = yield* databases.lease(companyId, false).pipe(Scope.provide(scope));
        const before = yield* lease.run(lease.sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`);
        lease.destroy();
        yield* Scope.close(scope, Exit.void);
        const after = yield* databases.withCompany(companyId)(
          Effect.flatMap(
            CompanyDatabases.CompanyConnection,
            (sql) => sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`
          )
        );
        assert.notStrictEqual(after[0]!.pid, before[0]!.pid);
      }).pipe(Effect.scoped)
    );

    it.effect("meters actual transactions and nested work but not idle company slots", () =>
      Effect.gen(function* () {
        const companyId = "meter-transactions";
        yield* createCompany(companyId);
        const databases = yield* CompanyDatabases.CompanyDatabases;
        yield* databases.ensureReady(companyId);
        const parent = yield* DatabaseMeter.make;
        const child = yield* DatabaseMeter.make.pipe(
          Effect.provideService(DatabaseMeter.current, parent)
        );
        yield* databases
          .withCompany(companyId)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* TestClock.adjust("7 millis");
              assert.strictEqual(parent.snapshot(), 0);
              yield* sql.withTransaction(TestClock.adjust("11 millis"));
              yield* TestClock.adjust("5 millis");
              assert.strictEqual(parent.snapshot(), 11);
              const failed = yield* sql
                .withTransaction(
                  TestClock.adjust("13 millis").pipe(Effect.andThen(Effect.fail("failed work")))
                )
                .pipe(Effect.exit);
              assert.deepStrictEqual(failed, Exit.fail("failed work"));
              yield* sql
                .withTransaction(TestClock.adjust("17 millis"))
                .pipe(Effect.provideService(DatabaseMeter.current, child));
            })
          )
          .pipe(Effect.provideService(DatabaseMeter.current, parent));
        assert.strictEqual(parent.snapshot(), 41);
        assert.strictEqual(child.snapshot(), 17);
        yield* TestClock.adjust("19 millis");
        assert.strictEqual(parent.snapshot(), 41);
      })
    );

    it.effect(
      "meters retained and authority connections until destruction without duplicate release",
      () =>
        Effect.gen(function* () {
          const companyId = "meter-retained";
          yield* createCompany(companyId);
          const databases = yield* CompanyDatabases.CompanyDatabases;
          yield* databases.ensureReady(companyId);
          const meter = yield* DatabaseMeter.make;
          const scope = yield* Scope.make();
          const lease = yield* databases
            .lease(companyId, true)
            .pipe(Scope.provide(scope), Effect.provideService(DatabaseMeter.current, meter));
          yield* TestClock.adjust("10 millis");
          assert.strictEqual(meter.snapshot(), 10);
          yield* lease
            .authority(
              Effect.flatMap(SqlClient.SqlClient, (sql) =>
                sql.withTransaction(TestClock.adjust("7 millis"))
              )
            )
            .pipe(Effect.provideService(DatabaseMeter.current, meter));
          assert.strictEqual(meter.snapshot(), 24);
          lease.destroy();
          yield* TestClock.adjust("9 millis");
          assert.strictEqual(meter.snapshot(), 24);
          yield* Scope.close(scope, Exit.void);
          assert.strictEqual(meter.snapshot(), 24);
        }).pipe(Effect.scoped)
    );

    it.effect("settles a cancelled retained lease's held time", () =>
      Effect.gen(function* () {
        const companyId = "meter-cancelled";
        yield* createCompany(companyId);
        const databases = yield* CompanyDatabases.CompanyDatabases;
        yield* databases.ensureReady(companyId);
        const meter = yield* DatabaseMeter.make;
        const entered = yield* Deferred.make<void>();
        const owner = yield* Effect.gen(function* () {
          yield* databases.lease(companyId, false);
          yield* Deferred.succeed(entered, undefined);
          return yield* Effect.never;
        }).pipe(
          Effect.scoped,
          Effect.provideService(DatabaseMeter.current, meter),
          Effect.forkScoped
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust("23 millis");
        yield* Fiber.interrupt(owner);
        yield* TestClock.adjust("29 millis");
        assert.strictEqual(meter.snapshot(), 23);
      }).pipe(Effect.scoped)
    );

    it.effect("adds repeated queue waits without metering unacquired connections", () =>
      Effect.gen(function* () {
        const companyId = "meter-queued";
        yield* createCompany(companyId);
        const databases = yield* CompanyDatabases.CompanyDatabases;
        yield* databases.ensureReady(companyId);
        yield* holdConnections(companyId, 4);
        const meter = yield* DatabaseMeter.make;
        const recorded = yield* Queue.unbounded<WideEvents.WideEvent>();
        const refused = yield* Queue.unbounded<void>();
        const waiting = yield* Queue.unbounded<void>();
        const clock = yield* Clock.Clock;
        const events = yield* WideEvents.make.pipe(
          Effect.provideService(WideEvents.Sink, {
            write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
          })
        );
        const waiter = yield* events
          .withEvent(
            { type: "request", companyId },
            Effect.forEach([1, 2], () =>
              databases
                .lease(companyId, false)
                .pipe(
                  Effect.scoped,
                  Effect.catchTags({ Busy: () => Queue.offer(refused, undefined) })
                )
            )
          )
          .pipe(
            Effect.provideService(DatabaseMeter.current, meter),
            Effect.provideService(Clock.Clock, {
              ...clock,
              sleep: (duration) =>
                Duration.toMillis(duration) === 1_000
                  ? Queue.offer(waiting, undefined).pipe(Effect.andThen(clock.sleep(duration)))
                  : clock.sleep(duration)
            }),
            Effect.forkScoped
          );
        yield* Queue.take(waiting);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(refused);
        yield* Queue.take(waiting);
        yield* TestClock.adjust("1 second");
        yield* Queue.take(refused);
        yield* Fiber.join(waiter);
        const event = yield* Queue.take(recorded);
        assert.strictEqual(event.type, "request");
        if (event.type !== "request") return;
        assert.strictEqual(event.queueWaitMs, 2_000);
        assert.strictEqual(event.connectionWaitMs, 2_000);
        assert.strictEqual(meter.snapshot(), 0);
      }).pipe(Effect.scoped)
    );

    it.effect("reports PostgreSQL's actual commit result and ignores read-only rollback", () =>
      Effect.gen(function* () {
        const companyId = "meter-commit-outcome";
        yield* createCompany(companyId);
        const databases = yield* CompanyDatabases.CompanyDatabases;
        yield* databases.ensureReady(companyId);
        const recorded = yield* Queue.unbounded<WideEvents.WideEvent>();
        const events = yield* WideEvents.make.pipe(
          Effect.provideService(WideEvents.Sink, {
            write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
          })
        );
        yield* events.withEvent(
          { type: "request", companyId },
          databases.withCompany(companyId)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.withTransaction(sql`SELECT 1 / 0`.pipe(Effect.catch(() => Effect.void)));
            })
          )
        );
        const aborted = yield* Queue.take(recorded);
        assert.strictEqual(aborted.type, "request");
        if (aborted.type !== "request") return;
        assert.strictEqual(aborted.commitOutcome, "rolled_back");
        yield* events.withEvent(
          { type: "request", companyId },
          databases.withCompany(companyId)(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.withTransaction(TestClock.adjust("5 millis"));
              yield* sql
                .withTransaction(
                  sql
                    .unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                    .pipe(Effect.andThen(Effect.fail("close snapshot")))
                )
                .pipe(Effect.exit);
            })
          )
        );
        const committed = yield* Queue.take(recorded);
        assert.strictEqual(committed.type, "request");
        if (committed.type !== "request") return;
        assert.strictEqual(committed.commitOutcome, "committed");
        assert.strictEqual(committed.dbMs, 5);
      })
    );

    it.effect("bounds shared-query authority headroom even for a one-connection company", () =>
      Effect.gen(function* () {
        const companyId = "snapshot-single-slot";
        yield* createCompany(companyId);
        const databases = yield* CompanyDatabases.CompanyDatabases;
        const limits = yield* OperatingLimits.make;
        yield* databases.ensureReady(companyId);
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections",
          value: 1,
          actor: "test"
        });
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections.waiters",
          value: 1,
          actor: "test"
        });
        const refusals = yield* Queue.unbounded<CompanyDatabases.Busy>();
        const attempts = yield* Effect.forEach([1, 2], () =>
          databases.lease(companyId, true).pipe(
            Effect.scoped,
            Effect.tapError((error) =>
              error._tag === "Busy" ? Queue.offer(refusals, error) : Effect.void
            ),
            Effect.exit,
            Effect.forkScoped
          )
        );
        assert.strictEqual((yield* Queue.take(refusals)).limitId, "company.connections.waiters");
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Queue.take(refusals)).limitId, "company.connections.wait");
        for (const attempt of attempts) assert.isTrue(Exit.isFailure(yield* Fiber.join(attempt)));
        const database = yield* Effect.scoped(
          Effect.gen(function* () {
            const lease = yield* databases.lease(companyId, false);
            return yield* lease.run(currentDatabase);
          })
        );
        assert.strictEqual(database, (yield* databases.claim(companyId)).databaseName);
      }).pipe(Effect.scoped)
    );

    it.effect("leases only ready databases without claiming or provisioning", () =>
      Effect.gen(function* () {
        yield* createCompany("lease-only");
        const service = yield* CompanyDatabases.CompanyDatabases;
        const platform = yield* SqlClient.SqlClient;
        const absent = yield* service.withCompany("lease-only")(currentDatabase).pipe(Effect.flip);
        assert.instanceOf(absent, CompanyDatabases.CompanyDatabaseNotReady);
        if (absent._tag === "CompanyDatabaseNotReady") assert.isNull(absent.status);
        assert.deepStrictEqual(
          yield* platform`SELECT company_id FROM company_databases WHERE company_id = 'lease-only'`,
          []
        );
        const claim = yield* service.claim("lease-only");
        const claimed = yield* service.withCompany("lease-only")(currentDatabase).pipe(Effect.flip);
        assert.instanceOf(claimed, CompanyDatabases.CompanyDatabaseNotReady);
        if (claimed._tag === "CompanyDatabaseNotReady")
          assert.strictEqual(claimed.status, "claimed");
        assert.deepStrictEqual(
          yield* platform`SELECT datname FROM pg_database WHERE datname = ${claim.databaseName}`,
          []
        );
        yield* service.ensureReady("lease-only");
        assert.strictEqual(
          yield* service.withCompany("lease-only")(currentDatabase),
          claim.databaseName
        );
      })
    );

    it.effect(
      "leases ready companies while every platform connection holds a patch-row transaction",
      () =>
        Effect.gen(function* () {
          const platform = yield* SqlClient.SqlClient;
          const service = yield* CompanyDatabases.CompanyDatabases;
          const ready = yield* service.ensureReady("cmp_dev");
          const startLeases = yield* Deferred.make<void>();
          const releaseTransactions = yield* Deferred.make<void>();
          const gates = yield* Effect.all(
            Array.from({ length: 10 }, () =>
              Effect.gen(function* () {
                return {
                  locked: yield* Deferred.make<number>(),
                  completed: yield* Deferred.make<string>()
                };
              })
            )
          );
          for (let index = 0; index < gates.length; index++) {
            const patchId = `platform_saturation_${index}`;
            yield* platform`INSERT INTO patches (id, company_id, owner_user_id, title, name)
          VALUES (${patchId}, 'cmp_dev', 'usr_dev', 'Pool saturation', ${`pool-${index}`})`;
          }
          const fibers = yield* Effect.forEach(gates, (gate, index) =>
            platform
              .withTransaction(
                Effect.gen(function* () {
                  const patchId = `platform_saturation_${index}`;
                  yield* platform`SELECT id FROM patches WHERE id = ${patchId} FOR UPDATE`;
                  const [row] = yield* platform<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
                  yield* Deferred.succeed(gate.locked, row!.pid);
                  yield* Deferred.await(startLeases);
                  if (index < 9) {
                    const result = yield* service
                      .withCompany("cmp_dev")(currentDatabase)
                      .pipe(Effect.catchTags({ Busy: () => Effect.succeed("busy") }));
                    yield* Deferred.succeed(gate.completed, result);
                  }
                  yield* Deferred.await(releaseTransactions);
                })
              )
              .pipe(Effect.forkScoped)
          );
          const pids = yield* Effect.forEach(gates, (gate) => Deferred.await(gate.locked));
          assert.strictEqual(new Set(pids).size, 10);
          yield* Deferred.succeed(startLeases, undefined);
          // The tenth transaction is a cleanup escape hatch, not spare capacity:
          // release it only after observing whether all nine leases can settle.
          const completed = yield* Effect.forEach(gates.slice(0, 9), (gate) =>
            Deferred.await(gate.completed)
          ).pipe(Effect.timeout("2 seconds"), TestClock.withLive, Effect.exit);
          yield* Deferred.succeed(releaseTransactions, undefined);
          yield* Effect.forEach(fibers, Fiber.join);
          if (Exit.isFailure(completed)) return yield* Effect.failCause(completed.cause);
          assert.include(completed.value, ready.databaseName);
          for (const result of completed.value)
            assert.include([ready.databaseName, "busy"], result);
        }).pipe(Effect.scoped)
    );

    it.effect(
      "the placement names the database and the login, not the URL's dbname or an empty user",
      () =>
        Effect.gen(function* () {
          yield* createCompany("url-override");
          const url = new URL(inject("postgres").adminUrl);
          url.searchParams.set("dbname", "postgres");
          url.searchParams.set("user", "");
          const context = yield* Layer.build(
            Layer.effect(CompanyDatabases.CompanyDatabases, PgCompanyDatabases.make).pipe(
              Layer.provide(PgCompanyDatabases.placementLayer),
              Layer.provide(PgCompanyDatabases.adminLayer),
              Layer.provide(Reactivity.layer),
              Layer.provide(
                Layer.succeed(PgCompanyDatabases.CompanyDatabaseConfig, {
                  adminUrl: Redacted.make(url.toString()),
                  dataUrl: Redacted.make(url.toString()),
                  maxBackends: 200,
                  capacity: 100
                })
              )
            )
          );
          const service = Context.get(context, CompanyDatabases.CompanyDatabases);
          const placement = yield* service.ensureReady("url-override");
          assert.strictEqual(
            yield* service.withCompany("url-override")(currentDatabase),
            placement.databaseName
          );
        })
    );

    it.effect("races independent registries against one committed claim", () =>
      Effect.gen(function* () {
        yield* createCompany("claim-race");
        const first = yield* CompanyDatabases.CompanyDatabases;
        const url = Redacted.make(inject("postgres").adminUrl);
        const secondContext = yield* Layer.build(
          Layer.effect(CompanyDatabases.CompanyDatabases, PgCompanyDatabases.make).pipe(
            Layer.provide(PgCompanyDatabases.placementLayer),
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

    it.effect("provisions and reclaims with a SET-only grant to a non-superuser admin", () =>
      Effect.gen(function* () {
        yield* createCompany("separate-logins");
        const platform = yield* SqlClient.SqlClient;
        const placement = yield* (yield* CompanyDatabases.CompanyDatabases).claim(
          "separate-logins"
        );
        const suffix = yield* currentDatabase;
        const adminRole = `${suffix}_admin`;
        const dataRole = `${suffix}_data`;
        const adminUrl = new URL(inject("postgres").adminUrl);
        adminUrl.username = adminRole;
        adminUrl.password = "local-test";
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            yield* platform.unsafe(
              `CREATE ROLE ${quoteIdentifier(dataRole)} LOGIN PASSWORD 'local-test'`
            );
            yield* platform.unsafe(
              `CREATE ROLE ${quoteIdentifier(adminRole)} LOGIN CREATEDB NOINHERIT PASSWORD 'local-test'`
            );
            yield* platform.unsafe(
              `GRANT ${quoteIdentifier(dataRole)} TO ${quoteIdentifier(adminRole)} WITH SET TRUE, INHERIT FALSE`
            );
          }),
          () =>
            Effect.gen(function* () {
              yield* Effect.gen(function* () {
                const admin = yield* SqlClient.SqlClient;
                const connection = yield* admin.reserve;
                yield* connection.execute(`SET ROLE ${quoteIdentifier(dataRole)}`, [], undefined);
                yield* connection
                  .execute(
                    `DROP DATABASE IF EXISTS ${quoteIdentifier(placement.databaseName)} WITH (FORCE)`,
                    [],
                    undefined
                  )
                  .pipe(
                    Effect.ensuring(
                      connection.execute("RESET ROLE", [], undefined).pipe(Effect.orDie)
                    )
                  );
              }).pipe(
                Effect.scoped,
                Effect.provide(layerFromUrl(Redacted.make(adminUrl.toString())), { local: true })
              );
              yield* platform.unsafe(`DROP ROLE ${quoteIdentifier(adminRole)}`);
              yield* platform.unsafe(`DROP ROLE ${quoteIdentifier(dataRole)}`);
            }).pipe(Effect.orDie)
        );
        const dataUrl = new URL(adminUrl);
        dataUrl.username = "ignored-authority";
        dataUrl.searchParams.append("user", "ignored-query");
        dataUrl.searchParams.append("user", dataRole);
        const restricted = Layer.effect(
          CompanyDatabases.CompanyDatabases,
          PgCompanyDatabases.make
        ).pipe(
          Layer.provide(PgCompanyDatabases.placementLayer),
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

    it.effect(
      "reads one inventory revision when provisioning commits between component reads",
      () =>
        Effect.gen(function* () {
          yield* createCompany("snapshot-race");
          const service = yield* CompanyDatabases.CompanyDatabases;
          yield* service.ensureReady("snapshot-race");
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
                  yield* inventory.putTable({
                    description: "Notes identified by their row id.",
                    patchId: "snapshot",
                    name: "notes",
                    shared: false
                  });
                  yield* inventory.putColumn({
                    patchId: "snapshot",
                    table: "notes",
                    name: "body",
                    kind: "text",
                    refTable: null,
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
              yield* service.ensureReady("outer-rollback");
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
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) => sql`SELECT value FROM public.company_commit`
            )
          ),
          [{ value: 7 }]
        );
      })
    );

    it.effect("serializes patch DDL on separate sessions and releases a rolled-back lock", () =>
      Effect.gen(function* () {
        yield* createCompany("patch-lock");
        const service = yield* CompanyDatabases.CompanyDatabases;
        yield* service.ensureReady("patch-lock");
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

    it.effect("counts the cold opener before lending the remaining connection slots", () =>
      Effect.gen(function* () {
        const companyId = "cold-pool-capacity";
        yield* createCompany(companyId);
        yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(companyId);
        const platform = yield* SqlClient.SqlClient;
        const limits = yield* OperatingLimits.make;
        const ready = yield* Deferred.make<void>();
        let reads = 0;
        const url = Redacted.make(inject("postgres").adminUrl);
        const service = yield* PgCompanyDatabases.make.pipe(
          Effect.provideService(PgCompanyDatabases.PlacementClient, platform),
          Effect.provideService(PgCompanyDatabases.AdminClient, platform),
          Effect.provideService(PgCompanyDatabases.CompanyDatabaseConfig, {
            adminUrl: url,
            dataUrl: url,
            maxBackends: 4,
            capacity: 1
          }),
          Effect.provideService(OperatingLimits.OperatingLimits, {
            ...limits,
            getMany: (input) =>
              limits.getMany(input).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    reads++;
                    if (reads === 8) yield* Deferred.succeed(ready, undefined);
                    yield* Deferred.await(ready);
                  })
                )
              )
          }),
          Effect.provide(Reactivity.layer)
        );
        const scheduler = new Scheduler.MixedScheduler();
        const dispatcher = scheduler.makeDispatcher();
        scheduler.makeDispatcher = () => dispatcher;
        const outcomes = yield* Queue.unbounded<"admitted" | CompanyDatabases.Busy>();
        yield* Effect.forEach(Array.from({ length: 8 }), () =>
          service
            .withCompany(companyId)(
              Queue.offer(outcomes, "admitted").pipe(Effect.andThen(Effect.never))
            )
            .pipe(
              Effect.catchTags({
                Busy: (error) => Queue.offer(outcomes, error)
              }),
              // Force contenders to run during lazy pool construction, not only after it.
              Effect.provideService(Scheduler.Scheduler, scheduler),
              Effect.provideService(Scheduler.MaxOpsBeforeYield, 16),
              Effect.forkScoped
            )
        );
        yield* Deferred.await(ready);
        // Drain cooperative yields so every lease or queue timer exists before time advances.
        yield* Effect.yieldNow;
        yield* Effect.sync(() => dispatcher.flush());
        yield* TestClock.adjust("1 second");
        const results = yield* Effect.forEach(Array.from({ length: 8 }), () =>
          Queue.take(outcomes)
        );
        assert.strictEqual(results.filter((result) => result === "admitted").length, 4);
        for (const result of results) {
          if (result === "admitted") continue;
          assert.strictEqual(result.limitId, "company.connections.wait");
          assert.strictEqual(result.value, 1_000);
        }
      }).pipe(Effect.scoped)
    );

    it.effect("bounds the queue at 32 and records the one-second connection wait", () =>
      Effect.gen(function* () {
        const companyId = "operation-capacity";
        yield* createCompany(companyId);
        const service = yield* CompanyDatabases.CompanyDatabases;
        yield* service.ensureReady(companyId);
        const holders = yield* holdConnections(companyId, 4);
        const refused = yield* Queue.unbounded<CompanyDatabases.Busy>();
        const recorded = yield* Queue.unbounded<WideEvents.WideEvent>();
        const events = yield* WideEvents.make.pipe(
          Effect.provideService(WideEvents.Sink, {
            write: (event) => Queue.offer(recorded, event).pipe(Effect.asVoid)
          })
        );
        const queued = yield* Effect.forEach(Array.from({ length: 33 }), () =>
          events
            .withEvent(
              { type: "request", companyId },
              service.withCompany(companyId)(currentDatabase)
            )
            .pipe(
              Effect.catchTags({
                Busy: (error) =>
                  Queue.offer(refused, error).pipe(Effect.andThen(Effect.fail(error)))
              }),
              Effect.exit,
              Effect.forkScoped
            )
        );
        // Observing overflow proves that all 32 waiting slots are occupied.
        const overflow = yield* Queue.take(refused);
        assert.strictEqual(overflow.limitId, "company.connections.waiters");
        assert.strictEqual(overflow.scope, "company");
        assert.strictEqual(overflow.value, 32);
        assert.strictEqual(overflow.retryAfterSeconds, 1);
        yield* TestClock.adjust("999 millis");
        assert.strictEqual(yield* Queue.size(refused), 0);
        yield* TestClock.adjust("1 millis");
        yield* Effect.forEach(queued, Fiber.join);
        for (let index = 0; index < 32; index++) {
          const timeout = yield* Queue.take(refused);
          assert.strictEqual(timeout.limitId, "company.connections.wait");
          assert.strictEqual(timeout.value, 1_000);
          assert.strictEqual(timeout.scope, "company");
          assert.strictEqual(timeout.retryAfterSeconds, 1);
        }
        const emitted = yield* Effect.forEach(Array.from({ length: 33 }), () =>
          Queue.take(recorded)
        );
        const waits = emitted.filter(
          (event): event is WideEvents.RequestEvent =>
            event.type === "request" && event.queueWaitMs !== undefined
        );
        assert.strictEqual(waits.length, 32);
        assert.isTrue(waits.every((event) => event.queueWaitMs === 1_000));
        assert.isTrue(waits.every((event) => event.connectionWaitMs === 1_000));
        yield* Effect.forEach(holders, Fiber.interrupt);
        // Timed-out waiters and interrupted holders leave all four slots reusable.
        yield* holdConnections(companyId, 4);
      }).pipe(Effect.scoped)
    );

    it.effect("honors queue overrides and frees cancelled or deadline-expired waiters", () =>
      Effect.gen(function* () {
        const companyId = "queue-override";
        yield* createCompany(companyId);
        const service = yield* CompanyDatabases.CompanyDatabases;
        const limits = yield* OperatingLimits.make;
        yield* service.ensureReady(companyId);
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections.waiters",
          value: 1,
          actor: "test"
        });
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections.wait",
          value: 250,
          actor: "test"
        });
        const holders = yield* holdConnections(companyId, 4);
        const refused = yield* Queue.unbounded<CompanyDatabases.Busy>();
        const attempt = service
          .withCompany(companyId)(currentDatabase)
          .pipe(
            Effect.catchTags({
              Busy: (error) => Queue.offer(refused, error).pipe(Effect.andThen(Effect.fail(error)))
            })
          );
        const queued = yield* Effect.forEach([0, 1], () =>
          attempt.pipe(Effect.exit, Effect.forkScoped)
        );
        assert.strictEqual((yield* Queue.take(refused)).value, 1);
        yield* TestClock.adjust("250 millis");
        const timeout = yield* Queue.take(refused);
        assert.strictEqual(timeout.limitId, "company.connections.wait");
        assert.strictEqual(timeout.value, 250);
        yield* Effect.forEach(queued, Fiber.join);

        const deadline = yield* Effect.forEach([0, 1], () =>
          attempt.pipe(
            Effect.timeout("100 millis"),
            Effect.catchTags({ TimeoutError: () => Effect.succeed("caller deadline") }),
            Effect.exit,
            Effect.forkScoped
          )
        );
        assert.strictEqual((yield* Queue.take(refused)).limitId, "company.connections.waiters");
        yield* TestClock.adjust("100 millis");
        const deadlineExits = yield* Effect.forEach(deadline, Fiber.join);
        assert.strictEqual(
          deadlineExits.filter((exit) => Exit.isSuccess(exit) && exit.value === "caller deadline")
            .length,
          1
        );

        const cancelled = yield* Effect.forEach([0, 1], () =>
          attempt.pipe(Effect.exit, Effect.forkScoped)
        );
        assert.strictEqual((yield* Queue.take(refused)).limitId, "company.connections.waiters");
        yield* Effect.forEach(cancelled, Fiber.interrupt);
        const resumed = yield* Effect.forEach([0, 1], () =>
          attempt.pipe(Effect.exit, Effect.forkScoped)
        );
        assert.strictEqual((yield* Queue.take(refused)).limitId, "company.connections.waiters");
        yield* Fiber.interrupt(holders[0]!);
        const resumedExits = yield* Effect.forEach(resumed, Fiber.join);
        assert.strictEqual(resumedExits.filter((exit) => Exit.isSuccess(exit)).length, 1);
      }).pipe(Effect.scoped)
    );

    it.effect("drains old pools before applying an override to one company", () =>
      Effect.gen(function* () {
        const service = yield* CompanyDatabases.CompanyDatabases;
        const limits = yield* OperatingLimits.make;
        const companyId = "pool-override";
        const otherId = "pool-unchanged";
        yield* createCompany(companyId);
        yield* createCompany(otherId);
        const placement = yield* service.ensureReady(companyId);
        yield* service.ensureReady(otherId);
        const held = yield* holdConnections(companyId, 4);
        const otherHeld = yield* holdConnections(otherId, 4);
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections",
          value: 6,
          actor: "test"
        });
        const admitted = yield* Deferred.make<void>();
        // Overflow proves that the replacement is waiting for the old generation.
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections.waiters",
          value: 1,
          actor: "test"
        });
        const refused = yield* Queue.unbounded<CompanyDatabases.Busy>();
        const next = yield* Effect.forEach([0, 1], () =>
          service
            .withCompany(companyId)(
              Deferred.succeed(admitted, undefined).pipe(Effect.andThen(currentDatabase))
            )
            .pipe(
              Effect.catchTags({
                Busy: (error) =>
                  Queue.offer(refused, error).pipe(Effect.andThen(Effect.fail(error)))
              }),
              Effect.exit,
              Effect.forkScoped
            )
        );
        assert.strictEqual((yield* Queue.take(refused)).limitId, "company.connections.waiters");
        assert.isFalse(yield* Deferred.isDone(admitted));
        yield* Effect.forEach(held, Fiber.interrupt);
        const nextExits = yield* Effect.forEach(next, Fiber.join);
        assert.strictEqual(
          nextExits.filter((exit) => Exit.isSuccess(exit) && exit.value === placement.databaseName)
            .length,
          1
        );
        const raised = yield* holdConnections(companyId, 6);
        const platform = yield* SqlClient.SqlClient;
        const [backends] = yield* platform<{ count: number }>`
        SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = ${placement.databaseName}`;
        assert.strictEqual(backends!.count, 6);

        yield* limits.setOverride({
          companyId: otherId,
          limitId: "company.connections.waiters",
          value: 1,
          actor: "test"
        });
        const otherWait = yield* Effect.forEach([0, 1], () =>
          service
            .withCompany(otherId)(currentDatabase)
            .pipe(
              Effect.catchTags({
                Busy: (error) =>
                  Queue.offer(refused, error).pipe(Effect.andThen(Effect.fail(error)))
              }),
              Effect.exit,
              Effect.forkScoped
            )
        );
        assert.strictEqual((yield* Queue.take(refused)).limitId, "company.connections.waiters");
        yield* Fiber.interrupt(otherHeld[0]!);
        assert.strictEqual(
          (yield* Effect.forEach(otherWait, Fiber.join)).filter(Exit.isSuccess).length,
          1
        );
        yield* limits.removeOverride({ companyId, limitId: "company.connections", actor: "test" });
        yield* Effect.forEach(raised, Fiber.interrupt);
        yield* holdConnections(companyId, 4);
      }).pipe(Effect.scoped)
    );

    it.effect("provisions while template1 has a connected session", () =>
      Effect.gen(function* () {
        const companyId = "busy-template";
        yield* createCompany(companyId);
        const url = new URL(inject("postgres").adminUrl);
        url.pathname = "/template1";
        const context = yield* Layer.build(layerFromUrl(Redacted.make(url.toString())));
        const template = Context.get(context, SqlClient.SqlClient);
        assert.deepStrictEqual(yield* template`SELECT current_database() AS database`, [
          { database: "template1" }
        ]);
        assert.strictEqual(
          (yield* (yield* CompanyDatabases.CompanyDatabases).ensureReady(companyId)).status,
          "ready"
        );
      }).pipe(Effect.scoped)
    );

    it.effect(
      "opens a new pool for a placement version instead of reusing the retained old pool",
      () =>
        Effect.gen(function* () {
          yield* createCompany("placement-version");
          const service = yield* CompanyDatabases.CompanyDatabases;
          yield* service.ensureReady("placement-version");
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
  }
);

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

it.layer(
  Testing.layer({ adminLayer: interruptedCreate }).pipe(
    Layer.provideMerge(Testing.resourceChangesLayer)
  )
)("Interrupted company creation", (it) => {
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
  it.layer(Testing.layer(limits).pipe(Layer.provideMerge(Testing.resourceChangesLayer)))(
    name,
    (it) => {
      it.effect(
        "counts idle pools, evicts after 60 seconds, and admits the previously refused company",
        () =>
          Effect.gen(function* () {
            yield* createCompany("capacity-second");
            const service = yield* CompanyDatabases.CompanyDatabases;
            yield* service.ensureReady("cmp_dev");
            yield* service.ensureReady("capacity-second");
            yield* service.withCompany("cmp_dev")(currentDatabase);
            const refused = yield* service
              .withCompany("capacity-second")(currentDatabase)
              .pipe(Effect.flip);
            assert.strictEqual(refused._tag, "Busy");
            if (refused._tag === "Busy") assert.strictEqual(refused.resource, resource);
            yield* TestClock.adjust("59 seconds");
            assert.strictEqual(
              (yield* service.withCompany("capacity-second")(currentDatabase).pipe(Effect.flip))
                ._tag,
              "Busy"
            );
            yield* TestClock.adjust("1 second");
            assert.strictEqual(
              yield* service.withCompany("capacity-second")(currentDatabase),
              (yield* service.claim("capacity-second")).databaseName
            );
          })
      );
    }
  );
}

it.layer(
  Testing.layer({ maxBackends: 8, capacity: 2 }).pipe(
    Layer.provideMerge(Testing.resourceChangesLayer)
  )
)("Failed pool opens", (it) => {
  it.effect("does not retain a registry slot when the backend budget refuses a pool", () =>
    Effect.gen(function* () {
      const service = yield* CompanyDatabases.CompanyDatabases;
      const limits = yield* OperatingLimits.make;
      for (const companyId of ["too-large", "fits-budget"]) {
        yield* createCompany(companyId);
        yield* service.ensureReady(companyId);
      }
      yield* service.ensureReady("cmp_dev");
      yield* service.withCompany("cmp_dev")(currentDatabase);
      yield* limits.setOverride({
        companyId: "too-large",
        limitId: "company.connections",
        value: 8,
        actor: "pool-open-test"
      });
      const refused = yield* service.withCompany("too-large")(currentDatabase).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "Busy");
      if (refused._tag === "Busy")
        assert.strictEqual(refused.limitId, "company.connections.hostBackends");
      assert.strictEqual(
        yield* service.withCompany("fits-budget")(currentDatabase),
        (yield* service.claim("fits-budget")).databaseName
      );
    })
  );
});

it.layer(Testing.layer({ maxBackends: 8 }).pipe(Layer.provideMerge(Testing.resourceChangesLayer)))(
  "Refused pool resize",
  (it) => {
    it.effect("retains the working pool and its budget until a replacement fits", () =>
      Effect.gen(function* () {
        const service = yield* CompanyDatabases.CompanyDatabases;
        const limits = yield* OperatingLimits.make;
        const companyId = "cmp_dev";
        const otherId = "resize-budget-holder";
        yield* createCompany(otherId);
        yield* service.ensureReady(companyId);
        yield* service.ensureReady(otherId);
        const pid = Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.pipe(
            Effect.map((rows) => rows[0]!.pid)
          )
        );
        const before = yield* service.withCompany(companyId)(pid);
        yield* service.withCompany(otherId)(currentDatabase);
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections",
          value: 6,
          actor: "test"
        });
        const refused = yield* service.withCompany(companyId)(currentDatabase).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "Busy");
        if (refused._tag === "Busy") {
          assert.strictEqual(refused.limitId, "company.connections.hostBackends");
          assert.strictEqual(refused.value, 8);
        }
        const platform = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* platform<{ pid: number }>`SELECT pid FROM pg_stat_activity WHERE pid = ${before}`,
          [{ pid: before }]
        );
        yield* limits.removeOverride({ companyId, limitId: "company.connections", actor: "test" });
        assert.strictEqual(yield* service.withCompany(companyId)(pid), before);
      })
    );
  }
);

it.layer(Testing.layer({ maxBackends: 8 }).pipe(Layer.provideMerge(Testing.resourceChangesLayer)))(
  "Overridden retained maxima",
  (it) => {
    it.effect("resizes without double reserving and still budgets idle pool maxima", () =>
      Effect.gen(function* () {
        const service = yield* CompanyDatabases.CompanyDatabases;
        const limits = yield* OperatingLimits.make;
        const companyId = "cmp_dev";
        const otherId = "overridden-budget";
        yield* createCompany(otherId);
        yield* service.ensureReady(companyId);
        yield* service.ensureReady(otherId);
        yield* service.withCompany(companyId)(currentDatabase);
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections",
          value: 6,
          actor: "test"
        });
        // Old four plus new six would exceed eight; drain and replace reserves only six.
        yield* service.withCompany(companyId)(currentDatabase);
        const refused = yield* service.withCompany(otherId)(currentDatabase).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "Busy");
        if (refused._tag === "Busy") {
          assert.strictEqual(refused.limitId, "company.connections.hostBackends");
          assert.strictEqual(refused.value, 8);
          assert.strictEqual(refused.scope, "host");
        }
        yield* limits.setOverride({
          companyId,
          limitId: "company.connections",
          value: 2,
          actor: "test"
        });
        yield* service.withCompany(companyId)(currentDatabase);
        assert.strictEqual(
          yield* service.withCompany(otherId)(currentDatabase),
          (yield* service.claim(otherId)).databaseName
        );
      })
    );
  }
);

it.effect("closes company pools before dropping a test block's databases", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      Testing.layer().pipe(Layer.provideMerge(Testing.resourceChangesLayer)),
      scope
    );
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
