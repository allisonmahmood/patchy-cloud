import { createHash } from "node:crypto";
import { assert } from "@effect/vitest";
import { Manifest, TableDefinition } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Tables from "../Tables.js";

const manifest = (tables: (typeof Manifest.Type)["tables"]): typeof Manifest.Type => ({
  manifestVersion: 1,
  release: "test",
  tier: 0,
  tables,
  files: {},
  uses: {}
});
const base: typeof TableDefinition.Type = {
  columns: {
    title: { kind: "text" },
    memo: { kind: "text", optional: true },
    count: { kind: "integer", default: 1 },
    metadata: { kind: "json", default: { nested: [true, null], label: "kept" } },
    parent: { kind: "ref", table: "notes", optional: true }
  },
  indexes: { uniqueTitle: { columns: ["title"], unique: true }, byCount: { columns: ["count"] } },
  shared: true
};
const qualified = (patchId: string, table = "notes") =>
  `${Inventory.quoteIdentifier(Inventory.namespace(patchId))}.${Inventory.quoteIdentifier(table)}`;

export const additions = Effect.fn("ProvisioningContract.additions")(function* (companyId: string) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  const inventory = yield* Inventory.Inventory;
  const patchId = "table-additions";
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const initial = yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, manifest({ notes: base }))
      );
      assert.strictEqual(initial.schemaRevision, 1);
      // Refs deliberately have no FK; an absent target row never stops an insert.
      yield* sql.unsafe(
        `INSERT INTO ${qualified(patchId)} ("id", "title", "parent", "updatedAt") VALUES ('old', 'before', 'dangling', '2000-01-01')`
      );
      const expanded: typeof TableDefinition.Type = {
        ...base,
        columns: {
          ...base.columns,
          optionalNumber: { kind: "number", optional: true },
          score: { kind: "number", default: 1.5 },
          active: { kind: "boolean", default: true },
          published: { kind: "timestamp", default: "now" },
          constantTime: { kind: "timestamp", default: "2024-02-29T12:00:00Z" },
          escaped: { kind: "text", default: "quote'\\backslash" },
          next: { kind: "ref", table: "notes", default: "dangling" }
        },
        indexes: { ...base.indexes, byActive: { columns: ["active", "score"] } }
      };
      const nextManifest = manifest({ notes: expanded });
      const next = yield* databases.withPatchLock(patchId)(tables.provision(patchId, nextManifest));
      assert.strictEqual(next.schemaRevision, 2);
      assert.deepStrictEqual(next.provisioned.indexes, ["notes.byActive"]);
      const [filled] = yield* sql.unsafe<{
        optionalNumber: number | null;
        score: number;
        active: boolean;
        escaped: string;
        next: string;
        filledAtPublish: boolean;
        constantTime: boolean;
      }>(
        `SELECT "optionalNumber", "score", "active", "escaped", "next", "published" >= "createdAt" AS "filledAtPublish", "constantTime" = '2024-02-29T12:00:00Z'::timestamptz AS "constantTime" FROM ${qualified(patchId)} WHERE "id" = 'old'`
      );
      assert.deepStrictEqual(filled, {
        optionalNumber: null,
        score: 1.5,
        active: true,
        escaped: "quote'\\backslash",
        next: "dangling",
        filledAtPublish: true,
        constantTime: true
      });
      // The unchanged old writer knows none of the newly provisioned columns.
      yield* sql.unsafe(
        `INSERT INTO ${qualified(patchId)} ("id", "title") VALUES ('old-writer', 'after')`
      );
      assert.deepStrictEqual(
        yield* sql.unsafe(
          `SELECT "score", "active", "next", "memo" FROM ${qualified(patchId)} WHERE "id" = 'old-writer'`
        ),
        [{ score: 1.5, active: true, next: "dangling", memo: null }]
      );
      const [updated] = yield* sql.unsafe<{ maintained: boolean; created: boolean }>(
        `UPDATE ${qualified(patchId)} SET "memo" = 'changed' WHERE "id" = 'old' RETURNING "updatedAt" > '2000-01-01'::timestamptz AS "maintained", "updatedAt" >= "createdAt" AS "created"`
      );
      assert.deepStrictEqual(updated, { maintained: true, created: true });
      const snapshot = yield* inventory.read(patchId);
      assert.isNotNull(snapshot);
      if (!snapshot) return;
      assert.strictEqual(
        snapshot.columns.find((column) => column.name === "parent")?.refTable,
        "notes"
      );
      const recovered = Tables.inventoryManifest(snapshot);
      const replay = yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, { ...nextManifest, ...recovered })
      );
      assert.strictEqual(replay.schemaRevision, 2);
      assert.deepStrictEqual(replay.provisioned, {
        tables: [],
        columns: [],
        indexes: [],
        stores: []
      });
      // JSONB canonicalizes object keys; property insertion order is not a changed default.
      const reordered = manifest({
        notes: {
          ...expanded,
          columns: {
            ...expanded.columns,
            metadata: { kind: "json", default: { label: "kept", nested: [true, null] } }
          }
        }
      });
      assert.strictEqual((yield* tables.diff(reordered, snapshot)).schemaRevision, 2);
    })
  );
});

