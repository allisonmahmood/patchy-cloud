import { Buffer } from "node:buffer";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  CURRENT_RELEASE,
  PostgresKeyRows,
  PostgresPage,
  PostgresRows,
  WIRE_VERSION
} from "@patchy/api";
import { Binding } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import * as Execution from "./Execution.js";
import * as Operations from "./Operations.js";
import type { Column, Snapshot } from "./Snapshot.js";

const column = (name: string, baseName: string, nullable = false): typeof Column.Type => ({
  name,
  nullable,
  type: {
    schema: "pg_catalog",
    name: baseName,
    sql: baseName,
    baseSchema: "pg_catalog",
    baseName,
    kind: "base"
  }
});
const relation = { schema: 'sales";--', name: 'order";--' };
const snapshot: typeof Snapshot.Type = {
  version: 1,
  enums: [{ schema: "public", name: "mood", labels: ["happy", "sad"] }],
  exclusions: [],
  relations: [
    {
      ...relation,
      kind: "table",
      primaryKey: { name: "order_pk", columns: ['id";--'] },
      foreignKeys: [],
      columns: [
        column('id";--', "int4"),
        column("small", "int2"),
        column("wide", "int8"),
        column("decimal", "numeric"),
        column("single", "float4"),
        column("double", "float8"),
        column("label", "text"),
        column("uuid", "uuid"),
        {
          name: "insensitive",
          nullable: false,
          type: {
            schema: "public",
            name: "citext",
            sql: "public.citext",
            baseSchema: "public",
            baseName: "citext",
            kind: "base"
          }
        },
        column("enabled", "bool"),
        column("at", "timestamptz"),
        column("local", "timestamp"),
        column("day", "date"),
        column("document", "jsonb"),
        {
          name: "tags",
          nullable: false,
          type: {
            schema: "pg_catalog",
            name: "_text",
            sql: "text[]",
            baseSchema: "pg_catalog",
            baseName: "_text",
            kind: "array",
            element: { baseSchema: "pg_catalog", baseName: "text", kind: "base" }
          }
        },
        {
          name: "mood",
          nullable: false,
          type: {
            schema: "public",
            name: "mood",
            sql: "public.mood",
            baseSchema: "public",
            baseName: "mood",
            kind: "enum"
          }
        },
        {
          name: "domain",
          nullable: false,
          type: {
            schema: "public",
            name: "positive",
            sql: "public.positive",
            baseSchema: "pg_catalog",
            baseName: "int4",
            kind: "base"
          }
        },
        column("rank", "int4", true),
        column("__proto__", "text")
      ]
    },
    {
      schema: "public",
      name: "unkeyed",
      kind: "view",
      primaryKey: null,
      foreignKeys: [],
      columns: [column("id", "int4", true)]
    }
  ]
};
const declaration = {
  kind: "postgres" as const,
  id: "connection-operations",
  handle: "warehouse",
  revision: 1
};
const binding = Binding.Binding.of({
  companyId: "cmp_operations",
  patchId: "operations01",
  versionId: "ver_aaaaaaaaaaaaaaaaaaaaaaaa",
  manifest: {
    manifestVersion: 1,
    release: CURRENT_RELEASE,
    tier: 1,
    tables: {},
    files: {},
    uses: { sales: declaration }
  },
  wireVersion: WIRE_VERSION,
  scope: "company",
  correlationId: "operation-test",
  principal: { userId: "usr_operations" },
  identity: {
    user: { id: "usr_operations", email: "member@example.test", name: "Member" },
    company: { id: "cmp_operations", handle: "operations", name: "Operations" },
    admin: false
  }
});
const connection = new ConnectionStore.Connection({
  companyId: binding.companyId,
  id: declaration.id,
  integration: "postgres",
  handle: declaration.handle,
  description: "Operation fixture",
  mode: "company",
  status: "connected",
  credentialRevision: 1,
  metadataRevision: 2,
  display: { host: "fixture.example", port: 5432, database: "fixture", role: "reader" },
  lastTestedAt: null,
  lastDiscoveredAt: null,
  createdBy: "usr_operations"
});
const refreshed: typeof Snapshot.Type = {
  ...snapshot,
  relations: snapshot.relations.map((item) =>
    item.name !== relation.name
      ? item
      : {
          ...item,
          columns: [...item.columns, column("after_refresh", "text", true)]
        }
  )
};
const setup = Effect.fn("test.postgresOperations.setup")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "postgres-operations-" });
  let db: PGlite | undefined;
  const open = Effect.fn("test.postgresOperations.open")(function* () {
    return (db ??= yield* Effect.promise(() =>
      PGlite.create({
        dataDir,
        extensions: { citext },
        parsers: Object.fromEntries(
          Execution.textTypeOids.map((oid) => [oid, Execution.types.getTypeParser(oid, "text")])
        )
      })
    ));
  });
  const close = Effect.promise(async () => {
    const current = db;
    db = undefined;
    await current?.close();
  });
  yield* Effect.addFinalizer(() => close);
  const sql = Effect.fn("test.postgresOperations.sql")(function* (text: string) {
    const db = yield* open();
    return yield* Effect.promise(() => db.exec(text));
  });
  yield* sql(`CREATE SCHEMA "sales"";--";
    CREATE EXTENSION citext;
    CREATE TYPE public.mood AS ENUM ('happy', 'sad');
    CREATE DOMAIN public.positive AS integer CHECK (VALUE > 0);
    CREATE TABLE "sales"";--"."order"";--" (
      "id"";--" integer PRIMARY KEY, small smallint NOT NULL, wide bigint NOT NULL, decimal numeric NOT NULL,
      single real NOT NULL, double double precision NOT NULL, label text NOT NULL,
      uuid uuid NOT NULL, insensitive public.citext NOT NULL, enabled boolean NOT NULL,
      at timestamptz NOT NULL, local timestamp NOT NULL, day date NOT NULL, document jsonb NOT NULL,
      tags text[] NOT NULL, mood public.mood NOT NULL, domain public.positive NOT NULL, rank integer,
      "__proto__" text NOT NULL, after_refresh text
    );
    INSERT INTO "sales"";--"."order"";--" SELECT n, 7, 9007199254740993, 12345678901234567890.123456,
      1.5, 2.25, 'row-' || n, ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      'MiXeD-' || n, true, '2026-01-02 03:04:05.123456+02', '2026-01-02 03:04:05.654321',
      '2026-01-02', '{"nested":[1,true]}', ARRAY['a','b'], 'happy', 1,
      CASE WHEN n > 2 THEN NULL ELSE 1 END, 'not-a-prototype', 'new-contract'
      FROM generate_series(1, 4) n;
    CREATE VIEW public.unkeyed AS SELECT n::integer AS id FROM generate_series(1, 10001) n;`);
  const queries: string[] = [];
  // This trusted in-process adapter carries rows only; production owns all execution policy.
  const transport: Execution.StatementTransport = {
    execute: (text, parameters, onRow) =>
      Effect.gen(function* () {
        const db = yield* open();
        const result = yield* Effect.tryPromise({
          try: () => db.query<unknown[]>(text, [...parameters], { rowMode: "array" }),
          catch: Execution.queryError
        });
        for (const row of result.rows) {
          const refused = onRow(row, result.fields);
          if (refused !== undefined) return yield* Effect.fail(refused);
        }
        return result.fields;
      }),
    destroy: close
  };
  const execution = Execution.Execution.of({
    query: Effect.fn("test.postgresOperations.query")(function* ({
      text,
      parameters
    }: Execution.QueryInput) {
      queries.push(text);
      return yield* Execution.runStatement(transport, text, parameters);
    })
  });
  const store = yield* ConnectionStore.ConnectionStore.pipe(
    Effect.provide(
      ConnectionStore.layerDev([
        {
          connection,
          snapshots: [
            { revision: 1, snapshot },
            { revision: 2, snapshot: refreshed }
          ]
        }
      ])
    )
  );
  let current = connection;
  const liveStore = ConnectionStore.ConnectionStore.of({
    ...store,
    get: (companyId, id) =>
      companyId === current.companyId && id === current.id
        ? Effect.succeed(current)
        : store.get(companyId, id)
  });
  const handlers = yield* Operations.makeHandlers.pipe(
    Effect.provideService(Execution.Execution, execution),
    Effect.provideService(ConnectionStore.ConnectionStore, liveStore)
  );
  const call = (op: keyof typeof handlers, args: unknown, requestBinding = binding) =>
    handlers[op].run(args).pipe(Effect.provideService(Binding.Binding, requestBinding));
  return {
    call,
    sql,
    queries,
    handlers,
    execution,
    liveStore,
    setConnection: (next: ConnectionStore.Connection) => {
      current = next;
    }
  };
}, Effect.provide(NodeFileSystem.layer));
const decodePage = Schema.decodeUnknownEffect(PostgresPage);
const decodeRows = Schema.decodeUnknownEffect(PostgresRows);
const decodeKeys = Schema.decodeUnknownEffect(PostgresKeyRows);

