import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Dev from "./Dev.js";
import * as Execution from "./Execution.js";
import { nativeType, quoteIdentifier } from "./Mapping.js";
import type { ColumnType, Snapshot } from "./Snapshot.js";

const native = (baseName: string): typeof ColumnType.Type => ({
  schema: "pg_catalog",
  name: baseName,
  sql: baseName,
  baseSchema: "pg_catalog",
  baseName,
  kind: "base"
});
const declaration = {
  kind: "postgres" as const,
  id: "fixture_connection",
  handle: "warehouse",
  revision: 1
};
const snapshot: typeof Snapshot.Type = {
  version: 1,
  enums: [{ schema: "public", name: "status", labels: ["new", "it's done"] }],
  exclusions: [],
  relations: [
    {
      schema: "public",
      name: "invoices",
      kind: "table",
      primaryKey: { name: "pk", columns: ["id"] },
      foreignKeys: [],
      columns: [
        { name: "id", type: native("int8"), nullable: false },
        {
          name: "amount",
          type: {
            ...native("numeric"),
            schema: "sales",
            name: "amount_domain",
            sql: "numeric); DROP TABLE invoices; --"
          },
          nullable: false
        },
        { name: "at", type: native("timestamptz"), nullable: false },
        {
          name: "status",
          type: {
            schema: "public",
            name: "status",
            baseSchema: "public",
            baseName: "status",
            sql: "status",
            kind: "enum"
          },
          nullable: false
        },
        { name: "tags", type: { ...native("_text"), kind: "array" }, nullable: true },
        { name: "location", type: native("point"), nullable: true }
      ]
    }
  ]
};
const fixtureSql = `INSERT INTO public.invoices VALUES
('9007199254740993', 2, '2024-03-01 00:00:00.123456+02', 'new', ARRAY['a','b']),
('9007199254740994', 10, '2024-03-01 00:00:00.000001Z', 'it''s done', NULL);
CREATE FUNCTION public.write_fixture() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN UPDATE public.invoices SET amount = 99; RETURN 1; END $$;`;

