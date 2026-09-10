import { createHash } from "node:crypto";
import { assert } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CURRENT_RELEASE, Manifest, TablePage, TableRow, WIRE_VERSION } from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { Binding } from "@patchy/runtime";
import * as Tables from "../Tables.js";
import * as TableOperations from "../TableOperations.js";

const decodeRow = Schema.decodeUnknownEffect(TableRow);
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(TableRow));
const decodePage = Schema.decodeUnknownEffect(TablePage);
export const manifest: typeof Manifest.Type = {
  manifestVersion: 1,
  release: CURRENT_RELEASE,
  tier: 0,
  files: {},
  uses: {},
  tables: {
    notes: {
      columns: {
        title: { kind: "text" },
        slug: { kind: "text" },
        rank: { kind: "integer", optional: true },
        body: { kind: "text", optional: true },
        noteId: { kind: "ref", table: "notes", optional: true },
        enabled: { kind: "boolean", default: true },
        at: { kind: "timestamp", default: "now" },
        data: { kind: "json", optional: true }
      },
      indexes: {
        bySlug: { columns: ["slug"], unique: true },
        byRank: { columns: ["rank"] },
        byTitleRank: { columns: ["title", "rank"] },
        createdAt: { columns: ["slug"] }
      }
    }
  }
};
export const setup = Effect.fn("test.tableOperations.setup")(function* (
  companyId: string,
  patchId: string,
  definition: typeof Manifest.Type = manifest
) {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  yield* databases.ensureReady(companyId);
  yield* databases.withCompany(companyId)(
    databases.withPatchLock(patchId)(tables.provision(patchId, definition))
  );
  const handlers = yield* TableOperations.make;
  const binding = Binding.Binding.of({
    companyId,
    patchId,
    versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
    manifest: definition,
    wireVersion: WIRE_VERSION,
    scope: "company",
    identity: null,
    principal: null,
    correlationId: "operation-contract"
  });
  const call = (op: keyof typeof handlers, args: unknown) =>
    handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
  return { databases, tables, handlers, binding, call };
});