it.effect(
  "projects every mapping category through the pinned snapshot and quotes hostile identifiers",
  () =>
    Effect.gen(function* () {
      const { call } = yield* setup();
      const page = yield* call("postgres.list", {
        connection: "sales",
        relation,
        eq: { enabled: true },
        range: { column: 'id";--', gte: 1, lt: 3 },
        orderBy: { column: 'id";--', direction: "desc" }
      }).pipe(Effect.flatMap(decodePage));
      assert.deepStrictEqual(
        page.rows.map((row) => row['id";--']),
        [2, 1]
      );
      assert.deepStrictEqual(page.rows[0], {
        'id";--': 2,
        small: 7,
        wide: "9007199254740993",
        decimal: "12345678901234567890.123456",
        single: 1.5,
        double: 2.25,
        label: "row-2",
        uuid: "00000000-0000-4000-8000-000000000002",
        insensitive: "MiXeD-2",
        enabled: true,
        at: "2026-01-02T01:04:05.123456Z",
        local: "2026-01-02T03:04:05.654321",
        day: "2026-01-02",
        document: { nested: [1, true] },
        tags: ["a", "b"],
        mood: "happy",
        domain: 1,
        rank: 1,
        ["__proto__"]: "not-a-prototype"
      });
      assert.isFalse(Object.hasOwn(page.rows[0]!, "after_refresh"));
      const nativeText = yield* call("postgres.list", {
        connection: "sales",
        relation,
        select: ["uuid", "insensitive"],
        eq: {
          uuid: "00000000-0000-4000-8000-000000000002",
          insensitive: "mixed-2"
        }
      }).pipe(Effect.flatMap(decodePage));
      assert.deepStrictEqual(nativeText.rows, [
        { uuid: "00000000-0000-4000-8000-000000000002", insensitive: "MiXeD-2" }
      ]);
      for (const args of [
        { eq: { document: "wrong-kind" } },
        { eq: { wide: 9007199254740992 } },
        { range: { column: "rank", gt: null } },
        { range: { column: "rank", gt: 0, gte: 0 } },
        { range: { column: "rank" } },
        { orderBy: { column: "tags", direction: "asc" } },
        { select: ["after_refresh"] },
        { select: ["label", "label"] }
      ])
        assert.strictEqual(
          (yield* call("postgres.list", { connection: "sales", relation, ...args }).pipe(
            Effect.flip
          )).code,
          "invalid_request"
        );
    }).pipe(Effect.scoped)
);