export const omissions = Effect.fn("ProvisioningContract.omissions")(function* (companyId: string) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  const inventory = yield* Inventory.Inventory;
  const patchId = "table-omissions";
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* databases.withPatchLock(patchId)(tables.provision(patchId, manifest({ notes: base })));
      const omitted = manifest({
        notes: { columns: { title: base.columns.title! }, indexes: {}, shared: true }
      });
      const report = yield* databases.withPatchLock(patchId)(tables.provision(patchId, omitted));
      assert.strictEqual(report.schemaRevision, 1);
      assert.deepStrictEqual(report.unused.columns, [
        "notes.count",
        "notes.memo",
        "notes.metadata",
        "notes.parent"
      ]);
      assert.deepStrictEqual(report.unused.indexes, ["notes.byCount", "notes.uniqueTitle"]);
      assert.include(report.warnings, "uniqueness on `notes.uniqueTitle` still applies");
      yield* sql.unsafe(
        `INSERT INTO ${qualified(patchId)} ("id", "title") VALUES ('kept', 'only-title')`
      );
      assert.deepStrictEqual(
        yield* sql.unsafe(
          `SELECT "count", "metadata", "memo", "parent" FROM ${qualified(patchId)}`
        ),
        [{ count: 1, metadata: { nested: [true, null], label: "kept" }, memo: null, parent: null }]
      );
      const unique = yield* sql
        .unsafe(
          `INSERT INTO ${qualified(patchId)} ("id", "title") VALUES ('duplicate', 'only-title')`
        )
        .pipe(Effect.flip);
      assert.strictEqual(unique._tag, "SqlError");
      const rename = yield* databases.withPatchLock(patchId)(
        tables.provision(
          patchId,
          manifest({ memos: { columns: { title: { kind: "text" } }, indexes: {} } })
        )
      );
      assert.deepStrictEqual(rename.provisioned.tables, ["memos"]);
      assert.deepStrictEqual(rename.unused.tables, ["notes"]);
      assert.include(
        rename.warnings,
        "`notes` is no longer defined; its data is kept and this version cannot reach it."
      );
      assert.strictEqual(rename.schemaRevision, 2);
      assert.deepStrictEqual(yield* sql.unsafe(`SELECT "title" FROM ${qualified(patchId)}`), [
        { title: "only-title" }
      ]);
      assert.deepStrictEqual(
        yield* sql.unsafe(`SELECT "title" FROM ${qualified(patchId, "memos")}`),
        []
      );
      assert.strictEqual(
        (yield* inventory.read(patchId))?.tables.find((table) => table.name === "notes")?.shared,
        true
      );
      const restored = yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, manifest({ notes: base }))
      );
      assert.strictEqual(restored.schemaRevision, 2);
      const unshared = yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, manifest({ notes: { ...base, shared: false } }))
      );
      assert.strictEqual(unshared.schemaRevision, 3);
      assert.strictEqual(
        (yield* inventory.read(patchId))?.tables.find((table) => table.name === "notes")?.shared,
        false
      );
      const reshared = yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, manifest({ notes: base }))
      );
      assert.strictEqual(reshared.schemaRevision, 4);
      yield* databases.withPatchLock(patchId)(inventory.putStore({ patchId, name: "attachments" }));
      const stores = yield* tables.diff(manifest({ notes: base }), yield* inventory.read(patchId));
      assert.deepStrictEqual(stores.unused.stores, ["attachments"]);
      assert.strictEqual(stores.schemaRevision, 4);
    })
  );
});

