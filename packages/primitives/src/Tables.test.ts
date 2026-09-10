import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Inventory } from "@patchy/company-database";
import { PgliteCompanyDatabases } from "@patchy/company-database/dev";
import * as CompanyTesting from "@patchy/company-database/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Tables from "./Tables.js";
import {
  additions,
  columnLimit,
  emptyAndRollback,
  indexKeyLimit,
  omissions,
  refusals,
  rowExpansionLimit
} from "./test/provisioningContract.js";

const postgres = Tables.layer.pipe(Layer.provideMerge(CompanyTesting.layer()));
const local = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-tables-contract-" });
    return Tables.layer.pipe(
      Layer.provideMerge(
        Layer.merge(
          Inventory.layer,
          PgliteCompanyDatabases.layer({ companyId: "cmp_dev", dataDir })
        )
      )
    );
  })
).pipe(Layer.provide(NodeFileSystem.layer));

for (const [name, layer] of [
  ["Postgres", postgres],
  ["PGlite", local]
] as const) {
  it.layer(layer)(`Tables (${name})`, (it) => {
    it.effect(
      "fills old rows and old-writer inserts, persists refs and maintains timestamps",
      () => additions("cmp_dev"),
      30_000
    );
    it.effect(
      "keeps omitted data, defaults and uniqueness, and changes sharing only when defined",
      () => omissions("cmp_dev"),
      30_000
    );
    it.effect(
      "refuses every non-additive change before any DDL and names its object, change and fix",
      () => refusals("cmp_dev"),
      30_000
    );
    it.effect(
      "leaves empty patches without inventory and rolls DDL back with inventory",
      () => emptyAndRollback("cmp_dev"),
      30_000
    );
    it.effect(
      "counts omitted columns toward the cumulative Postgres column limit",
      () => columnLimit("cmp_dev"),
      30_000
    );
    it.effect(
      "preflights uncompressed index keys and protects old writers with physical checks",
      () => indexKeyLimit("cmp_dev"),
      30_000
    );
    it.effect(
      "refuses default expansion beyond the cumulative row limit before any DDL",
      () => rowExpansionLimit("cmp_dev"),
      30_000
    );
  });
}
