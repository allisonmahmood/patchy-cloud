import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { assert } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as SqlError from "effect/unstable/sql/SqlError";
import {
  CURRENT_RELEASE,
  Manifest,
  sharedTableId,
  TablePage,
  TableRow,
  WIRE_VERSION
} from "@patchy/api";
import { CompanyDatabases } from "@patchy/company-database";
import { Binding, LoadedVersions } from "@patchy/runtime";
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
  const nullRanks = yield* call("tables.list", {
    table: "notes",
    index: "byRank",
    eq: { rank: null }
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(
    new Set(nullRanks.rows.map((row) => row.id)),
    new Set([first.id, added[3]!.id])
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
  const malformedCursor = yield* call("tables.list", {
    table: "notes",
    cursor: Buffer.from("{").toString("base64url")
  }).pipe(Effect.flip);
  assert.instanceOf(malformedCursor, TableOperations.InvalidCursor);
  if (malformedCursor instanceof TableOperations.InvalidCursor)
    assert.instanceOf(malformedCursor.cause, Schema.SchemaError);
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
  const omitted: typeof Manifest.Type = { ...newer, tables: {} };
  yield* databases.withCompany(companyId)(
    databases.withPatchLock(binding.patchId)(tables.provision(binding.patchId, omitted))
  );
  for (const [op, args] of [
    ["tables.get", { table: "notes", id: oldInsert.id }],
    ["tables.insert", { table: "notes", row: { title: "latest", slug: "latest" } }]
  ] as const) {
    const denied = yield* handlers[op]
      .run(args)
      .pipe(Effect.provideService(Binding.Binding, { ...binding, manifest: omitted }), Effect.flip);
    assert.strictEqual(denied.code, "table_not_declared");
  }
  assert.deepStrictEqual(
    yield* call("tables.get", { table: "notes", id: oldInsert.id }),
    oldInsert
  );
  const stillWritable = yield* call("tables.insert", {
    table: "notes",
    row: { title: "still loaded", slug: "still-loaded" }
  }).pipe(Effect.flatMap(decodeRow));
  assert.deepStrictEqual(
    yield* call("tables.get", { table: "notes", id: stillWritable.id }),
    stillWritable
  );
  assert.isNull(yield* call("tables.delete", { table: "notes", id: first.id }));
  assert.isNull(yield* call("tables.delete", { table: "notes", id: first.id }));
  assert.isNull(yield* call("tables.get", { table: "notes", id: first.id }));
  assert.deepStrictEqual(yield* call("tables.getMany", { table: "notes", ids: [] }), []);
  assert.deepStrictEqual(yield* call("tables.insertMany", { table: "notes", rows: [] }), []);
});

export const sharedOperationsContract = Effect.fn("test.sharedOperationsContract")(function* (
  companyId: string
) {
  const definition: typeof Manifest.Type = {
    ...manifest,
    name: "shared-source",
    tables: { notes: { ...manifest.tables.notes!, shared: true } }
  };
  const source = yield* setup(companyId, "sharedsource", definition);
  const rows = yield* source
    .call("tables.insertMany", {
      table: "notes",
      rows: [
        { title: "shared", slug: "first", rank: 1 },
        { title: "shared", slug: "second", rank: 2 },
        { title: "shared", slug: "third", rank: null }
      ]
    })
    .pipe(Effect.flatMap(decodeRows));
  const declaration = {
    kind: "sharedTable" as const,
    patchId: source.binding.patchId,
    table: "notes",
    id: sharedTableId(source.binding.patchId, "notes"),
    revision: 1
  };
  const consumer = yield* setup(companyId, "sharedreader", {
    ...manifest,
    uses: { contacts: declaration, alternate: declaration }
  });
  const own = yield* consumer
    .call("tables.insert", {
      table: "notes",
      row: { title: "mine", slug: "first" }
    })
    .pipe(Effect.flatMap(decodeRow));
  const binding: Binding.Binding["Service"] = {
    ...consumer.binding,
    principal: { userId: "usr_viewer" },
    identity: {
      user: { id: "usr_viewer", name: "Viewer", email: "viewer@example.test" },
      company: { id: companyId, handle: "company", name: "Company" },
      admin: false
    }
  };
  const live = yield* Ref.make(
    new Map<string, LoadedVersions.LoadedVersion>([[source.binding.patchId, source.binding]])
  );
  const versions = LoadedVersions.LoadedVersions.of({
    find: (patchId, versionId) =>
      Ref.get(live).pipe(
        Effect.map((current) => {
          const found = current.get(patchId);
          return found === undefined || (versionId !== undefined && found.versionId !== versionId)
            ? Option.none()
            : Option.some(found);
        })
      )
  });
  const handlers = yield* TableOperations.make.pipe(
    Effect.provideService(LoadedVersions.LoadedVersions, versions)
  );
  const call = (op: keyof typeof handlers, args: unknown) =>
    handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, binding));
  assert.deepStrictEqual(
    yield* call("shared.getMany", {
      alias: "contacts",
      ids: [rows[1]!.id, "dangling", rows[0]!.id, rows[1]!.id]
    }),
    [rows[1], null, rows[0], rows[1]]
  );
  assert.isNull(yield* call("shared.get", { alias: "contacts", id: own.id }));
  assert.deepStrictEqual(yield* call("shared.getMany", { alias: "contacts", ids: [] }), []);
  assert.strictEqual(
    (yield* call("shared.getMany", { alias: "missing", ids: [] }).pipe(Effect.flip)).code,
    "table_not_declared"
  );
  assert.strictEqual(
    (yield* call("tables.insert", {
      table: "contacts",
      row: { title: "forbidden", slug: "forbidden" }
    }).pipe(Effect.flip)).code,
    "table_not_declared"
  );
  for (const identity of [
    null,
    { ...binding.identity!, company: { id: "other", handle: "other", name: "Other" } }
  ]) {
    assert.strictEqual(
      (yield* handlers["shared.getMany"]
        .run({ alias: "contacts", ids: [] })
        .pipe(Effect.provideService(Binding.Binding, { ...binding, identity }), Effect.flip)).code,
      "access_denied"
    );
  }
  const bounded = yield* TableOperations.make.pipe(
    Effect.provideService(LoadedVersions.LoadedVersions, versions),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          PATCHY_TABLE_MAX_ITEMS: "2",
          PATCHY_TABLE_MAX_PAGE: "2",
          PATCHY_RUNTIME_RESULT_BYTES: "32"
        })
      )
    )
  );
  for (const [op, args] of [
    ["shared.getMany", { alias: "contacts", ids: ["a", "b", "c"] }],
    ["shared.list", { alias: "contacts", limit: 3 }],
    ["shared.getMany", { alias: "contacts", ids: [rows[0]!.id] }],
    ["shared.list", { alias: "contacts", limit: 1 }]
  ] as const) {
    assert.strictEqual(
      (yield* bounded[op]
        .run(args)
        .pipe(Effect.provideService(Binding.Binding, binding), Effect.flip)).code,
      "too_large"
    );
  }
  const first = yield* call("shared.list", {
    alias: "contacts",
    index: "byTitleRank",
    eq: { title: "shared" },
    limit: 1
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(first.rows, [rows[0]]);
  assert.isString(first.cursor);
  const second = yield* call("shared.list", {
    alias: "alternate",
    index: "byTitleRank",
    eq: { title: "shared" },
    cursor: first.cursor,
    limit: 1
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(second.rows, [rows[1]]);
  const last = yield* call("shared.list", {
    alias: "contacts",
    index: "byTitleRank",
    eq: { title: "shared" },
    cursor: second.cursor
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(last.rows, [rows[2]]);
  assert.isNull(last.cursor);
  assert.strictEqual(
    (yield* call("shared.list", {
      alias: "contacts",
      index: "byTitleRank",
      eq: { title: "other" },
      cursor: first.cursor
    }).pipe(Effect.flip)).code,
    "invalid_cursor"
  );

  const expanded: typeof Manifest.Type = {
    ...definition,
    tables: {
      notes: {
        ...definition.tables.notes!,
        columns: {
          ...definition.tables.notes!.columns,
          added: { kind: "text", default: "inventory" }
        },
        indexes: { ...definition.tables.notes!.indexes, byAdded: { columns: ["added"] } }
      }
    }
  };
  yield* source.databases.withCompany(companyId)(
    source.databases.withPatchLock(source.binding.patchId)(
      source.tables.provision(source.binding.patchId, expanded)
    )
  );
  const omitted = { ...definition, tables: {} };
  yield* source.databases.withCompany(companyId)(
    source.databases.withPatchLock(source.binding.patchId)(
      source.tables.provision(source.binding.patchId, omitted)
    )
  );
  yield* Ref.set(
    live,
    new Map([[source.binding.patchId, { ...source.binding, manifest: omitted }]])
  );
  const cumulative = rows.map((row) => ({ ...row, added: "inventory" }));
  assert.deepStrictEqual(
    yield* call("shared.get", { alias: "contacts", id: rows[0]!.id }),
    cumulative[0]
  );
  const indexed = yield* call("shared.list", {
    alias: "contacts",
    index: "byAdded",
    eq: { added: "inventory" }
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(
    indexed.rows.map((row) => row.id).sort(),
    rows.map((row) => row.id).sort()
  );
  assert.isTrue(indexed.rows.every((row) => row.added === "inventory"));
  const ranged = yield* call("shared.list", {
    alias: "contacts",
    index: "byRank",
    range: { column: "rank", gte: 2 }
  }).pipe(Effect.flatMap(decodePage));
  assert.deepStrictEqual(ranged.rows, [cumulative[1]]);

  const deniedReads = [
    ["shared.list", { alias: "contacts", cursor: first.cursor }],
    ["shared.get", { alias: "contacts", id: rows[0]!.id }],
    ["shared.getMany", { alias: "contacts", ids: [rows[0]!.id, "dangling"] }],
    ["shared.getMany", { alias: "contacts", ids: [] }]
  ] as const;
  yield* source.databases.withCompany(companyId)(
    source.databases.withPatchLock(source.binding.patchId)(
      source.tables.provision(source.binding.patchId, {
        ...definition,
        tables: { notes: { ...definition.tables.notes!, shared: false } }
      })
    )
  );
  // A rollback changes only the loaded manifest, never the inventory's sharing authority.
  yield* Ref.set(live, new Map([[source.binding.patchId, source.binding]]));
  for (const [op, args] of deniedReads)
    assert.strictEqual((yield* call(op, args).pipe(Effect.flip)).code, "access_denied");
  assert.deepStrictEqual(yield* consumer.call("tables.get", { table: "notes", id: own.id }), own);
  assert.deepStrictEqual(
    yield* source.call("tables.get", { table: "notes", id: rows[0]!.id }),
    rows[0]
  );

  yield* source.databases.withCompany(companyId)(
    source.databases.withPatchLock(source.binding.patchId)(
      source.tables.provision(source.binding.patchId, definition)
    )
  );
  yield* Ref.set(
    live,
    new Map([[source.binding.patchId, { ...source.binding, companyId: "other" }]])
  );
  for (const [op, args] of deniedReads)
    assert.strictEqual((yield* call(op, args).pipe(Effect.flip)).code, "access_denied");

  const replacement = yield* setup(companyId, "sharednewone", definition);
  const replacementRow = yield* replacement
    .call("tables.insert", {
      table: "notes",
      row: { title: "replacement", slug: "first" }
    })
    .pipe(Effect.flatMap(decodeRow));
  yield* Ref.set(live, new Map([[replacement.binding.patchId, replacement.binding]]));
  for (const [op, args] of deniedReads)
    assert.strictEqual((yield* call(op, args).pipe(Effect.flip)).code, "access_denied");
  assert.deepStrictEqual(yield* consumer.call("tables.get", { table: "notes", id: own.id }), own);
  const rebound = {
    ...binding,
    manifest: {
      ...binding.manifest,
      uses: {
        contacts: {
          ...declaration,
          patchId: replacement.binding.patchId,
          id: sharedTableId(replacement.binding.patchId, "notes")
        }
      }
    }
  };
  assert.deepStrictEqual(
    yield* handlers["shared.get"]
      .run({ alias: "contacts", id: replacementRow.id })
      .pipe(Effect.provideService(Binding.Binding, rebound)),
    replacementRow
  );
  assert.strictEqual(
    (yield* handlers["shared.list"]
      .run({
        alias: "contacts",
        index: "byTitleRank",
        eq: { title: "shared" },
        cursor: first.cursor
      })
      .pipe(Effect.provideService(Binding.Binding, rebound), Effect.flip)).code,
    "invalid_cursor"
  );
  assert.strictEqual(
    (yield* handlers["shared.getMany"].run({ alias: "contacts", ids: [] }).pipe(
      Effect.provideService(Binding.Binding, {
        ...rebound,
        manifest: {
          ...rebound.manifest,
          uses: { contacts: { ...rebound.manifest.uses.contacts, id: declaration.id } }
        }
      }),
      Effect.flip
    )).code,
    "access_denied"
  );
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
  const { call, databases, tables, binding } = yield* setup(companyId, "indexkeys001");
  const large = Array.from({ length: 128 }, (_, index) =>
    createHash("sha256").update(String(index)).digest("hex")
  ).join("");
  for (const row of [
    { title: "explicit", slug: large },
    { title: "implicit", slug: "implicit", noteId: large }
  ]) {
    const failure = yield* call("tables.insert", { table: "notes", row }).pipe(Effect.flip);
    assert.strictEqual(failure.code, "too_large");
    assert.instanceOf(failure, TableOperations.IndexKeyTooLarge);
    if (failure instanceof TableOperations.IndexKeyTooLarge) {
      assert.strictEqual(failure.table, "notes");
      assert.instanceOf(failure.cause, SqlError.SqlError);
      const sqlError = failure.cause as SqlError.SqlError;
      assert.propertyVal(sqlError.reason.cause, "code", "54000");
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
  yield* call("tables.update", { table: "notes", id: row.id, patch: { body: "short" } });
  const indexed: typeof Manifest.Type = {
    ...manifest,
    tables: {
      notes: {
        ...manifest.tables.notes!,
        indexes: { ...manifest.tables.notes!.indexes, byBody: { columns: ["body"] } }
      }
    }
  };
  yield* databases.withCompany(companyId)(
    databases.withPatchLock(binding.patchId)(tables.provision(binding.patchId, indexed))
  );
  // An old loaded manifest is not retroactively subject to publish's conservative preflight.
  const compressible = "x".repeat(8192);
  const oldWrite = yield* call("tables.insert", {
    table: "notes",
    row: { title: "old writer", slug: "old-writer", body: compressible }
  }).pipe(Effect.flatMap(decodeRow));
  assert.strictEqual(oldWrite.body, compressible);
  const nativeFailure = yield* call("tables.insertMany", {
    table: "notes",
    rows: [
      { title: "rollback", slug: "rollback" },
      { title: "native", slug: "native", body: large }
    ]
  }).pipe(Effect.flip);
  assert.instanceOf(nativeFailure, TableOperations.IndexKeyTooLarge);
  assert.strictEqual(nativeFailure.code, "too_large");
  if (nativeFailure instanceof TableOperations.IndexKeyTooLarge) {
    assert.instanceOf(nativeFailure.cause, SqlError.SqlError);
    assert.propertyVal((nativeFailure.cause as SqlError.SqlError).reason.cause, "code", "54000");
  }
  assert.deepStrictEqual(
    (yield* call("tables.list", {
      table: "notes",
      index: "bySlug",
      eq: { slug: "rollback" }
    }).pipe(Effect.flatMap(decodePage))).rows,
    []
  );
  assert.deepStrictEqual(yield* call("tables.get", { table: "notes", id: oldWrite.id }), oldWrite);
});

export const uuidContract = Effect.fn("test.uuidContract")(function* (companyId: string) {
  const { call } = yield* setup(companyId, "uuidversion7");
  const milliseconds = 1_789_056_789_123;
  yield* TestClock.setTime(milliseconds);
  const rows = yield* call("tables.insertMany", {
    table: "notes",
    rows: Array.from({ length: 128 }, (_, index) => ({ title: "uuid", slug: `uuid-${index}` }))
  }).pipe(Effect.flatMap(decodeRows));
  let anyRandom = 0n;
  let everyRandom = (1n << 74n) - 1n;
  let independentFields = false;
  const randomA = new Set<number>();
  const randomB = new Set<bigint>();
  for (const row of rows) {
    const bytes = Buffer.from(String(row.id).replaceAll("-", ""), "hex");
    assert.strictEqual(bytes.readUIntBE(0, 6), milliseconds);
    assert.strictEqual(bytes[6]! >>> 4, 7);
    assert.strictEqual(bytes[8]! >>> 6, 2);
    const a = bytes.readUInt16BE(6) & 0x0fff;
    const b = bytes.readBigUInt64BE(8) & ((1n << 62n) - 1n);
    randomA.add(a);
    randomB.add(b);
    independentFields ||= BigInt(a) !== (b & 0xfffn);
    const bits = (BigInt(a) << 62n) | b;
    anyRandom |= bits;
    everyRandom &= bits;
  }
  // Every random bit varies at a fixed timestamp, including all twelve rand_a bits.
  assert.strictEqual(anyRandom, (1n << 74n) - 1n);
  assert.strictEqual(everyRandom, 0n);
  assert.isAbove(randomA.size, 1);
  assert.strictEqual(randomB.size, rows.length);
  assert.isTrue(independentFields);
  yield* TestClock.adjust(1);
  const next = yield* call("tables.insert", {
    table: "notes",
    row: { title: "next millisecond", slug: "next" }
  }).pipe(Effect.flatMap(decodeRow));
  assert.strictEqual(
    Buffer.from(String(next.id).replaceAll("-", ""), "hex").readUIntBE(0, 6),
    yield* Clock.currentTimeMillis
  );
  assert.isTrue(rows.every((row) => String(row.id) < String(next.id)));
});
