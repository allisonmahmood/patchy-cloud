import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import {
  LEDGER_TABLE,
  migrate,
  pool,
  unsupportedUrlParameters,
  withReportedCommit,
  type Migrations
} from "./index.js";
import * as Testing from "./testing.js";

const ddl = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement));

it("reports hostile parameter names as bounded printable ASCII", () => {
  const names = Array.from({ length: 12 }, (_, index) => `x${index}`);
  const hostile = `postgresql://user:secret@127.0.0.1:1/db?${names.map((name) => `${name}=1`).join("&")}&${encodeURIComponent("bad\nname")}=1&${"k".repeat(8192)}=1`;
  const reported = unsupportedUrlParameters(Redacted.make(hostile));
  assert.strictEqual(reported.length, 8);
  assert.deepStrictEqual(reported, names.slice(0, 8));
  const tail = unsupportedUrlParameters(
    Redacted.make(
      `postgresql://u:p@127.0.0.1:1/db?${encodeURIComponent("bad\nname")}=1&${"k".repeat(8192)}=1`
    )
  );
  assert.deepStrictEqual(tail, ["bad?name", "k".repeat(64)]);
});

it.effect("refuses a URL parameter the client does not read instead of dropping it", () =>
  Effect.gen(function* () {
    const failure = yield* pool({
      url: Redacted.make(
        "postgresql://user:secret@127.0.0.1:1/db?ssl=true&statement_timeout=5&sslmode=require"
      )
    }).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "UnsupportedUrlParameters");
    assert.deepStrictEqual(failure._tag === "UnsupportedUrlParameters" ? failure.parameters : [], [
      "ssl",
      "statement_timeout"
    ]);
  }).pipe(Effect.scoped, Effect.provide(Reactivity.layer))
);

/** Two stand-in capability records, spread the way `{ ...auth, ...patches }` will be. */
const widgets: Migrations = { "1_widgets": ddl("CREATE TABLE widgets (id integer PRIMARY KEY)") };
const gadgets: Migrations = {
  "2_gadgets": ddl(
    "CREATE TABLE gadgets (id integer PRIMARY KEY, widget_id integer REFERENCES widgets(id))"
  )
};

const ledger = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`SELECT migration_id AS id, name FROM ${sql(LEDGER_TABLE)} ORDER BY migration_id`
);

const tables = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<{
      table_name: string;
    }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
).pipe(Effect.map((rows) => rows.map((row) => row.table_name)));

it.layer(Testing.emptyLayer({ ...widgets, ...gadgets }))("migrator", (it) => {
  it.effect("applies a new pending step to an already-migrated database", () =>
    Effect.gen(function* () {
      const applied = yield* migrate({
        ...widgets,
        ...gadgets,
        "3_sprockets": ddl("CREATE TABLE sprockets (id integer PRIMARY KEY)")
      });
      assert.deepStrictEqual(applied, [[3, "sprockets"]]);
      assert.deepStrictEqual(yield* tables, ["gadgets", LEDGER_TABLE, "sprockets", "widgets"]);
      assert.deepStrictEqual(
        (yield* ledger).map((row) => row.id),
        [1, 2, 3]
      );
      yield* ddl("DROP TABLE sprockets");
      yield* ddl(`DELETE FROM ${LEDGER_TABLE} WHERE migration_id = 3`);
    })
  );

  it.effect("applies pending steps in one transaction: a failing step rolls the batch back", () =>
    Effect.gen(function* () {
      const exit = yield* migrate({
        ...widgets,
        ...gadgets,
        "3_sprockets": ddl("CREATE TABLE sprockets (id integer PRIMARY KEY)"),
        "4_broken": ddl("CREATE TABLE sprockets (id integer PRIMARY KEY)")
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
      assert.deepStrictEqual(yield* tables, ["gadgets", LEDGER_TABLE, "widgets"]);
      assert.strictEqual((yield* ledger).length, 2);
    })
  );
});

it.layer(Testing.emptyLayer({ ...widgets, ...gadgets }))("ledger history", (it) => {
  it.effect("refuses a database migrated before a squash, and applies nothing", () =>
    Effect.gen(function* () {
      const error = yield* migrate({
        "1_parts": ddl("CREATE TABLE parts (id integer PRIMARY KEY)")
      }).pipe(Effect.flip);
      assert.instanceOf(error, Migrator.MigrationError);
      assert.strictEqual(error.kind, "BadState");
      assert.include(error.message, 'at id 1: the ledger has "widgets", this build has "parts"');
      assert.include(error.message, "pnpm dev reset");
      assert.deepStrictEqual(yield* tables, ["gadgets", LEDGER_TABLE, "widgets"]);
      assert.strictEqual((yield* ledger).length, 2);
    })
  );

  it.effect("refuses a step the ledger skipped below its highest id", () =>
    Effect.gen(function* () {
      const cogs: Migrations = { "4_cogs": ddl("CREATE TABLE cogs (id integer PRIMARY KEY)") };
      assert.deepStrictEqual(yield* migrate({ ...widgets, ...gadgets, ...cogs }), [[4, "cogs"]]);
      const error = yield* migrate({
        ...widgets,
        ...gadgets,
        "3_sprockets": ddl("CREATE TABLE sprockets (id integer PRIMARY KEY)"),
        ...cogs
      }).pipe(Effect.flip);
      assert.instanceOf(error, Migrator.MigrationError);
      assert.strictEqual(error.kind, "BadState");
      assert.include(error.message, 'at id 3: the ledger has nothing, this build has "sprockets"');
      assert.deepStrictEqual(yield* tables, ["cogs", "gadgets", LEDGER_TABLE, "widgets"]);
      yield* ddl("DROP TABLE cogs");
      yield* ddl(`DELETE FROM ${LEDGER_TABLE} WHERE migration_id = 4`);
    })
  );

  it.effect("starts an earlier build on a ledger a newer build advanced", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* migrate(widgets), []);
      assert.strictEqual((yield* ledger).length, 2);
    })
  );
});

