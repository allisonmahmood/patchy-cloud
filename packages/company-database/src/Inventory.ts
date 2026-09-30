import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as CompanyDatabases from "./CompanyDatabases.js";
import * as ResourceChanges from "./ResourceChanges.js";

export class Patch extends Schema.Class<Patch>("Inventory.Patch")({
  patchId: Schema.String,
  schemaRevision: Schema.Int,
  createdAt: Schema.Date
}) {}

export class Table extends Schema.Class<Table>("Inventory.Table")({
  patchId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  shared: Schema.Boolean,
  resourceRevision: Schema.String,
  createdAt: Schema.Date
}) {}

export class Column extends Schema.Class<Column>("Inventory.Column")({
  patchId: Schema.String,
  table: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["text", "integer", "number", "boolean", "timestamp", "json", "ref"]),
  refTable: Schema.NullOr(Schema.String),
  optional: Schema.Boolean,
  defaultKind: Schema.NullOr(Schema.Literals(["constant", "now"])),
  defaultValue: Schema.Unknown
}) {}

export class Index extends Schema.Class<Index>("Inventory.Index")({
  patchId: Schema.String,
  table: Schema.String,
  name: Schema.String,
  columns: Schema.Array(Schema.String),
  unique: Schema.Boolean
}) {}

export class Store extends Schema.Class<Store>("Inventory.Store")({
  patchId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  shared: Schema.Boolean,
  resourceRevision: Schema.String
}) {}

export class Snapshot extends Schema.Class<Snapshot>("Inventory.Snapshot")({
  ...Patch.fields,
  tables: Schema.Array(Table),
  columns: Schema.Array(Column),
  indexes: Schema.Array(Index),
  stores: Schema.Array(Store)
}) {}

const encodeDefault = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeColumns = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** SQL identifiers are names, never SQL fragments, including embedded quotes. */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const namespace = (patchId: string): string => `p_${patchId}`;

/**
 * The lease supplies the company client per operation; capturing it here would
 * bind inventory to the platform database or another company's transaction.
 * @effect-expect-leaking CompanyConnection
 * @effect-expect-leaking PatchLock
 */
export class Inventory extends Context.Service<
  Inventory,
  {
    readonly ensurePatch: (
      patchId: string
    ) => Effect.Effect<number, SqlError, CompanyDatabases.PatchLock>;
    readonly exists: (
      patchId: string
    ) => Effect.Effect<boolean, SqlError, CompanyDatabases.CompanyConnection>;
    readonly read: (
      patchId: string
    ) => Effect.Effect<Snapshot | null, SqlError, CompanyDatabases.CompanyConnection>;
    readonly putTable: (
      row: Omit<Table, "createdAt" | "resourceRevision">
    ) => Effect.Effect<void, SqlError, CompanyDatabases.PatchLock>;
    readonly putColumn: (row: Column) => Effect.Effect<void, SqlError, CompanyDatabases.PatchLock>;
    readonly putIndex: (row: Index) => Effect.Effect<void, SqlError, CompanyDatabases.PatchLock>;
    readonly putStore: (
      row: Omit<Store, "resourceRevision">
    ) => Effect.Effect<void, SqlError, CompanyDatabases.PatchLock>;
    readonly bumpRevision: (
      patchId: string
    ) => Effect.Effect<number, SqlError, CompanyDatabases.PatchLock>;
  }
>()("@patchy/company-database/Inventory") {}

const findPatch = SqlSchema.findOneOption({
  Request: Schema.String,
  Result: Patch,
  execute: Effect.fn("Inventory.findPatch")(function* (patchId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT "patch_id" AS "patchId", "schema_revision" AS "schemaRevision",
      "created_at" AS "createdAt" FROM "patchy"."patches" WHERE "patch_id" = ${patchId}`;
  })
});

const findTables = SqlSchema.findAll({
  Request: Schema.String,
  Result: Table,
  execute: Effect.fn("Inventory.findTables")(function* (patchId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT "patch_id" AS "patchId", "name", "description", "shared",
      "resource_revision"::text AS "resourceRevision", "created_at" AS "createdAt"
      FROM "patchy"."tables" WHERE "patch_id" = ${patchId} ORDER BY "name"`;
  })
});