it.effect(
  "keysets preserve nullable ordering in both directions even when selected columns omit the keys",
  () =>
    Effect.gen(function* () {
      const { call } = yield* setup();
      for (const direction of ["asc", "desc"] as const) {
        const args = {
          connection: "sales",
          relation,
          orderBy: { column: "rank", direction },
          select: ["label"],
          limit: 1
        };
        let cursor: string | null = null;
        const labels: unknown[] = [];
        do {
          const page = yield* call("postgres.list", {
            ...args,
            ...(cursor === null ? {} : { cursor })
          }).pipe(Effect.flatMap(decodePage));
          for (const row of page.rows) {
            assert.deepStrictEqual(Object.keys(row), ["label"]);
            labels.push(row.label);
          }
          cursor = page.cursor;
        } while (cursor !== null);
        assert.deepStrictEqual(
          labels,
          direction === "asc"
            ? ["row-1", "row-2", "row-3", "row-4"]
            : ["row-2", "row-1", "row-4", "row-3"]
        );
      }
      const first = yield* call("postgres.list", { connection: "sales", relation, limit: 1 }).pipe(
        Effect.flatMap(decodePage)
      );
      for (const changes of [
        { eq: { enabled: false } },
        { orderBy: { column: "rank", direction: "asc" } },
        { relation: { schema: "public", name: "unkeyed" } }
      ])
        assert.strictEqual(
          (yield* call("postgres.list", {
            connection: "sales",
            relation,
            cursor: first.cursor,
            ...changes
          }).pipe(Effect.flip)).code,
          "invalid_cursor"
        );
      const altered = JSON.parse(Buffer.from(first.cursor!, "base64url").toString("utf8"));
      altered.values = ["not-an-integer"];
      assert.strictEqual(
        (yield* call("postgres.list", {
          connection: "sales",
          relation,
          cursor: Buffer.from(JSON.stringify(altered)).toString("base64url")
        }).pipe(Effect.flip)).code,
        "invalid_cursor"
      );
      const changedRevision = {
        ...binding,
        manifest: { ...binding.manifest, uses: { sales: { ...declaration, revision: 2 } } }
      };
      assert.strictEqual(
        (yield* call(
          "postgres.list",
          { connection: "sales", relation, cursor: first.cursor },
          changedRevision
        ).pipe(Effect.flip)).code,
        "invalid_cursor"
      );
    }).pipe(Effect.scoped)
);