export const refusals = Effect.fn("ProvisioningContract.refusals")(function* (companyId: string) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  const inventory = yield* Inventory.Inventory;
  const patchId = "table-refusals";
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, manifest({ notes: base, targets: { columns: {}, indexes: {} } }))
      );
      const before = yield* inventory.read(patchId);
      const cases: ReadonlyArray<{
        object: string;
        change: string;
        definition: typeof TableDefinition.Type;
      }> = [
        {
          object: "notes.title",
          change: "changing kind",
          definition: { ...base, columns: { ...base.columns, title: { kind: "integer" } } }
        },
        {
          object: "notes.memo",
          change: "optional to required",
          definition: { ...base, columns: { ...base.columns, memo: { kind: "text" } } }
        },
        {
          object: "notes.title",
          change: "required to optional",
          definition: {
            ...base,
            columns: { ...base.columns, title: { kind: "text", optional: true } }
          }
        },
        {
          object: "notes.count",
          change: "changing a default",
          definition: {
            ...base,
            columns: { ...base.columns, count: { kind: "integer", default: 2 } }
          }
        },
        {
          object: "notes.count",
          change: "removing a default",
          definition: { ...base, columns: { ...base.columns, count: { kind: "integer" } } }
        },
        {
          object: "notes.title",
          change: "adding or changing a default",
          definition: {
            ...base,
            columns: { ...base.columns, title: { kind: "text", default: "new" } }
          }
        },
        {
          object: "notes.newRequired",
          change: "adding a required column",
          definition: { ...base, columns: { ...base.columns, newRequired: { kind: "text" } } }
        },
        {
          object: "notes.title",
          change: "omitting a required column",
          definition: {
            ...base,
            columns: {
              memo: base.columns.memo!,
              count: base.columns.count!,
              metadata: base.columns.metadata!,
              parent: base.columns.parent!
            },
            indexes: {}
          }
        },
        {
          object: "notes.parent",
          change: "changing ref target",
          definition: {
            ...base,
            columns: { ...base.columns, parent: { kind: "ref", table: "targets", optional: true } }
          }
        },
        {
          object: "notes.newUnique",
          change: "adding a unique index",
          definition: {
            ...base,
            indexes: { ...base.indexes, newUnique: { columns: ["memo"], unique: true } }
          }
        },
        {
          object: "notes.byCount",
          change: "changing an existing index",
          definition: {
            ...base,
            indexes: { ...base.indexes, byCount: { columns: ["count"], unique: true } }
          }
        },
        {
          object: "notes.uniqueTitle",
          change: "changing an existing index",
          definition: { ...base, indexes: { ...base.indexes, uniqueTitle: { columns: ["title"] } } }
        },
        {
          object: "notes.byCount",
          change: "changing an existing index",
          definition: {
            ...base,
            indexes: { ...base.indexes, byCount: { columns: ["title", "count"] } }
          }
        }
      ];
      for (const test of cases) {
        // Catch inside the transaction: prior DDL would commit and be observable below.
        yield* databases.withPatchLock(patchId)(
          Effect.gen(function* () {
            const error = yield* tables
              .provision(
                patchId,
                manifest({ shouldNotExist: { columns: {}, indexes: {} }, notes: test.definition })
              )
              .pipe(Effect.flip);
            assert.instanceOf(error, Tables.NotAdditive);
            if (error._tag !== "NotAdditive") return;
            assert.strictEqual(error.code, "not_additive");
            assert.include(error.message, test.object);
            assert.include(error.message, test.change);
            assert.isTrue(
              error.changes.some((change) => change.object === test.object && change.fix.length > 0)
            );
            assert.deepStrictEqual(
              yield* sql`SELECT to_regclass(${qualified(patchId, "shouldNotExist")})::text AS name`,
              [{ name: null }]
            );
          })
        );
        assert.deepStrictEqual(yield* inventory.read(patchId), before);
      }
      const multiple = yield* tables
        .diff(
          manifest({
            notes: {
              ...base,
              columns: { ...base.columns, title: { kind: "integer" }, memo: { kind: "text" } }
            }
          }),
          before
        )
        .pipe(Effect.flip);
      assert.include(multiple.message, "notes.title");
      assert.include(multiple.message, "notes.memo");
      const files = yield* tables
        .diff({ ...manifest({}), files: { attachments: {} } }, null)
        .pipe(Effect.flip);
      assert.include(files.message, "file stores are not supported");
    })
  );
});