export const operationsContract = Effect.fn("test.operationsContract")(function* (
  companyId: string
) {
  const { call, databases, tables, handlers, binding } = yield* setup(companyId, "operations01");
  const first = yield* call("tables.insert", {
    table: "notes",
    row: { title: "one", slug: "one", data: { nested: [1, true] } }
  }).pipe(Effect.flatMap(decodeRow));
  assert.match(
    String(first.id),
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  assert.isNull(first.body);
  assert.isTrue(first.enabled);
  assert.deepStrictEqual(first.data, { nested: [1, true] });
  assert.isString(first.at);
  assert.deepStrictEqual(yield* call("tables.get", { table: "notes", id: first.id }), first);
  assert.isNull(yield* call("tables.get", { table: "notes", id: "dangling-ref" }));
  assert.deepStrictEqual(
    yield* call("tables.getMany", { table: "notes", ids: [first.id, "dangling-ref", first.id] }),
    [first, null, first]
  );
  for (const row of [
    { title: "bad", slug: "bad", id: "mine" },
    { title: "bad", slug: "bad", unknown: 1 },
    { slug: "bad" },
    { title: "bad", slug: "bad", enabled: null },
    { title: "bad", slug: "bad", rank: 1.5 },
    { title: "bad", slug: "bad", rank: 2147483648 },
    { title: "bad", slug: "bad", at: "yesterday" }
  ]) {
    assert.strictEqual(
      (yield* call("tables.insert", { table: "notes", row }).pipe(Effect.flip)).code,
      "invalid_row"
    );
  }
  for (const row of [
    { title: "nul\u0000", slug: "bad" },
    { title: "bad", slug: "bad", data: { "nul\u0000": 1 } },
    { title: "bad", slug: "bad", at: "2026-02-30T00:00:00Z" }
  ]) {
    assert.strictEqual(
      (yield* call("tables.insert", { table: "notes", row }).pipe(Effect.flip)).code,
      "invalid_row"
    );
  }
  const updated = yield* call("tables.update", {
    table: "notes",
    id: first.id,
    patch: { body: "changed" }
  }).pipe(Effect.flatMap(decodeRow));
  assert.strictEqual(updated.title, "one");
  assert.strictEqual(updated.body, "changed");
  assert.strictEqual(updated.createdAt, first.createdAt);
  assert.isAtLeast(Date.parse(String(updated.updatedAt)), Date.parse(String(first.updatedAt)));
  const cleared = yield* call("tables.update", {
    table: "notes",
    id: first.id,
    patch: { body: null }
  }).pipe(Effect.flatMap(decodeRow));
  assert.isNull(cleared.body);
  assert.strictEqual(
    (yield* call("tables.update", { table: "notes", id: first.id, patch: { title: null } }).pipe(
      Effect.flip
    )).code,
    "invalid_row"
  );
  assert.strictEqual(
    (yield* call("tables.update", { table: "notes", id: "missing", patch: {} }).pipe(Effect.flip))
      .code,
    "row_not_found"
  );
  assert.strictEqual(
    (yield* call("tables.get", { table: "missing", id: first.id }).pipe(Effect.flip)).code,
    "table_not_declared"
  );
  const builtin = yield* call("tables.list", {
    table: "notes",
    range: { column: "createdAt", gte: "2000-01-01T00:00:00Z" }
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(builtin.rows, [cleared]);
  const namedCreatedAt = yield* call("tables.list", {
    table: "notes",
    index: "createdAt",
    eq: { slug: "one" }
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(namedCreatedAt.rows, [cleared]);
  assert.strictEqual(
    (yield* call("tables.insertMany", {
      table: "notes",
      rows: [
        { title: "rollback", slug: "rollback" },
        { title: "conflict", slug: "one" }
      ]
    }).pipe(Effect.flip)).code,
    "unique_violation"
  );
  assert.deepStrictEqual(
    (yield* call("tables.list", { table: "notes", index: "bySlug", eq: { slug: "rollback" } }).pipe(
      Effect.flatMap(decodePage)
    )).rows,
    []
  );
  const added = yield* call("tables.insertMany", {
    table: "notes",
    rows: [
      { title: "same", slug: "two", rank: 2 },
      { title: "same", slug: "three", rank: 2 },
      { title: "same", slug: "four", rank: 3 },
      { title: "same", slug: "five", rank: null }
    ]
  }).pipe(Effect.flatMap(decodeRows));
  const page1 = yield* call("tables.list", { table: "notes", index: "byRank", limit: 1 }).pipe(
    Effect.flatMap(decodePage)
  );
  assert.strictEqual(page1.rows[0]!.rank, 2);
  assert.isString(page1.cursor);
  yield* call("tables.insert", { table: "notes", row: { title: "ahead", slug: "ahead", rank: 1 } });
  const seen = [...page1.rows];
  let cursor = page1.cursor;
  while (cursor !== null) {
    const page = yield* call("tables.list", {
      table: "notes",
      index: "byRank",
      limit: 1,
      cursor
    }).pipe(Effect.flatMap(decodePage));
    seen.push(...page.rows);
    cursor = page.cursor;
  }
  assert.deepStrictEqual(
    new Set(seen.map((row) => row.id)),
    new Set([first.id, ...added.map((row) => row.id)])
  );
  assert.strictEqual(seen.length, 5);
  assert.deepStrictEqual(
    seen.map((row) => row.rank),
    [2, 2, 3, null, null]
  );
  const descending = yield* call("tables.list", {
    table: "notes",
    index: "byRank",
    order: "desc",
    limit: 2
  }).pipe(Effect.flatMap(decodePage));
  const descendingRest = yield* call("tables.list", {
    table: "notes",
    index: "byRank",
    order: "desc",
    cursor: descending.cursor
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(
    [...descending.rows, ...descendingRest.rows].map((row) => row.rank),
    [3, 2, 2, 1, null, null]
  );
  const filtered = yield* call("tables.list", {
    table: "notes",
    index: "byTitleRank",
    eq: { title: "same" },
    range: { column: "rank", gte: 2, lt: 3 }
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(
    filtered.rows.map((row) => row.rank),
    [2, 2]
  );
  for (const args of [
    { index: "byTitleRank", eq: { rank: 2 } },
    { index: "byTitleRank", range: { column: "rank", gt: 1 } },
    { index: "absent" }
  ])
    assert.strictEqual(
      (yield* call("tables.list", { table: "notes", ...args }).pipe(Effect.flip)).code,
      "invalid_request"
    );
  for (const args of [
    { cursor: "not-a-cursor" },
    { index: "byRank", order: "desc", cursor: page1.cursor },
    { index: "byRank", eq: { rank: 2 }, cursor: page1.cursor }
  ])
    assert.strictEqual(
      (yield* call("tables.list", { table: "notes", ...args }).pipe(Effect.flip)).code,
      "invalid_cursor"
    );
  const otherPatch = yield* handlers["tables.list"]
    .run({ table: "notes", index: "byRank", cursor: page1.cursor })
    .pipe(
      Effect.provideService(Binding.Binding, { ...binding, patchId: "otherpatch01" }),
      Effect.flip
    );
  assert.strictEqual(otherPatch.code, "invalid_cursor");
  // A new database default keeps filling old writers, but never leaks into old-version results.
  const newer: typeof Manifest.Type = {
    ...manifest,
    tables: {
      notes: {
        ...manifest.tables.notes!,
        columns: {
          ...manifest.tables.notes!.columns,
          later: { kind: "text", default: "added later" }
        }
      }
    }
  };
  yield* databases.withCompany(companyId)(
    databases.withPatchLock(binding.patchId)(tables.provision(binding.patchId, newer))
  );
  const oldInsert = yield* call("tables.insert", {
    table: "notes",
    row: { title: "old", slug: "old" }
  }).pipe(Effect.flatMap(decodeRow));
  assert.isFalse(Object.hasOwn(oldInsert, "later"));
  const newRead = yield* handlers["tables.get"]
    .run({ table: "notes", id: oldInsert.id })
    .pipe(
      Effect.provideService(Binding.Binding, { ...binding, manifest: newer }),
      Effect.flatMap(decodeRow)
    );
  assert.strictEqual(newRead.later, "added later");
  assert.isNull(yield* call("tables.delete", { table: "notes", id: first.id }));
  assert.isNull(yield* call("tables.delete", { table: "notes", id: first.id }));
  assert.isNull(yield* call("tables.get", { table: "notes", id: first.id }));
  assert.deepStrictEqual(yield* call("tables.getMany", { table: "notes", ids: [] }), []);
  assert.deepStrictEqual(yield* call("tables.insertMany", { table: "notes", rows: [] }), []);
});

export const boundsContract = Effect.fn("test.boundsContract")(function* (companyId: string) {
  const { binding } = yield* setup(companyId, "bounds000001");
  const handlers = yield* TableOperations.make.pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          PATCHY_RUNTIME_ROW_BYTES: "512",
          PATCHY_RUNTIME_BATCH_BYTES: "1100",
          PATCHY_RUNTIME_RESULT_BYTES: "600",
          PATCHY_TABLE_MAX_ITEMS: "2",
          PATCHY_TABLE_MAX_PAGE: "2",
          PATCHY_TABLE_DEFAULT_PAGE: "1"
        })
      )
    )
  );
  const call = (op: keyof typeof handlers, args: unknown) =>
    handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
  for (const [op, args, limit] of [
    ["tables.getMany", { table: "notes", ids: ["a", "b", "c"] }, 2],
    ["tables.insertMany", { table: "notes", rows: [{}, {}, {}] }, 2],
    ["tables.list", { table: "notes", limit: 3 }, 2],
    [
      "tables.insert",
      { table: "notes", row: { title: "large", slug: "large", body: "x".repeat(513) } },
      512
    ],
    ["tables.getMany", { table: "notes", ids: ["x".repeat(1101)] }, 1100]
  ] as const) {
    const failure = yield* call(op, args).pipe(Effect.flip);
    assert.strictEqual(failure.code, "too_large");
    assert.include(failure.message, String(limit));
  }
  const row = yield* call("tables.insert", {
    table: "notes",
    row: { title: "bounded", slug: "bounded", body: "x".repeat(200) }
  }).pipe(Effect.flatMap(decodeRow));
  assert.strictEqual(
    (yield* call("tables.update", {
      table: "notes",
      id: row.id,
      patch: { body: "x".repeat(513) }
    }).pipe(Effect.flip)).code,
    "too_large"
  );
  assert.strictEqual(
    (yield* call("tables.update", {
      table: "notes",
      id: row.id,
      patch: { title: "x".repeat(300) }
    }).pipe(Effect.flip)).code,
    "too_large"
  );
  assert.deepStrictEqual(yield* call("tables.get", { table: "notes", id: row.id }), row);
  assert.strictEqual(
    (yield* call("tables.getMany", { table: "notes", ids: [row.id, row.id] }).pipe(Effect.flip))
      .code,
    "too_large"
  );
  yield* call("tables.insert", {
    table: "notes",
    row: { title: "bounded2", slug: "bounded2", body: "x".repeat(200) }
  });
  assert.strictEqual(
    (yield* call("tables.list", { table: "notes", limit: 2 }).pipe(Effect.flip)).code,
    "too_large"
  );
  const roomy = yield* TableOperations.make.pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ PATCHY_TABLE_DEFAULT_PAGE: "1" }))
    )
  );
  assert.strictEqual(
    (yield* roomy["tables.list"]
      .run({ table: "notes" })
      .pipe(Effect.provideService(Binding.Binding, binding), Effect.flatMap(decodePage))).rows
      .length,
    1
  );
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const tables = yield* Tables.Tables;
  const oversizedDefault: typeof Manifest.Type = {
    ...manifest,
    tables: {
      notes: {
        ...manifest.tables.notes!,
        columns: {
          ...manifest.tables.notes!.columns,
          later: { kind: "text", default: "d".repeat(600) }
        }
      }
    }
  };
  yield* databases.withCompany(companyId)(
    databases.withPatchLock(binding.patchId)(tables.provision(binding.patchId, oversizedDefault))
  );
  assert.strictEqual(
    (yield* call("tables.insert", { table: "notes", row: { title: "old", slug: "old" } }).pipe(
      Effect.flip
    )).code,
    "too_large"
  );
  assert.strictEqual(
    (yield* call("tables.insertMany", {
      table: "notes",
      rows: [{ title: "batch", slug: "batch" }]
    }).pipe(Effect.flip)).code,
    "too_large"
  );
  assert.deepStrictEqual(
    (yield* call("tables.list", { table: "notes", index: "bySlug", eq: { slug: "old" } }).pipe(
      Effect.flatMap(decodePage)
    )).rows,
    []
  );
  assert.deepStrictEqual(
    (yield* call("tables.list", { table: "notes", index: "bySlug", eq: { slug: "batch" } }).pipe(
      Effect.flatMap(decodePage)
    )).rows,
    []
  );
});

