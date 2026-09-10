import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { TablePage } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { PgliteCompanyDatabases } from "@patchy/company-database/dev";
import * as Testing from "@patchy/company-database/testing";
import * as Tables from "./Tables.js";
import * as TableOperations from "./TableOperations.js";
import { Binding } from "@patchy/runtime";
import {
  boundsContract,
  expandedResultsContract,
  indexKeyContract,
  operationsContract,
  setup,
  manifest,
  uuidContract
} from "./test/operationsContract.js";

const decodePage = Schema.decodeUnknownEffect(TablePage);
const postgres = Tables.layer.pipe(Layer.provideMerge(Testing.layer()));
it.layer(postgres)("TableOperations / Postgres", (it) => {
  it.effect(
    "obeys the seven operation contracts and stable version-bound cursors",
    () => operationsContract("cmp_dev"),
    60_000
  );
  it.effect(
    "enforces configurable item, row, batch, page and response bounds",
    () => boundsContract("cmp_dev"),
    60_000
  );
  it.effect(
    "bounds multirow reads and rolls back batches expanded by database defaults",
    () => expandedResultsContract("cmp_dev"),
    60_000
  );
  it.effect(
    "reports oversized explicit and implicit index keys without restricting unindexed values",
    () => indexKeyContract("cmp_dev"),
    60_000
  );
  it.effect("generates UUIDv7 timestamps and independently varying random fields", () =>
    uuidContract("cmp_dev")
  );
  it.effect(
    "limits real indexed list scans before timestamp formatting on 100,000 rows",
    () =>
      Effect.gen(function* () {
        const definition = {
          ...manifest,
          tables: {
            notes: {
              columns: { title: { kind: "text" as const } },
              indexes: { byTitle: { columns: ["title"] } }
            }
          }
        };
        const { databases, binding } = yield* setup("cmp_dev", "listplans001", definition);
        const qualified = `${Inventory.quoteIdentifier(Inventory.namespace(binding.patchId))}."notes"`;
        yield* databases.withCompany("cmp_dev")(
          Effect.gen(function* () {
            const sql = yield* CompanyDatabases.CompanyConnection;
            yield* sql.unsafe(
              `INSERT INTO ${qualified} ("id", "title", "createdAt")
              SELECT lpad(n::text, 12, '0'), 'note-' || n,
                '2026-01-01T00:00:00Z'::timestamptz + n * interval '1 second'
              FROM generate_series(1, 100000) AS n`
            );
            yield* sql.unsafe(`ANALYZE ${qualified}`);
          })
        );
        const captured: Array<{ query: string; params: ReadonlyArray<unknown> }> = [];
        const withCompany: CompanyDatabases.CompanyDatabases["Service"]["withCompany"] =
          (companyId) => (effect) =>
            databases.withCompany(companyId)(
              Effect.gen(function* () {
                const sql = yield* CompanyDatabases.CompanyConnection;
                const unsafe: SqlClient.SqlClient["unsafe"] = <A extends object>(
                  query: string,
                  params?: ReadonlyArray<unknown>
                ) => {
                  captured.push({ query, params: params ?? [] });
                  return sql.unsafe<A>(query, params);
                };
                const recordingSql = new Proxy(sql, {
                  get: (target, property, receiver) =>
                    property === "unsafe" ? unsafe : Reflect.get(target, property, receiver)
                });
                return yield* effect.pipe(
                  Effect.provideService(CompanyDatabases.CompanyConnection, recordingSql)
                );
              })
            );
        const handlers = yield* TableOperations.make.pipe(
          Effect.provide(
            Layer.succeed(
              CompanyDatabases.CompanyDatabases,
              CompanyDatabases.CompanyDatabases.of({ ...databases, withCompany })
            )
          )
        );
        type Plan = {
          "Node Type": string;
          "Relation Name"?: string;
          "Actual Rows": number;
          "Scan Direction"?: string;
          Plans?: ReadonlyArray<Plan>;
        };
        for (const [args, expectedRows, expectedTitle] of [
          [{ table: "notes" }, 101, "note-100000"],
          [{ table: "notes", index: "byTitle", eq: { title: "note-50000" } }, 1, "note-50000"]
        ] as const) {
          captured.length = 0;
          const page = yield* handlers["tables.list"]
            .run(args)
            .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodePage));
          assert.strictEqual(page.rows[0]!.title, expectedTitle);
          assert.strictEqual(page.rows.length, Math.min(expectedRows, 100));
          assert.strictEqual(captured.length, 1);
          const statement = captured[0]!;
          const explained = yield* databases.withCompany("cmp_dev")(
            Effect.gen(function* () {
              const sql = yield* CompanyDatabases.CompanyConnection;
              return yield* sql.unsafe<{ "QUERY PLAN": ReadonlyArray<{ Plan: Plan }> }>(
                `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.query}`,
                statement.params
              );
            })
          );
          const pending = [explained[0]!["QUERY PLAN"][0]!.Plan];
          const scans: Plan[] = [];
          while (pending.length > 0) {
            const node = pending.pop()!;
            if (node["Relation Name"] === "notes") scans.push(node);
            pending.push(...(node.Plans ?? []));
          }
          assert.strictEqual(scans.length, 1);
          assert.include(["Index Scan", "Index Only Scan"], scans[0]!["Node Type"]);
          assert.strictEqual(scans[0]!["Actual Rows"], expectedRows);
          if (expectedRows === 101) assert.strictEqual(scans[0]!["Scan Direction"], "Backward");
        }
      }),
    60_000
  );
  it.effect(
    "competing unique insertMany transactions leave exactly one complete winner",
    () =>
      Effect.gen(function* () {
        const { call } = yield* setup("cmp_dev", "uniquerace01");
        const results = yield* Effect.all(
          ["left", "right"].map((side) =>
            Effect.exit(
              call("tables.insertMany", {
                table: "notes",
                rows: [
                  { title: side, slug: `${side}-private` },
                  { title: side, slug: "contested" }
                ]
              })
            )
          ),
          { concurrency: "unbounded" }
        );
        assert.strictEqual(results.filter(Exit.isSuccess).length, 1);
        assert.strictEqual(results.filter(Exit.isFailure).length, 1);
        const page = yield* call("tables.list", { table: "notes", index: "bySlug" }).pipe(
          Effect.flatMap(decodePage)
        );
        assert.strictEqual(page.rows.length, 2);
        const winner = page.rows.find((row) => row.slug === "contested")!.title;
        assert.deepStrictEqual(
          page.rows.map((row) => row.title),
          [winner, winner]
        );
        assert.isTrue(page.rows.some((row) => row.slug === `${winner}-private`));
      }),
    60_000
  );
});

it.layer(NodeFileSystem.layer)("TableOperations / PGlite", (it) => {
  it.effect(
    "runs the same operations, cursors and bounds over the dev database",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-table-operations-" });
        const local = Tables.layer.pipe(
          Layer.provideMerge(
            Layer.merge(
              Inventory.layer,
              PgliteCompanyDatabases.layer({ companyId: "local-company", dataDir })
            )
          )
        );
        yield* Effect.gen(function* () {
          yield* operationsContract("local-company");
          yield* boundsContract("local-company");
          yield* expandedResultsContract("local-company");
          yield* indexKeyContract("local-company");
          yield* uuidContract("local-company");
        }).pipe(Effect.provide(local));
      }).pipe(Effect.scoped),
    60_000
  );
});
