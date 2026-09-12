import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CompanyDatabases from "./CompanyDatabases.js";
import * as Inventory from "./Inventory.js";
import * as PgliteCompanyDatabases from "./PgliteCompanyDatabases.js";
import { inventoryContract } from "./test/inventoryContract.js";

it.layer(NodeFileSystem.layer)("PgliteCompanyDatabases", (it) => {
  it.effect(
    "satisfies the shared cumulative inventory, rollback and codec contract",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-pglite-contract-" });
        yield* inventoryContract("local-company").pipe(
          Effect.provide(
            Layer.merge(
              Inventory.layer,
              PgliteCompanyDatabases.layer({ companyId: "local-company", dataDir })
            )
          )
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect("upgrades a reopened ready directory without losing its inventory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-pglite-upgrade-" });
      const local = Layer.merge(
        Inventory.layer,
        PgliteCompanyDatabases.layer({ companyId: "local-company", dataDir })
      );
      yield* Effect.gen(function* () {
        const databases = yield* CompanyDatabases.CompanyDatabases;
        const inventory = yield* Inventory.Inventory;
        yield* databases.ensureReady("local-company");
        yield* databases.withCompany("local-company")(
          databases.withPatchLock("legacy")(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* inventory.ensurePatch("legacy");
              yield* inventory.putTable({ patchId: "legacy", name: "notes", shared: true });
              yield* inventory.putColumn({
                patchId: "legacy",
                table: "notes",
                name: "body",
                kind: "text",
                refTable: null,
                optional: false,
                defaultKind: "constant",
                defaultValue: "kept"
              });
              yield* inventory.bumpRevision("legacy");
              yield* sql.unsafe('ALTER TABLE "patchy"."columns" DROP COLUMN "ref_table"');
            })
          )
        );
      }).pipe(Effect.provide(local, { local: true }));
      yield* Effect.gen(function* () {
        const databases = yield* CompanyDatabases.CompanyDatabases;
        const inventory = yield* Inventory.Inventory;
        yield* databases.ensureReady("local-company");
        yield* databases.withCompany("local-company")(
          Effect.gen(function* () {
            const snapshot = yield* inventory.read("legacy");
            assert.strictEqual(snapshot?.schemaRevision, 1);
            assert.strictEqual(snapshot?.columns[0]?.defaultValue, "kept");
            assert.isNull(snapshot?.columns[0]?.refTable);
            assert.isTrue(snapshot?.tables[0]?.shared);
            yield* databases.withPatchLock("legacy")(
              inventory.putColumn({
                patchId: "legacy",
                table: "notes",
                name: "parent",
                kind: "ref",
                refTable: "notes",
                optional: true,
                defaultKind: null,
                defaultValue: null
              })
            );
            const updated = yield* inventory.read("legacy");
            assert.strictEqual(
              updated?.columns.find((column) => column.name === "parent")?.refTable,
              "notes"
            );
          })
        );
      }).pipe(Effect.provide(local, { local: true }));
    }).pipe(Effect.scoped)
  );

  it.effect(
    "persists inventory and prevents a reopened directory from changing companies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-pglite-persistence-" });
        const local = Layer.merge(
          Inventory.layer,
          PgliteCompanyDatabases.layer({ companyId: "local-company", dataDir })
        );
        const first = yield* Effect.gen(function* () {
          const databases = yield* CompanyDatabases.CompanyDatabases;
          const inventory = yield* Inventory.Inventory;
          yield* databases.ensureReady("local-company");
          return yield* databases.withCompany("local-company")(
            databases.withPatchLock("persisted")(
              Effect.gen(function* () {
                yield* inventory.ensurePatch("persisted");
                const sql = yield* SqlClient.SqlClient;
                yield* sql.unsafe('CREATE TABLE "p_persisted"."notes" ("body" text)');
                yield* sql`INSERT INTO "p_persisted"."notes" ("body") VALUES ('survives reopen')`;
                yield* inventory.putTable({ patchId: "persisted", name: "notes", shared: false });
                yield* inventory.putColumn({
                  patchId: "persisted",
                  table: "notes",
                  name: "parent",
                  kind: "ref",
                  refTable: "notes",
                  optional: true,
                  defaultKind: null,
                  defaultValue: null
                });
                yield* inventory.putStore({ patchId: "persisted", name: "attachments" });
                yield* inventory.bumpRevision("persisted");
                return yield* inventory.read("persisted");
              })
            )
          );
        }).pipe(Effect.provide(local, { local: true }));

        const reopened = yield* Effect.gen(function* () {
          const databases = yield* CompanyDatabases.CompanyDatabases;
          const inventory = yield* Inventory.Inventory;
          yield* databases.ensureReady("local-company");
          const wrongCompany = yield* databases
            .withCompany("other-company")(inventory.read("persisted"))
            .pipe(Effect.flip);
          assert.instanceOf(wrongCompany, CompanyDatabases.CompanyIdentityMismatch);
          return yield* databases.withCompany("local-company")(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              assert.deepStrictEqual(yield* sql`SELECT "body" FROM "p_persisted"."notes"`, [
                { body: "survives reopen" }
              ]);
              return yield* inventory.read("persisted");
            })
          );
        }).pipe(Effect.provide(local, { local: true }));
        assert.deepStrictEqual(reopened, first);
        assert.strictEqual(reopened?.schemaRevision, 1);
        assert.strictEqual(reopened?.stores[0]?.name, "attachments");
        assert.strictEqual(reopened?.columns[0]?.refTable, "notes");

        // Binding is on disk, not merely the company's configured name in memory.
        const rebound = yield* Effect.gen(function* () {
          const databases = yield* CompanyDatabases.CompanyDatabases;
          return yield* databases.ensureReady("other-company").pipe(Effect.flip);
        }).pipe(
          Effect.provide(PgliteCompanyDatabases.layer({ companyId: "other-company", dataDir }))
        );
        assert.instanceOf(rebound, CompanyDatabases.CompanyIdentityMismatch);
        if (rebound._tag === "CompanyIdentityMismatch") {
          assert.strictEqual(rebound.expectedCompanyId, "local-company");
          assert.strictEqual(rebound.actualCompanyId, "other-company");
        }
      }).pipe(Effect.scoped),
    30_000
  );
});