it.layer(Layer.merge(NodeFileSystem.layer, NodePath.layer))("Postgres dev fixture", (it) => {
  it.effect("names the mandatory fixture and refuses path traversal before filesystem access", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "postgres-missing-" });
      const error = yield* Effect.gen(function* () {
        yield* Execution.Execution;
      }).pipe(
        Effect.provide(
          Dev.dev(snapshot, { connectionId: declaration.id, handle: declaration.handle, root })
        ),
        Effect.flip
      );
      assert.instanceOf(error, Dev.FixtureMissing);
      if (error instanceof Dev.FixtureMissing)
        assert.strictEqual(error.path, `${root}/fixtures/postgres-warehouse.sql`);
      const traversal = yield* Effect.gen(function* () {
        yield* Execution.Execution;
      }).pipe(
        Effect.provide(
          Dev.dev(snapshot, { connectionId: "../outside", handle: declaration.handle, root })
        ),
        Effect.flip
      );
      assert.instanceOf(traversal, Dev.FixtureConfiguration);
    }).pipe(Effect.scoped)
  );

  it.effect(
    "executes native fixtures with exact numeric comparisons, microseconds and real read-only failures",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "postgres-native-fixture-" });
        yield* fs.makeDirectory(`${root}/fixtures`);
        yield* fs.writeFileString(`${root}/fixtures/postgres-warehouse.sql`, fixtureSql);
        yield* Effect.gen(function* () {
          const execution = yield* Execution.Execution;
          const input = { companyId: "dev", declaration, parameters: [] };
          const result = yield* execution.query({
            ...input,
            text: 'SELECT id, amount, "at", status, tags FROM public.invoices WHERE amount > $1 ORDER BY amount',
            parameters: ["3"]
          });
          assert.deepStrictEqual(result.rows, [
            ["9007199254740994", "10", "2024-03-01 00:00:00.000001+00", "it's done", null]
          ]);
          const denied = yield* execution
            .query({ ...input, text: "INSERT INTO public.invoices SELECT * FROM public.invoices" })
            .pipe(Effect.flip);
          assert.instanceOf(denied, Execution.InvalidQuery);
          if (denied instanceof Execution.InvalidQuery)
            assert.strictEqual(denied.details.sqlstate, "25006");
          const functionDenied = yield* execution
            .query({ ...input, text: "SELECT public.write_fixture()" })
            .pipe(Effect.flip);
          assert.instanceOf(functionDenied, Execution.InvalidQuery);
          const unchanged = yield* execution.query({
            ...input,
            text: "SELECT amount FROM public.invoices ORDER BY amount"
          });
          assert.deepStrictEqual(unchanged.rows, [["2"], ["10"]]);
          const tooMany = yield* execution
            .query({ ...input, text: "SELECT generate_series(1, 1001)" })
            .pipe(Effect.flip);
          assert.instanceOf(tooMany, Execution.TooLarge);
          const unsupported = yield* execution
            .query({ ...input, text: "COPY (SELECT 1) TO STDOUT" })
            .pipe(Effect.flip);
          assert.instanceOf(unsupported, Execution.InvalidQuery);
          if (unsupported instanceof Execution.InvalidQuery) {
            assert.strictEqual(unsupported.details.sqlstate, "0A000");
            assert.include(unsupported.details.message, "COPY");
            assert.strictEqual(unsupported.message, denied.message);
          }
          const duplicate = yield* execution.query({
            ...input,
            text: "SELECT 1 AS duplicate, 2 AS duplicate"
          });
          assert.deepStrictEqual(
            duplicate.fields.map((field) => field.name),
            ["duplicate", "duplicate"]
          );
          assert.deepStrictEqual(duplicate.rows, [[1, 2]]);
        }).pipe(
          Effect.provide(
            Dev.dev(snapshot, { connectionId: declaration.id, handle: declaration.handle, root })
          ),
          Effect.scoped
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "recreates persisted state when either the fixture or snapshot changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "postgres-stamp-" });
        yield* fs.makeDirectory(`${root}/fixtures`);
        const path = `${root}/fixtures/postgres-warehouse.sql`;
        yield* fs.writeFileString(path, fixtureSql);
        const read = Effect.gen(function* () {
          const execution = yield* Execution.Execution;
          return yield* execution.query({
            companyId: "dev",
            declaration,
            parameters: [],
            text: "SELECT amount FROM public.invoices ORDER BY amount"
          });
        });
        const config = { connectionId: declaration.id, handle: declaration.handle, root };
        assert.deepStrictEqual(
          (yield* read.pipe(Effect.provide(Dev.dev(snapshot, config)), Effect.scoped)).rows,
          [["2"], ["10"]]
        );
        yield* fs.writeFileString(path, fixtureSql.replace(" 2,", " 7,"));
        assert.deepStrictEqual(
          (yield* read.pipe(Effect.provide(Dev.dev(snapshot, config)), Effect.scoped)).rows,
          [["7"], ["10"]]
        );
        const added = { name: 'new"column', type: native("text"), nullable: true };
        const changed = {
          ...snapshot,
          relations: [
            { ...snapshot.relations[0]!, columns: [...snapshot.relations[0]!.columns, added] }
          ]
        };
        // Explicit column names keep agent-authored rows valid as a nullable snapshot column is added.
        yield* fs.writeFileString(
          path,
          fixtureSql.replace(
            "public.invoices VALUES",
            'public.invoices (id, amount, "at", status, tags) VALUES'
          )
        );
        const fresh = yield* Effect.gen(function* () {
          const execution = yield* Execution.Execution;
          return yield* execution.query({
            companyId: "dev",
            declaration,
            parameters: [],
            text: `SELECT ${quoteIdentifier(added.name)} FROM public.invoices`
          });
        }).pipe(Effect.provide(Dev.dev(changed, config)), Effect.scoped);
        assert.deepStrictEqual(fresh.rows, [[null], [null]]);
        assert.strictEqual(
          nativeType(snapshot.relations[0]!.columns[1]!.type, snapshot),
          '"pg_catalog"."numeric"'
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "destroys timed-out workers and reopens the same fixture for the next call",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "postgres-deadline-" });
        yield* fs.makeDirectory(`${root}/fixtures`);
        yield* fs.writeFileString(`${root}/fixtures/postgres-warehouse.sql`, fixtureSql);
        yield* Effect.gen(function* () {
          const execution = yield* Execution.Execution;
          const input = { companyId: "dev", declaration, parameters: [] };
          const fiber = yield* execution
            .query({ ...input, text: "SELECT pg_sleep(60)" })
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("15 seconds");
          assert.instanceOf(yield* Fiber.join(fiber), Execution.Timeout);
          assert.deepStrictEqual(
            (yield* execution.query({
              ...input,
              text: "SELECT id, amount FROM public.invoices ORDER BY amount"
            })).rows,
            [
              ["9007199254740993", "2"],
              ["9007199254740994", "10"]
            ]
          );
        }).pipe(
          Effect.provide(
            Dev.dev(snapshot, { connectionId: declaration.id, handle: declaration.handle, root })
          ),
          Effect.scoped
        );
      }).pipe(Effect.scoped),
    30_000
  );
});
