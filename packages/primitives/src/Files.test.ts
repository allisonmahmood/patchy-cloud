import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Inventory } from "@patchy/company-database";
import { PgliteCompanyDatabases } from "@patchy/company-database/dev";
import * as Testing from "@patchy/company-database/testing";
import { LoadedVersions } from "@patchy/runtime";
import { OperatingLimits } from "@patchy/limits";
import * as Tables from "./Tables.js";
import {
  binaryBoundaryContract,
  companyStageBoundsContract,
  contracts,
  filesystem,
  independentNamesContract,
  lateStageSweepContract,
  slowSweepDeleteContract
} from "./test/filesContract.js";
import * as TestWakes from "./test/wakes.js";

const postgres = Layer.merge(
  filesystem,
  Layer.merge(Tables.layer, OperatingLimits.layer).pipe(Layer.provideMerge(Testing.layer()))
);
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

/** A backend with test wakes and a version lookup that finds nothing. */
const withRuntime = <ROut, E, RIn>(layer: Layer.Layer<ROut, E, RIn>) =>
  layer.pipe(
    Layer.provideMerge(TestWakes.layer),
    Layer.provideMerge(
      Layer.succeed(LoadedVersions.LoadedVersions, { find: () => Effect.succeed(Option.none()) })
    )
  );

it.layer(withRuntime(postgres), { timeout: "60 seconds" })(
  "Files / Postgres and filesystem",
  (it) => {
    const companyId = "cmp_dev";
    for (const [description, contract] of Object.entries(contracts)) {
      it.effect(description, () => contract(companyId), 60_000);
    }
    // The bytes go to the filesystem content store, not the database, so one backend covers it.
    it.effect(
      "round-trips 20 MiB as binary and refuses one more byte without replacing it",
      () => binaryBoundaryContract(companyId),
      60_000
    );
    it.effect(
      "enforces current company stage overrides across patches and fails closed on limit lookup errors",
      () => companyStageBoundsContract(companyId),
      60_000
    );
    it.effect(
      "reclaims late staged bytes and preserves cleanup retries across delayed sweep acknowledgements",
      () => lateStageSweepContract(companyId),
      60_000
    );
    it.effect(
      "keeps file writes and adoption progressing while sweep blob deletion is paused",
      () => slowSweepDeleteContract(companyId),
      60_000
    );
    it.effect(
      "keeps unrelated names and list progressing while a same-name writer waits on another session",
      () => independentNamesContract(companyId),
      60_000
    );
  }
);

it.layer(withRuntime(local), { timeout: "60 seconds" })("Files / PGlite and filesystem", (it) => {
  for (const [description, contract] of Object.entries(contracts)) {
    it.effect(description, () => contract("local-company"), 60_000);
  }
});
