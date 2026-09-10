import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Inventory } from "@patchy/company-database";
import { PgliteCompanyDatabases } from "@patchy/company-database/dev";
import * as Testing from "@patchy/company-database/testing";
import * as Tables from "./Tables.js";
import { contracts, filesystem, independentNamesContract } from "./test/filesContract.js";

const postgres = Layer.merge(filesystem, Tables.layer.pipe(Layer.provideMerge(Testing.layer())));
const local = Layer.merge(
  filesystem,
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-files-pglite-" });
      return Tables.layer.pipe(
        Layer.provideMerge(
          Layer.merge(
            Inventory.layer,
            PgliteCompanyDatabases.layer({ companyId: "local-company", dataDir })
          )
        )
      );
    })
  ).pipe(Layer.provide(NodeFileSystem.layer))
);

for (const { name, layer, companyId } of [
  { name: "Postgres", layer: postgres, companyId: "cmp_dev" },
  { name: "PGlite", layer: local, companyId: "local-company" }
]) {
  it.layer(layer, { timeout: "60 seconds" })(`Files / ${name} and filesystem`, (it) => {
    for (const [description, contract] of Object.entries(contracts)) {
      it.effect(description, () => contract(companyId), 60_000);
    }
    if (name === "Postgres") {
      it.effect(
        "keeps unrelated names and list progressing while a same-name writer waits on another session",
        () => independentNamesContract(companyId),
        60_000
      );
    }
  });
}