it.effect("unkeyed pages stop at 10000 and a maximal page never fetches a 1001st row", () =>
  Effect.gen(function* () {
    const { call } = yield* setup();
    const args = {
      connection: "sales",
      relation: { schema: "public", name: "unkeyed" },
      limit: 1000,
      orderBy: { column: "id", direction: "asc" }
    };
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = yield* call("postgres.list", {
        ...args,
        ...(cursor === null ? {} : { cursor })
      }).pipe(Effect.flatMap(decodePage));
      assert.strictEqual(page.rows.length, 1000);
      assert.strictEqual(page.rows[0]!.id, pageNumber * 1000 + 1);
      assert.strictEqual(page.rows[999]!.id, (pageNumber + 1) * 1000);
      cursor = page.cursor;
    }
    assert.strictEqual(
      (yield* call("postgres.list", { ...args, cursor }).pipe(Effect.flip)).code,
      "offset_exhausted"
    );
    const altered = JSON.parse(Buffer.from(cursor!, "base64url").toString("utf8"));
    for (const offset of [-1, 0.5, 10001]) {
      altered.offset = offset;
      assert.strictEqual(
        (yield* call("postgres.list", {
          ...args,
          cursor: Buffer.from(JSON.stringify(altered)).toString("base64url")
        }).pipe(Effect.flip)).code,
        "invalid_cursor"
      );
    }
    assert.strictEqual(
      (yield* call("postgres.get", {
        connection: "sales",
        relation: args.relation,
        key: { id: 1 }
      }).pipe(Effect.flip)).code,
      "relation_unknown"
    );
    assert.strictEqual(
      (yield* call("postgres.list", { ...args, limit: 1001 }).pipe(Effect.flip)).code,
      "too_large"
    );
  }).pipe(Effect.scoped)
);

it.effect(
  "getMany is one bounded read preserving input order, missing keys and duplicate positions",
  () =>
    Effect.gen(function* () {
      const { call, queries } = yield* setup();
      const result = yield* call("postgres.getMany", {
        connection: "sales",
        relation,
        keys: [{ 'id";--': 3 }, { 'id";--': 99 }, { 'id";--': 1 }, { 'id";--': 3 }]
      }).pipe(Effect.flatMap(decodeKeys));
      assert.deepStrictEqual(
        result.rows.map((row) => row?.label ?? null),
        ["row-3", null, "row-1", "row-3"]
      );
      assert.strictEqual(queries.length, 1);
      assert.deepStrictEqual(
        yield* call("postgres.get", { connection: "sales", relation, key: { 'id";--': 99 } }).pipe(
          Effect.flatMap(decodeKeys)
        ),
        { ok: true, rows: [null] }
      );
      assert.strictEqual(
        (yield* call("postgres.getMany", {
          connection: "sales",
          relation,
          keys: [{ 'id";--': 1, label: "unexpected" }]
        }).pipe(Effect.flip)).code,
        "invalid_request"
      );
      assert.strictEqual(
        (yield* call("postgres.getMany", {
          connection: "sales",
          relation,
          keys: Array.from({ length: 1001 }, () => ({ 'id";--': 1 }))
        }).pipe(Effect.flip)).code,
        "too_large"
      );
    }).pipe(Effect.scoped)
);