export const emptyAndRollback = Effect.fn("ProvisioningContract.emptyAndRollback")(function* (
  companyId: string
) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  const inventory = yield* Inventory.Inventory;
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const empty = yield* databases.withPatchLock("empty-tables")(
        tables.provision("empty-tables", manifest({}))
      );
      assert.strictEqual(empty.schemaRevision, 0);
      assert.isFalse(yield* inventory.exists("empty-tables"));
      assert.deepStrictEqual(yield* sql`SELECT to_regnamespace('p_empty-tables')::text AS name`, [
        { name: null }
      ]);
      const failed = yield* databases
        .withPatchLock("aborted-tables")(
          Effect.gen(function* () {
            yield* tables.provision("aborted-tables", manifest({ notes: base }));
            return yield* Effect.fail("abort");
          })
        )
        .pipe(Effect.flip);
      assert.strictEqual(failed, "abort");
      assert.isFalse(yield* inventory.exists("aborted-tables"));
      assert.deepStrictEqual(yield* sql`SELECT to_regnamespace('p_aborted-tables')::text AS name`, [
        { name: null }
      ]);
      const prototypeId = "prototype-name";
      yield* databases.withPatchLock(prototypeId)(
        tables.provision(
          prototypeId,
          manifest({
            constructor: {
              columns: { body: { kind: "text" } },
              indexes: { byBody: { columns: ["body"] } }
            }
          })
        )
      );
      yield* sql.unsafe(
        `INSERT INTO ${qualified(prototypeId, "constructor")} ("id", "body") VALUES ('kept', 'prototype name')`
      );
      const omitted = yield* databases.withPatchLock(prototypeId)(
        tables.provision(prototypeId, manifest({}))
      );
      assert.deepStrictEqual(omitted.unused.tables, ["constructor"]);
      assert.strictEqual(omitted.schemaRevision, 1);
      assert.deepStrictEqual(
        yield* sql.unsafe(`SELECT "body" FROM ${qualified(prototypeId, "constructor")}`),
        [{ body: "prototype name" }]
      );
    })
  );
});

export const columnLimit = Effect.fn("ProvisioningContract.columnLimit")(function* (
  companyId: string
) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  const inventory = yield* Inventory.Inventory;
  const patchId = "column-limit";
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const columns = Object.fromEntries(
        Array.from({ length: 1596 }, (_, index) => [
          `c${index}`,
          { kind: "text" as const, optional: true }
        ])
      );
      yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, manifest({ wide: { columns, indexes: {} } }))
      );
      const atLimit = yield* databases.withPatchLock(patchId)(
        tables.provision(
          patchId,
          manifest({
            wide: { columns: { last: { kind: "text", optional: true } }, indexes: {} }
          })
        )
      );
      assert.strictEqual(atLimit.schemaRevision, 2);
      const error = yield* databases.withPatchLock(patchId)(
        tables
          .provision(
            patchId,
            manifest({
              wide: { columns: { overflow: { kind: "text", optional: true } }, indexes: {} }
            })
          )
          .pipe(Effect.flip)
      );
      assert.instanceOf(error, Tables.NotAdditive);
      assert.include(error.message, "1597-column cumulative limit");
      assert.include(error.message, "unused columns");
      const snapshot = yield* inventory.read(patchId);
      assert.strictEqual(snapshot?.schemaRevision, 2);
      assert.strictEqual(snapshot?.columns.length, 1597);
      assert.isFalse(snapshot?.columns.some((column) => column.name === "overflow"));
    })
  );
});