/** A table whose COMMIT sleeps, through a deferred constraint trigger. */
const slowCommit: Migrations = {
  "1_slow_commit": Effect.forEach(
    [
      "CREATE TABLE reported (id integer PRIMARY KEY)",
      "CREATE FUNCTION slow_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$",
      "CREATE CONSTRAINT TRIGGER reported_slow_commit AFTER INSERT ON reported DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slow_commit()"
    ],
    ddl,
    { discard: true }
  )
};

it.layer(Testing.emptyLayer(slowCommit))("reported commits", (it) => {
  /** Waits until another connection is running `query`. */
  const running = (query: string) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND query ILIKE ${query}`
    ).pipe(
      Effect.repeat({ until: (rows) => rows.length === 1 }),
      Effect.timeout("10 seconds"),
      TestClock.withLive
    );
  const stored = (id: number) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT id FROM reported WHERE id = ${id}`);

  it.effect("reports a change whose COMMIT is interrupted, once it has committed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reports: number[] = [];
      const change = withReportedCommit(
        sql`INSERT INTO reported (id) VALUES (1)`.pipe(Effect.as(1)),
        (id) => Effect.sync(() => void reports.push(id))
      );
      const fiber = yield* Effect.forkChild(change);
      yield* running("commit%");
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(reports, [1]);
      assert.strictEqual((yield* stored(1)).length, 1);
    })
  );

  it.effect("reports nothing for a change cancelled before it commits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reports: number[] = [];
      const change = withReportedCommit(
        sql`INSERT INTO reported (id) VALUES (2)`.pipe(
          Effect.andThen(sql`SELECT pg_sleep(30)`),
          Effect.as(2)
        ),
        (id) => Effect.sync(() => void reports.push(id))
      );
      const fiber = yield* Effect.forkChild(change);
      yield* running("%pg_sleep(30)%");
      yield* Fiber.interrupt(fiber);
      assert.deepStrictEqual(reports, []);
      assert.strictEqual((yield* stored(2)).length, 0);
    })
  );

  it.effect("leaves reporting to the caller's own transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const reports: number[] = [];
      yield* sql.withTransaction(
        withReportedCommit(sql`INSERT INTO reported (id) VALUES (3)`.pipe(Effect.as(3)), (id) =>
          Effect.sync(() => void reports.push(id))
        )
      );
      assert.deepStrictEqual(reports, []);
      assert.strictEqual((yield* stored(3)).length, 1);
    })
  );
});