it.effect("refresh never rewrites the pinned contract and source drift fails explicitly", () =>
  Effect.gen(function* () {
    const { call, sql } = yield* setup();
    yield* sql('ALTER TABLE "sales"";--"."order"";--" ALTER COLUMN small TYPE text');
    assert.strictEqual(
      (yield* call("postgres.list", { connection: "sales", relation }).pipe(Effect.flip)).code,
      "shape_mismatch"
    );
    yield* sql('ALTER TABLE "sales"";--"."order"";--" DROP COLUMN label');
    const failure = yield* call("postgres.list", { connection: "sales", relation }).pipe(
      Effect.flip
    );
    assert.strictEqual(failure.code, "shape_mismatch");
    assert.instanceOf(failure, Operations.SourceSchemaChanged);
    if (failure instanceof Operations.SourceSchemaChanged)
      assert.deepStrictEqual(failure.details, { relation, reason: "source_schema_changed" });
  }).pipe(Effect.scoped)
);

it.effect(
  "refuses native numeric drift hidden by text projection, including empty and unselected results",
  () =>
    Effect.gen(function* () {
      const { call, sql } = yield* setup();
      const missing = { connection: "sales", relation, select: ["label"], eq: { 'id";--': 99 } };
      assert.deepStrictEqual(
        (yield* call("postgres.list", missing).pipe(Effect.flatMap(decodePage))).rows,
        []
      );
      yield* sql(
        'ALTER TABLE "sales"";--"."order"";--" ALTER COLUMN wide TYPE text USING wide::text'
      );
      for (const [op, args] of [
        ["postgres.list", missing],
        [
          "postgres.list",
          {
            connection: "sales",
            relation,
            select: ["label"],
            orderBy: { column: "wide", direction: "asc" }
          }
        ],
        ["postgres.get", { connection: "sales", relation, key: { 'id";--': 99 } }],
        [
          "postgres.getMany",
          { connection: "sales", relation, keys: [{ 'id";--': 1 }, { 'id";--': 99 }] }
        ]
      ] as const) {
        const failure = yield* call(op, args).pipe(Effect.flip);
        assert.instanceOf(failure, Operations.SourceSchemaChanged);
        assert.strictEqual(failure.code, "shape_mismatch");
        if (failure instanceof Operations.SourceSchemaChanged)
          assert.deepStrictEqual(failure.details, { relation, reason: "source_schema_changed" });
      }
      yield* sql(
        'ALTER TABLE "sales"";--"."order"";--" ALTER COLUMN wide TYPE bigint USING wide::bigint'
      );
      yield* sql(
        'ALTER TABLE "sales"";--"."order"";--" ALTER COLUMN decimal TYPE text USING decimal::text'
      );
      assert.instanceOf(
        yield* call("postgres.list", {
          connection: "sales",
          relation,
          select: ["label"],
          eq: { decimal: "12345678901234567890.123456" }
        }).pipe(Effect.flip),
        Operations.SourceSchemaChanged
      );
      yield* sql(
        'ALTER TABLE "sales"";--"."order"";--" ALTER COLUMN decimal TYPE numeric USING decimal::numeric'
      );
      yield* sql('ALTER TABLE "sales"";--"."order"";--" ALTER COLUMN domain TYPE integer');
      assert.deepStrictEqual(
        (yield* call("postgres.get", { connection: "sales", relation, key: { 'id";--': 1 } }).pipe(
          Effect.flatMap(decodeKeys)
        )).rows.map((row) => row?.domain),
        [1]
      );
    }).pipe(Effect.scoped)
);

