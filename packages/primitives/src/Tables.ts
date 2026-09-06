/**
 * PROTOTYPE (#176). The tables primitive as a capability service: additive
 * provisioning of a patch's tables from its manifest into a namespace of the
 * company database (here a Postgres schema named by the patch's stable id),
 * and the bounded reads and writes the SDK client speaks.
 *
 * The same service runs on the server over Postgres and in `patchy dev` over
 * PGlite. DDL is emitted one statement per call inside one transaction,
 * because PGlite's driver refuses multi-statement `unsafe` (#177). Values
 * cross the boundary as JSON-safe scalars: timestamps go out as ISO strings
 * and integers as numbers, whichever driver produced them.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ColumnManifest, Manifest, TableManifest } from "@patchy/api";

type Column = typeof ColumnManifest.Type;
type Table = typeof TableManifest.Type;

/** The manifest asks for something publish refuses: a drop, a rename, a retype, a required column with no default. */
export class NotAdditive extends Schema.TaggedError<NotAdditive>()("NotAdditive", {
  errors: Schema.Array(Schema.String)
}) {
  override get message() {
    return `Schema change is not additive:\n- ${this.errors.join("\n- ")}`;
  }
}

/** A row that does not fit the table: unknown column, missing required column, wrong type. */
export class InvalidRow extends Schema.TaggedError<InvalidRow>()("InvalidRow", {
  table: Schema.String,
  errors: Schema.Array(Schema.String)
}) {
  override get message() {
    return `Row does not fit table ${this.table}:\n- ${this.errors.join("\n- ")}`;
  }
}