const findColumns = SqlSchema.findAll({
  Request: Schema.String,
  Result: Column,
  execute: Effect.fn("Inventory.findColumns")(function* (patchId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT "patch_id" AS "patchId", "table", "name", "kind", "optional",
      "ref_table" AS "refTable", "default_kind" AS "defaultKind", "default_value" AS "defaultValue"
      FROM "patchy"."columns" WHERE "patch_id" = ${patchId} ORDER BY "table", "name"`;
  })
});

const findIndexes = SqlSchema.findAll({
  Request: Schema.String,
  Result: Index,
  execute: Effect.fn("Inventory.findIndexes")(function* (patchId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT "patch_id" AS "patchId", "table", "name", "columns", "unique"
      FROM "patchy"."indexes" WHERE "patch_id" = ${patchId} ORDER BY "table", "name"`;
  })
});

const findStores = SqlSchema.findAll({
  Request: Schema.String,
  Result: Store,
  execute: Effect.fn("Inventory.findStores")(function* (patchId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`SELECT "patch_id" AS "patchId", "name", "description", "shared",
      "resource_revision"::text AS "resourceRevision" FROM "patchy"."stores"
      WHERE "patch_id" = ${patchId} ORDER BY "name"`;
  })
});

const incrementRevision = SqlSchema.findOne({
  Request: Schema.String,
  Result: Schema.Struct({ schemaRevision: Schema.Int }),
  execute: Effect.fn("Inventory.incrementRevision")(function* (patchId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`UPDATE "patchy"."patches" SET "schema_revision" = "schema_revision" + 1
      WHERE "patch_id" = ${patchId} RETURNING "schema_revision" AS "schemaRevision"`;
  })
});

const lockedClient = Effect.fn("Inventory.lockedClient")(function* (patchId: string) {
  const lock = yield* CompanyDatabases.PatchLock;
  if (lock.patchId !== patchId) {
    return yield* Effect.die(new Error("Inventory mutation requires a matching patch lock"));
  }
  return lock.sql;
});

