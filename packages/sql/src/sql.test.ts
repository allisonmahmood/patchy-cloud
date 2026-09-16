import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LEDGER_TABLE, migrate, type Migrations } from "./index.js";
import * as Testing from "./testing.js";

const ddl = (statement: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement));

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
  it.effect("migrates an empty database in id order and records the ledger once", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* ledger, [
        { id: 1, name: "widgets" },
        { id: 2, name: "gadgets" }
      ]);
      assert.deepStrictEqual(yield* tables, ["gadgets", LEDGER_TABLE, "widgets"]);
      assert.deepStrictEqual(yield* migrate({ ...widgets, ...gadgets }), []);
    })
  );

  it.effect("refuses a duplicate id across records before running anything", () =>
    Effect.gen(function* () {
      const error = yield* migrate({
        ...widgets,
        ...gadgets,
        "2_gadgets_again": gadgets["2_gadgets"]!
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MigrationError");
      assert.strictEqual(error.kind, "Duplicates");
      assert.deepStrictEqual(yield* tables, ["gadgets", LEDGER_TABLE, "widgets"]);
    })
  );

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