export const expandedResultsContract = Effect.fn("test.expandedResultsContract")(function* (
  companyId: string
) {
  const definition: typeof Manifest.Type = {
    ...manifest,
    tables: {
      notes: {
        ...manifest.tables.notes!,
        columns: {
          ...manifest.tables.notes!.columns,
          body: { kind: "text", default: "d".repeat(800) }
        }
      }
    }
  };
  const { binding } = yield* setup(companyId, "expanded0001", definition);
  const handlers = yield* TableOperations.make.pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          PATCHY_RUNTIME_ROW_BYTES: "2048",
          PATCHY_RUNTIME_BATCH_BYTES: "1024",
          PATCHY_RUNTIME_RESULT_BYTES: "1800"
        })
      )
    )
  );
  const call = (op: keyof typeof handlers, args: unknown) =>
    handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
  const rows = yield* Effect.forEach(["one", "two"], (slug) =>
    call("tables.insert", {
      table: "notes",
      row: { title: slug, slug, at: "2026-09-10T12:00:00.123456Z" }
    }).pipe(Effect.flatMap(decodeRow))
  );
  for (const [op, args] of [
    ["tables.list", { table: "notes", index: "bySlug", limit: 2 }],
    ["tables.getMany", { table: "notes", ids: rows.map((row) => row.id) }],
    ["tables.getMany", { table: "notes", ids: [rows[0]!.id, rows[0]!.id] }]
  ] as const)
    assert.strictEqual((yield* call(op, args).pipe(Effect.flip)).code, "too_large");

  // The lookahead row does not consume the page budget or lose timestamp precision.
  const first = yield* call("tables.list", { table: "notes", index: "bySlug", limit: 1 }).pipe(
    Effect.flatMap(decodePage)
  );
  assert.deepStrictEqual(first.rows, [rows[0]]);
  assert.isString(first.cursor);
  const second = yield* call("tables.list", {
    table: "notes",
    index: "bySlug",
    limit: 1,
    cursor: first.cursor
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(second.rows, [rows[1]]);
  assert.isNull(second.cursor);
  assert.strictEqual(first.rows[0]!.at, "2026-09-10T12:00:00.123456Z");

  // The inputs fit the batch budget and each stored row fits the row budget,
  // but database defaults expand their combined result beyond the response budget.
  assert.strictEqual(
    (yield* call("tables.insertMany", {
      table: "notes",
      rows: [
        { title: "three", slug: "three" },
        { title: "four", slug: "four" }
      ]
    }).pipe(Effect.flip)).code,
    "too_large"
  );
  for (const slug of ["three", "four"])
    assert.deepStrictEqual(
      (yield* call("tables.list", { table: "notes", index: "bySlug", eq: { slug } }).pipe(
        Effect.flatMap(decodePage)
      )).rows,
      []
    );
});