export interface Provisioned {
  readonly tables: ReadonlyArray<string>;
  readonly columns: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

export type Row = Record<string, unknown>;

export class Tables extends Context.Service<
  Tables,
  {
    /**
     * Brings the namespace from `previous` to `next`: creates the schema,
     * the new tables, the new columns and the file-store index, in one
     * transaction. Refuses before touching anything if the change is not
     * additive. Answers with what it created; nothing on a no-op.
     */
    readonly provision: (input: {
      readonly namespace: string;
      readonly previous: Manifest | null;
      readonly next: Manifest;
    }) => Effect.Effect<Provisioned, NotAdditive | SqlError>;
    readonly insert: (
      namespace: string,
      table: readonly [name: string, shape: Table],
      row: Row
    ) => Effect.Effect<Row, InvalidRow | SqlError>;
    /** Newest first, at most `limit`. */
    readonly list: (
      namespace: string,
      table: readonly [name: string, shape: Table],
      limit: number
    ) => Effect.Effect<ReadonlyArray<Row>, SqlError>;
    readonly get: (
      namespace: string,
      table: readonly [name: string, shape: Table],
      id: string
    ) => Effect.Effect<Option.Option<Row>, SqlError>;
    readonly delete: (
      namespace: string,
      table: readonly [name: string, shape: Table],
      id: string
    ) => Effect.Effect<void, SqlError>;
  }
>()("@patchy/primitives/Tables") {}

/** The namespace a patch's tables live in: its stable id, never its name. */
export const namespaceFor = (patchId: string) => `p_${patchId}`;

/** The index every file store keeps beside its bytes; see `Files`. */
export const FILES_INDEX = "_files";

// --- DDL ---------------------------------------------------------------------

const sqlType: Record<Column["kind"], string> = {
  text: "TEXT",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  timestamp: "TIMESTAMPTZ",
  json: "JSONB"
};

const q = (name: string) => `"${name}"`;
const qualified = (namespace: string, table: string) => `${q(namespace)}.${q(table)}`;

const defaultClause = (column: Column) => {
  if (column.default === undefined) return "";
  if (column.default === "now" && column.kind === "timestamp") return " DEFAULT now()";
  if (typeof column.default === "string") return ` DEFAULT '${column.default.replace(/'/g, "''")}'`;
  return ` DEFAULT ${String(column.default)}`;
};

const columnDdl = (name: string, column: Column) =>
  `${q(name)} ${sqlType[column.kind]}${column.optional ? "" : " NOT NULL"}${defaultClause(column)}`;

const createTable = (namespace: string, name: string, table: Table) =>
  `CREATE TABLE ${qualified(namespace, name)} (` +
  [
    `"id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text`,
    `"_created_at" TIMESTAMPTZ NOT NULL DEFAULT now()`,
    ...Object.entries(table.columns).map(([columnName, column]) => columnDdl(columnName, column))
  ].join(", ") +
  ")";

const createFilesIndex = (namespace: string) =>
  `CREATE TABLE IF NOT EXISTS ${qualified(namespace, FILES_INDEX)} (` +
  `"store" TEXT NOT NULL, "name" TEXT NOT NULL, "size" INTEGER NOT NULL, ` +
  `"content_type" TEXT NOT NULL, "object_key" TEXT NOT NULL, ` +
  `"created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY ("store", "name"))`;

/**
 * The additive diff: what `next` adds over `previous`, and every way it
 * takes something away. Renames look like a drop plus an add, and are
 * refused as the drop.
 */
const diff = (previous: Manifest | null, next: Manifest) => {
  const errors: Array<string> = [];
  const newTables: Array<[string, Table]> = [];
  const newColumns: Array<[table: string, column: string, shape: Column]> = [];
  const newFiles: Array<string> = [];
  const before: Pick<Manifest, "tables" | "files"> = previous ?? { tables: {}, files: {} };

  for (const [name, table] of Object.entries(next.tables)) {
    const old = before.tables[name];
    if (old === undefined) {
      newTables.push([name, table]);
      continue;
    }
    for (const [columnName, column] of Object.entries(table.columns)) {
      const oldColumn = old.columns[columnName];
      if (oldColumn === undefined) {
        if (!column.optional) {
          errors.push(
            `${name}.${columnName} is new and required; existing rows have no value for it. Make it optional or give it a default.`
          );
        }
        newColumns.push([name, columnName, column]);
      } else if (oldColumn.kind !== column.kind) {
        errors.push(`${name}.${columnName} changed type ${oldColumn.kind} → ${column.kind}.`);
      } else if (oldColumn.optional && !column.optional) {
        errors.push(`${name}.${columnName} became required.`);
      }
    }
    for (const columnName of Object.keys(old.columns)) {
      if (!(columnName in table.columns)) {
        errors.push(
          `${name}.${columnName} was dropped. Columns are never dropped; leave it in place.`
        );
      }
    }
  }
  for (const name of Object.keys(before.tables)) {
    if (!(name in next.tables)) errors.push(`Table ${name} was dropped. Tables are never dropped.`);
  }
  for (const name of Object.keys(next.files)) if (!(name in before.files)) newFiles.push(name);
  for (const name of Object.keys(before.files)) {
    if (!(name in next.files))
      errors.push(`File store ${name} was dropped. Stores are never dropped.`);
  }
  return { errors, newTables, newColumns, newFiles };
};

// --- rows ----------------------------------------------------------------------

const fits = (kind: Column["kind"], value: unknown) =>
  kind === "text"
    ? typeof value === "string"
    : kind === "integer"
      ? Number.isInteger(value)
      : kind === "boolean"
        ? typeof value === "boolean"
        : kind === "timestamp"
          ? typeof value === "string" && !Number.isNaN(Date.parse(value))
          : true;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Checks a row against the table and answers the columns and parameters an insert needs. */
const checkInsert = (name: string, table: Table, row: Row) =>
  Effect.gen(function* () {
    const errors: Array<string> = [];
    const columns: Array<string> = [];
    const values: Array<unknown> = [];
    for (const key of Object.keys(row)) {
      if (!(key in table.columns)) errors.push(`Unknown column ${key}.`);
    }
    for (const [columnName, column] of Object.entries(table.columns)) {
      const value = row[columnName];
      if (value === undefined || value === null) {
        if (!column.optional) errors.push(`Missing required column ${columnName}.`);
        continue;
      }
      if (!fits(column.kind, value)) errors.push(`${columnName} must be ${column.kind}.`);
      columns.push(columnName);
      values.push(column.kind === "json" ? encodeJson(value) : value);
    }
    if (errors.length > 0) return yield* new InvalidRow({ table: name, errors });
    return { columns, values };
  });

/** One driver hands back Dates, another strings or numbers; the wire gets ISO strings and JSON values. */
const normalise = (table: Table, raw: Row): Row => {
  const row: Row = { id: raw["id"] };
  for (const [columnName, column] of Object.entries(table.columns)) {
    const value = raw[columnName];
    row[columnName] =
      value === null || value === undefined
        ? null
        : column.kind === "timestamp"
          ? DateTime.formatIso(DateTime.makeUnsafe(value instanceof Date ? value : String(value)))
          : column.kind === "integer"
            ? Number(value)
            : column.kind === "json" && typeof value === "string"
              ? decodeJson(value)
              : value;
  }
  return row;
};

const selectList = (table: Table) => ["id", ...Object.keys(table.columns)].map(q).join(", ");

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const run = (statement: string, params?: ReadonlyArray<unknown>) =>
    sql.unsafe<Row>(statement, params);