const ensurePatch = Effect.fn("Inventory.ensurePatch")(function* (patchId: string) {
  const sql = yield* lockedClient(patchId);
  yield* sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(namespace(patchId))}`);
  yield* sql`INSERT INTO "patchy"."patches" ("patch_id") VALUES (${patchId})
      ON CONFLICT ("patch_id") DO NOTHING`;
  const patch = yield* findPatch(patchId).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchTags({ SchemaError: Effect.die })
  );
  return yield* Option.match(patch, {
    onNone: () => Effect.die("Inventory patch disappeared during creation"),
    onSome: (row) => Effect.succeed(row.schemaRevision)
  });
});

/** A presence probe does not open a company transaction; publish holds the platform row lock. */
const exists = Effect.fn("Inventory.exists")(function* (patchId: string) {
  const sql = yield* CompanyDatabases.CompanyConnection;
  const rows = yield* sql`SELECT 1 FROM "patchy"."patches" WHERE "patch_id" = ${patchId}`;
  return rows.length > 0;
});

// Readers take the same patch lock as writers so revision and resources cannot
// straddle a provisioning commit across the component queries.
const read = Effect.fn("Inventory.read")(
  function* (patchId: string) {
    const patch = yield* findPatch(patchId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    if (Option.isNone(patch)) return null;
    const tables = yield* findTables(patchId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    const columns = yield* findColumns(patchId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    const indexes = yield* findIndexes(patchId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    const stores = yield* findStores(patchId).pipe(Effect.catchTags({ SchemaError: Effect.die }));
    return new Snapshot({ ...patch.value, tables, columns, indexes, stores });
  },
  (effect, patchId) => CompanyDatabases.withPatchLock(patchId)(effect)
);

const putTable = Effect.fn("Inventory.putTable")(function* (
  row: Omit<Table, "createdAt" | "resourceRevision">
) {
  const sql = yield* lockedClient(row.patchId);
  yield* sql`INSERT INTO "patchy"."tables" ("patch_id", "name", "description", "shared")
      VALUES (${row.patchId}, ${row.name}, ${row.description}, ${row.shared})
      ON CONFLICT ("patch_id", "name") DO UPDATE SET
        "description" = EXCLUDED."description", "shared" = EXCLUDED."shared",
        "resource_revision" = "tables"."resource_revision" + 1`;
  const lock = yield* CompanyDatabases.PatchLock;
  lock.resources.add(`table:${row.patchId}:${row.name}`);
});

const putColumn = Effect.fn("Inventory.putColumn")(function* (row: Column) {
  const sql = yield* lockedClient(row.patchId);
  yield* sql`INSERT INTO "patchy"."columns"
      ("patch_id", "table", "name", "kind", "ref_table", "optional", "default_kind", "default_value")
      VALUES (${row.patchId}, ${row.table}, ${row.name}, ${row.kind}, ${row.refTable}, ${row.optional},
        ${row.defaultKind}, ${encodeDefault(row.defaultValue)}::jsonb)
      ON CONFLICT ("patch_id", "table", "name") DO NOTHING`;
  yield* sql`UPDATE patchy.tables SET resource_revision = resource_revision + 1
    WHERE patch_id = ${row.patchId} AND name = ${row.table}`;
  const lock = yield* CompanyDatabases.PatchLock;
  lock.resources.add(`table:${row.patchId}:${row.table}`);
});

const putIndex = Effect.fn("Inventory.putIndex")(function* (row: Index) {
  const sql = yield* lockedClient(row.patchId);
  yield* sql`INSERT INTO "patchy"."indexes" ("patch_id", "table", "name", "columns", "unique")
      VALUES (${row.patchId}, ${row.table}, ${row.name}, ${encodeColumns(row.columns)}::jsonb, ${row.unique})
      ON CONFLICT ("patch_id", "table", "name") DO NOTHING`;
  yield* sql`UPDATE patchy.tables SET resource_revision = resource_revision + 1
    WHERE patch_id = ${row.patchId} AND name = ${row.table}`;
  const lock = yield* CompanyDatabases.PatchLock;
  lock.resources.add(`table:${row.patchId}:${row.table}`);
});

const putStore = Effect.fn("Inventory.putStore")(function* (row: Omit<Store, "resourceRevision">) {
  const sql = yield* lockedClient(row.patchId);
  yield* sql`INSERT INTO "patchy"."stores" ("patch_id", "name", "description", "shared")
      VALUES (${row.patchId}, ${row.name}, ${row.description}, ${row.shared})
      ON CONFLICT ("patch_id", "name") DO UPDATE SET
        "description" = EXCLUDED."description", "shared" = EXCLUDED."shared",
        "resource_revision" = "stores"."resource_revision" + 1`;
  const lock = yield* CompanyDatabases.PatchLock;
  lock.resources.add(`store:${row.patchId}:${row.name}`);
});

const bumpRevision = Effect.fn("Inventory.bumpRevision")(function* (patchId: string) {
  const sql = yield* lockedClient(patchId);
  const row = yield* incrementRevision(patchId).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchTags({ SchemaError: Effect.die, NoSuchElementError: Effect.die })
  );
  return row.schemaRevision;
});

export const make = Effect.gen(function* () {
  const changes = yield* ResourceChanges.ResourceChanges;
  return Inventory.of({
    ensurePatch,
    exists,
    putTable,
    putColumn,
    putIndex,
    putStore,
    bumpRevision,
    read: (patchId) =>
      read(patchId).pipe(Effect.provideService(ResourceChanges.ResourceChanges, changes))
  });
});

export const layer = Layer.effect(Inventory, make);

/**
 * Idempotent upgrades for retained PostgreSQL and PGlite inventory. Add changes
 * here, not only to CREATE TABLE below; test reinitialization in inventoryContract.
 * Check the catalog first to avoid DDL locks when the current schema needs no work.
 */
export const upgrade = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mutationKeys = yield* sql`SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'patchy' AND table_name = 'mutation_keys'`;
  if (mutationKeys.length === 0) {
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."mutation_keys" (
    "key" text CONSTRAINT mutation_keys_key PRIMARY KEY,
    "issued_at" timestamptz NOT NULL,
    "patch_id" text NOT NULL,
    "version_id" text NOT NULL,
    "handler" text NOT NULL,
    "viewer_id" text NOT NULL,
    "fingerprint" text NOT NULL,
    "invocation_id" text NOT NULL,
    "reply" jsonb NOT NULL
  )`);
    yield* sql.unsafe(
      "CREATE INDEX IF NOT EXISTS mutation_keys_issued_at ON patchy.mutation_keys (issued_at)"
    );
  }
  const present = yield* sql`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'patchy' AND table_name = 'columns' AND column_name = 'ref_table'`;
  if (present.length === 0) {
    yield* sql.unsafe('ALTER TABLE "patchy"."columns" ADD COLUMN IF NOT EXISTS "ref_table" text');
  }
  const storeSharing = yield* sql`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'patchy' AND table_name = 'stores' AND column_name = 'shared'`;
  if (storeSharing.length === 0)
    yield* sql.unsafe(
      'ALTER TABLE "patchy"."stores" ADD COLUMN IF NOT EXISTS "shared" boolean NOT NULL DEFAULT false'
    );
  for (const table of ["tables", "stores"]) {
    const revision = yield* sql`SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'patchy' AND table_name = ${table} AND column_name = 'resource_revision'`;
    if (revision.length === 0)
      yield* sql.unsafe(
        `ALTER TABLE "patchy".${quoteIdentifier(table)} ADD COLUMN IF NOT EXISTS "resource_revision" bigint NOT NULL DEFAULT 0`
      );
  }
});

