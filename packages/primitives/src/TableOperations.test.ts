import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TablePage } from "@patchy/api";
import { Inventory } from "@patchy/company-database";
import { PgliteCompanyDatabases } from "@patchy/company-database/dev";
import * as Testing from "@patchy/company-database/testing";
import * as Tables from "./Tables.js";
import { boundsContract, operationsContract, setup } from "./test/operationsContract.js";

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
        }).pipe(Effect.provide(local));
      }).pipe(Effect.scoped),
    60_000
  );
});