export const indexKeyLimit = Effect.fn("ProvisioningContract.indexKeyLimit")(function* (
  companyId: string
) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  const inventory = yield* Inventory.Inventory;
  const patchId = "index-key-limit";
  const long = Array.from({ length: 128 }, (_, index) =>
    createHash("sha256").update(`index-key-${index}`).digest("hex")
  ).join("");
  const initial: typeof TableDefinition.Type = {
    columns: {
      title: { kind: "text" },
      metadata: { kind: "json", default: { value: long } },
      unindexed: { kind: "text", optional: true }
    },
    indexes: {}
  };
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, manifest({ notes: initial }))
      );
      yield* sql.unsafe(`INSERT INTO ${qualified(patchId)} ("id", "title") VALUES ('old', $1)`, [
        long
      ]);
      const before = yield* inventory.read(patchId);
      const expanded = manifest({
        shouldNotExist: { columns: {}, indexes: {} },
        notes: {
          columns: {
            ...initial.columns,
            defaulted: { kind: "text", default: long },
            parent: { kind: "ref", table: "notes", default: long }
          },
          indexes: {
            byTitle: { columns: ["title", "title"] },
            byMetadata: { columns: ["metadata"] },
            byDefault: { columns: ["defaulted"] }
          }
        }
      });
      const preview = yield* tables.validate(patchId, expanded, before).pipe(Effect.flip);
      assert.instanceOf(preview, Tables.NotAdditive);
      if (preview._tag !== "NotAdditive") return;
      assert.deepStrictEqual(preview.changes.map((change) => change.object).sort(), [
        "notes.byDefault",
        "notes.byMetadata",
        "notes.byTitle",
        "notes.parent"
      ]);
      for (const change of preview.changes) assert.isAbove(change.fix.length, 0);
      // Catch within the transaction: a refusal after any DDL would leak physical changes.
      yield* databases.withPatchLock(patchId)(
        Effect.gen(function* () {
          const refused = yield* tables.provision(patchId, expanded).pipe(Effect.flip);
          assert.instanceOf(refused, Tables.NotAdditive);
          assert.deepStrictEqual(
            yield* sql`SELECT to_regclass(${qualified(patchId, "shouldNotExist")})::text AS name`,
            [{ name: null }]
          );
        })
      );
      assert.deepStrictEqual(yield* inventory.read(patchId), before);
      assert.deepStrictEqual(
        yield* sql.unsafe(
          `SELECT "title", "metadata" FROM ${qualified(patchId)} WHERE "id" = 'old'`
        ),
        [{ title: long, metadata: { value: long } }]
      );
      yield* sql.unsafe(
        `UPDATE ${qualified(patchId)} SET "title" = 'short', "metadata" = '{"value":"short"}' WHERE "id" = 'old'`
      );
      yield* databases.withPatchLock(patchId)(
        tables.provision(
          patchId,
          manifest({
            notes: {
              columns: {
                ...initial.columns,
                parent: { kind: "ref", table: "notes", optional: true }
              },
              indexes: {
                byTitle: { columns: ["title", "title"] },
                byMetadata: { columns: ["metadata"] }
              }
            },
            fresh: {
              columns: {
                title: { kind: "text" },
                parent: { kind: "ref", table: "notes", optional: true }
              },
              indexes: { byTitle: { columns: ["title"] } }
            }
          })
        )
      );
      // Physical checks protect old loaded writers and roll back their entire transaction.
      for (const [table, column, value] of [
        ["notes", "title", long],
        ["notes", "metadata", JSON.stringify({ value: long })],
        ["notes", "parent", long],
        ["fresh", "title", long],
        ["fresh", "parent", long],
        // Compression must not make the supported key ceiling data-dependent.
        ["notes", "title", "x".repeat(long.length)]
      ] as const) {
        const error = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                `INSERT INTO ${qualified(patchId, table)} ("id", "title"${table === "notes" ? ', "metadata"' : ""}) VALUES ('rolled-back', 'safe'${table === "notes" ? ", '{}'" : ""})`
              );
              yield* sql.unsafe(
                `UPDATE ${qualified(patchId, table)} SET ${Inventory.quoteIdentifier(column)} = $1 WHERE "id" = 'rolled-back'`,
                [value]
              );
            })
          )
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "SqlError");
        assert.deepStrictEqual(
          yield* sql.unsafe(
            `SELECT "id" FROM ${qualified(patchId, table)} WHERE "id" = 'rolled-back'`
          ),
          []
        );
      }
      yield* sql.unsafe(`UPDATE ${qualified(patchId)} SET "unindexed" = $1 WHERE "id" = 'old'`, [
        long
      ]);
      assert.deepStrictEqual(
        yield* sql.unsafe(`SELECT "unindexed" FROM ${qualified(patchId)} WHERE "id" = 'old'`),
        [{ unindexed: long }]
      );
    })
  );
});