export const indexKeyContract = Effect.fn("test.indexKeyContract")(function* (companyId: string) {
  const { call, databases, binding } = yield* setup(companyId, "indexkeys001");
  const large = "x".repeat(Tables.INDEX_KEY_MAX_BYTES);
  for (const row of [
    { title: "explicit", slug: large },
    { title: "implicit", slug: "implicit", noteId: large }
  ]) {
    const failure = yield* call("tables.insert", { table: "notes", row }).pipe(Effect.flip);
    assert.strictEqual(failure.code, "too_large");
    assert.instanceOf(failure, TableOperations.IndexKeyTooLarge);
    if (failure instanceof TableOperations.IndexKeyTooLarge) {
      assert.strictEqual(failure.table, "notes");
      assert.strictEqual(failure.maxBytes, Tables.INDEX_KEY_MAX_BYTES);
    }
  }
  const row = yield* call("tables.insert", {
    table: "notes",
    row: { title: "unindexed", slug: "unindexed", body: large }
  }).pipe(Effect.flatMap(decodeRow));
  assert.strictEqual(row.body, large);
  assert.strictEqual(
    (yield* call("tables.update", {
      table: "notes",
      id: row.id,
      patch: { slug: large }
    }).pipe(Effect.flip)).code,
    "too_large"
  );
  assert.deepStrictEqual(yield* call("tables.get", { table: "notes", id: row.id }), row);
  const qualified = `${Inventory.quoteIdentifier(Inventory.namespace(binding.patchId))}."notes"`;
  yield* databases.withCompany(companyId)(
    Effect.gen(function* () {
      const sql = yield* CompanyDatabases.CompanyConnection;
      yield* sql.unsafe(`CREATE INDEX "native_index_limit" ON ${qualified} ("body")`);
      yield* sql.unsafe(
        `ALTER TABLE ${qualified} ADD CONSTRAINT "business_check" CHECK ("title" <> 'refused')`
      );
    })
  );
  const nativeFailure = yield* call("tables.insert", {
    table: "notes",
    row: {
      title: "native",
      slug: "native",
      body: Array.from({ length: 128 }, (_, index) =>
        createHash("sha256").update(String(index)).digest("hex")
      ).join("")
    }
  }).pipe(Effect.flip);
  assert.instanceOf(nativeFailure, TableOperations.IndexKeyTooLarge);
  assert.strictEqual(nativeFailure.code, "too_large");
  assert.strictEqual(
    (yield* call("tables.insert", {
      table: "notes",
      row: { title: "refused", slug: "refused" }
    }).pipe(Effect.flip)).code,
    "invalid_row"
  );
});