it.effect(
  "strict query checks names and native types on empty results and refuses lossy or invalid values",
  () =>
    Effect.gen(function* () {
      const { call } = yield* setup();
      for (const [sql, shape] of [
        ["SELECT 1 AS extra WHERE false", { wanted: { kind: "integer" } }],
        ["SELECT 1 AS duplicate, 2 AS duplicate WHERE false", { duplicate: { kind: "integer" } }],
        ["SELECT 1::bigint AS value WHERE false", { value: { kind: "integer" } }],
        ["SELECT 1::numeric AS value WHERE false", { value: { kind: "number" } }],
        ["SELECT NULL::text AS value", { value: { kind: "text" } }],
        ["SELECT 'NaN'::float8 AS value", { value: { kind: "number" } }],
        ["SELECT 'Infinity'::float8 AS value", { value: { kind: "number" } }],
        ["SELECT 9007199254740993::bigint AS value", { value: { kind: "integer" } }]
      ] as const)
        assert.strictEqual(
          (yield* call("postgres.query", { connection: "sales", sql, params: [], shape }).pipe(
            Effect.flip
          )).code,
          "shape_mismatch"
        );
      const result = yield* call("postgres.query", {
        connection: "sales",
        sql: "SELECT $1::text AS secret, 7::integer AS count, true AS enabled, 1.5::float8 AS ratio, NULL::text AS absent, '{\"ok\":true}'::jsonb AS data, '2026-01-02 03:04:05.123456+02'::timestamptz AS at, 9007199254740993::bigint AS wide, 'dropped' AS extra",
        params: ["private-parameter"],
        shape: {
          secret: { kind: "text" },
          count: { kind: "integer" },
          enabled: { kind: "boolean" },
          ratio: { kind: "number" },
          absent: { kind: "text", optional: true },
          data: { kind: "json" },
          at: { kind: "timestamp" },
          wide: { kind: "text" }
        }
      }).pipe(Effect.flatMap(decodeRows));
      assert.deepStrictEqual(result.rows, [
        {
          secret: "private-parameter",
          count: 7,
          enabled: true,
          ratio: 1.5,
          absent: null,
          data: { ok: true },
          at: "2026-01-02T01:04:05.123456Z",
          wide: "9007199254740993"
        }
      ]);
      for (const shape of [
        { value: { kind: "ref", table: "notes" } },
        { value: { kind: "text", default: "unsafe" } }
      ])
        assert.strictEqual(
          (yield* call("postgres.query", {
            connection: "sales",
            sql: "SELECT 'x' AS value",
            params: [],
            shape
          }).pipe(Effect.flip)).code,
          "invalid_request"
        );
      assert.strictEqual(
        (yield* call("postgres.query", {
          connection: "sales",
          sql: 'INSERT INTO "sales"";--"."order"";--" ("id"";--") VALUES (99)',
          params: [],
          shape: { value: { kind: "text" } }
        }).pipe(Effect.flip)).code,
        "invalid_query"
      );
    }).pipe(Effect.scoped)
);

it.effect(
  "requires a live declared company binding and emits trusted query-only log metadata without params",
  () =>
    Effect.gen(function* () {
      const { call, handlers, setConnection } = yield* setup();
      const args = { connection: "sales", relation };
      assert.strictEqual(
        (yield* call("postgres.list", { ...args, connection: "notDeclared" }).pipe(Effect.flip))
          .code,
        "connection_not_declared"
      );
      for (const requestBinding of [
        { ...binding, companyId: "cmp_other" },
        { ...binding, identity: null },
        { ...binding, scope: "public" as const }
      ])
        assert.strictEqual(
          (yield* call("postgres.list", args, requestBinding).pipe(Effect.flip)).code,
          "access_denied"
        );
      const queryArgs = {
        connection: "sales",
        sql: "SELECT $1::integer AS value",
        params: ["private-parameter"],
        shape: { value: { kind: "text" } }
      };
      assert.strictEqual(
        handlers["postgres.query"].connectionId!(queryArgs, binding),
        declaration.id
      );
      assert.strictEqual(handlers["postgres.query"].sql!(queryArgs), queryArgs.sql);
      assert.isUndefined(handlers["postgres.list"].sql);
      assert.strictEqual(handlers["postgres.list"].resource!(args), '"sales"";--"."order"";--"');
      assert.strictEqual(
        handlers["postgres.getMany"].rowCount!({ ok: true, rows: [{}, null, {}] }),
        2
      );
      assert.isNull(
        handlers["postgres.query"].connectionId!(
          { ...queryArgs, connection: "notDeclared", connectionId: declaration.id },
          binding
        )
      );
      const failure = yield* call("postgres.query", {
        ...queryArgs,
        sql: "SELECT $1::text AS value",
        shape: { value: { kind: "integer" } }
      }).pipe(Effect.flip);
      assert.strictEqual(failure.code, "shape_mismatch");
      assert.notInclude(JSON.stringify(failure), "private-parameter");
      setConnection(new ConnectionStore.Connection({ ...connection, status: "disconnected" }));
      assert.strictEqual(
        (yield* call("postgres.list", args).pipe(Effect.flip)).code,
        "access_denied"
      );
      setConnection(new ConnectionStore.Connection({ ...connection, handle: "retargeted" }));
      assert.strictEqual(
        (yield* call("postgres.list", args).pipe(Effect.flip)).code,
        "access_denied"
      );
    }).pipe(Effect.scoped)
);