export const rowExpansionLimit = Effect.fn("ProvisioningContract.rowExpansionLimit")(function* (
  companyId: string
) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  const inventory = yield* Inventory.Inventory;
  const patchId = "row-expansion-limit";
  const retained = "r".repeat(600_000);
  const initial: typeof TableDefinition.Type = {
    columns: {
      title: { kind: "text", default: "kept" },
      retained: { kind: "text", optional: true }
    },
    indexes: { byTitle: { columns: ["title"] } }
  };
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* databases.withPatchLock(patchId)(
        tables.provision(patchId, manifest({ notes: initial }))
      );
      yield* sql.unsafe(`INSERT INTO ${qualified(patchId)} ("id", "retained") VALUES ('old', $1)`, [
        retained
      ]);
      const before = yield* inventory.read(patchId);
      const expanded = manifest({
        shouldNotExist: { columns: {}, indexes: {} },
        notes: {
          // Omitted cumulative values and indexes still count.
          columns: { added: { kind: "text", default: "n".repeat(600_000) } },
          indexes: {}
        }
      });
      const preview = yield* tables.validate(patchId, expanded, before).pipe(Effect.flip);
      assert.instanceOf(preview, Tables.NotAdditive);
      if (preview._tag !== "NotAdditive") return;
      assert.deepStrictEqual(
        preview.changes.map((change) => change.object),
        ["notes"]
      );
      yield* databases.withPatchLock(patchId)(
        Effect.gen(function* () {
          const refused = yield* tables.provision(patchId, expanded).pipe(Effect.flip);
          assert.instanceOf(refused, Tables.NotAdditive);
          assert.deepStrictEqual(
            yield* sql`SELECT to_regclass(${qualified(patchId, "shouldNotExist")})::text AS name`,
            [{ name: null }]
          );
        })
      );
      assert.deepStrictEqual(yield* inventory.read(patchId), before);
      assert.deepStrictEqual(
        yield* sql.unsafe(
          `SELECT "title", "retained" FROM ${qualified(patchId)} WHERE "id" = 'old'`
        ),
        [{ title: "kept", retained }]
      );
      yield* sql.unsafe(`UPDATE ${qualified(patchId)} SET "retained" = 'short' WHERE "id" = 'old'`);
      yield* databases.withPatchLock(patchId)(tables.provision(patchId, expanded));
      assert.deepStrictEqual(
        yield* sql.unsafe(
          `SELECT "title", "retained", length("added") AS "added" FROM ${qualified(patchId)} WHERE "id" = 'old'`
        ),
        [{ title: "kept", retained: "short", added: 600_000 }]
      );
    })
  );
});