/** Shared bootstrap for PostgreSQL and PGlite; never submit multiple statements in one call. */
export const initialize = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe('CREATE SCHEMA IF NOT EXISTS "patchy"');
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."patches" (
    "patch_id" text PRIMARY KEY,
    "schema_revision" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now()
  )`);
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."tables" (
    "patch_id" text NOT NULL REFERENCES "patchy"."patches" ("patch_id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "description" text NOT NULL,
    "shared" boolean NOT NULL,
    "resource_revision" bigint NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("patch_id", "name")
  )`);
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."columns" (
    "patch_id" text NOT NULL,
    "table" text NOT NULL,
    "name" text NOT NULL,
    "kind" text NOT NULL CHECK ("kind" IN ('text', 'integer', 'number', 'boolean', 'timestamp', 'json', 'ref')),
    "ref_table" text,
    "optional" boolean NOT NULL,
    "default_kind" text CHECK ("default_kind" IN ('constant', 'now')),
    "default_value" jsonb,
    PRIMARY KEY ("patch_id", "table", "name"),
    FOREIGN KEY ("patch_id", "table") REFERENCES "patchy"."tables" ("patch_id", "name") ON DELETE CASCADE
  )`);
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."indexes" (
    "patch_id" text NOT NULL,
    "table" text NOT NULL,
    "name" text NOT NULL,
    "columns" jsonb NOT NULL,
    "unique" boolean NOT NULL,
    PRIMARY KEY ("patch_id", "table", "name"),
    FOREIGN KEY ("patch_id", "table") REFERENCES "patchy"."tables" ("patch_id", "name") ON DELETE CASCADE
  )`);
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."stores" (
    "patch_id" text NOT NULL REFERENCES "patchy"."patches" ("patch_id") ON DELETE CASCADE,
    "name" text NOT NULL,
    "description" text NOT NULL,
    "shared" boolean NOT NULL DEFAULT false,
    "resource_revision" bigint NOT NULL DEFAULT 0,
    PRIMARY KEY ("patch_id", "name")
  )`);
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."files" (
    "patch_id" text NOT NULL,
    "store" text NOT NULL,
    "name" text NOT NULL,
    "object_id" text NOT NULL,
    "size" bigint NOT NULL CHECK ("size" >= 0),
    "content_type" text NOT NULL,
    "sha256" text NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("patch_id", "store", "name"),
    FOREIGN KEY ("patch_id", "store") REFERENCES "patchy"."stores" ("patch_id", "name") ON DELETE CASCADE
  )`);
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "patchy"."orphan_namespaces" (
    "namespace" text PRIMARY KEY,
    "first_seen_at" timestamptz NOT NULL DEFAULT now()
  )`);
  yield* upgrade;
});