  const provision = Effect.fn("Tables.provision")(function* (input: {
    readonly namespace: string;
    readonly previous: Manifest | null;
    readonly next: Manifest;
  }) {
    const { errors, newTables, newColumns, newFiles } = diff(input.previous, input.next);
    if (errors.length > 0) return yield* new NotAdditive({ errors });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* run(`CREATE SCHEMA IF NOT EXISTS ${q(input.namespace)}`);
        yield* run(createFilesIndex(input.namespace));
        for (const [name, table] of newTables)
          yield* run(createTable(input.namespace, name, table));
        for (const [table, column, shape] of newColumns) {
          yield* run(
            `ALTER TABLE ${qualified(input.namespace, table)} ADD COLUMN ${columnDdl(column, shape)}`
          );
        }
      })
    );
    return {
      tables: newTables.map(([name]) => name),
      columns: newColumns.map(([table, column]) => `${table}.${column}`),
      files: newFiles
    } satisfies Provisioned;
  });

  const insert = Effect.fn("Tables.insert")(function* (
    namespace: string,
    [name, table]: readonly [string, Table],
    row: Row
  ) {
    const { columns, values } = yield* checkInsert(name, table, row);
    const placeholders = values.map((_, index) => `$${index + 1}`);
    const rows = yield* run(
      columns.length === 0
        ? `INSERT INTO ${qualified(namespace, name)} DEFAULT VALUES RETURNING ${selectList(table)}`
        : `INSERT INTO ${qualified(namespace, name)} (${columns.map(q).join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING ${selectList(table)}`,
      values
    );
    return normalise(table, rows[0] ?? {});
  });

  const list = Effect.fn("Tables.list")(function* (
    namespace: string,
    [name, table]: readonly [string, Table],
    limit: number
  ) {
    const rows = yield* run(
      `SELECT ${selectList(table)} FROM ${qualified(namespace, name)} ORDER BY "_created_at" DESC, "id" DESC LIMIT $1`,
      [Math.min(Math.max(1, Math.trunc(limit)), 1000)]
    );
    return rows.map((row) => normalise(table, row));
  });

  const get = Effect.fn("Tables.get")(function* (
    namespace: string,
    [name, table]: readonly [string, Table],
    id: string
  ) {
    const rows = yield* run(
      `SELECT ${selectList(table)} FROM ${qualified(namespace, name)} WHERE "id" = $1`,
      [id]
    );
    return Option.map(Option.fromNullishOr(rows[0]), (row) => normalise(table, row));
  });

  const remove = Effect.fn("Tables.delete")(function* (
    namespace: string,
    [name]: readonly [string, Table],
    id: string
  ) {
    yield* run(`DELETE FROM ${qualified(namespace, name)} WHERE "id" = $1`, [id]);
  });

  return Tables.of({ provision, insert, list, get, delete: remove });
});

/** Over any `SqlClient`: Postgres on the server, PGlite in dev. */
export const layer = Layer.effect(Tables, make);
