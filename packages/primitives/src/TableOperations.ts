import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DefinitionName,
  IsoTimestamp,
  PostgresJson,
  PostgresText,
  runtimeOperations,
  type ColumnDefinition,
  type TableDefinition,
  type TableList,
  TableRow
} from "@patchy/api";
import { CompanyDatabases, Inventory } from "@patchy/company-database";
import { Binding, Runtime } from "@patchy/runtime";
import { boundedRows } from "./bounded-rows.js";

export class TableNotDeclared extends Schema.TaggedError<TableNotDeclared>()("TableNotDeclared", {
  table: Schema.String
}) {
  readonly code = "table_not_declared" as const;
  readonly status = 400;
  override get message() {
    return `Table ${this.table} is not declared by this version.`;
  }
}
export class InvalidRow extends Schema.TaggedError<InvalidRow>()("InvalidRow", {
  table: Schema.String,
  column: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
  problem: Schema.Literals([
    "unknown column",
    "system column",
    "missing required value",
    "invalid value"
  ])
}) {
  readonly code = "invalid_row" as const;
  readonly status = 400;
  override get message() {
    return `Invalid row for ${this.table}${this.column === undefined ? "" : `.${this.column}`}: ${this.problem}.`;
  }
}
export class RowNotFound extends Schema.TaggedError<RowNotFound>()("RowNotFound", {
  table: Schema.String
}) {
  readonly code = "row_not_found" as const;
  readonly status = 404;
  override get message() {
    return `Row not found in ${this.table}.`;
  }
}
export class UniqueViolation extends Schema.TaggedError<UniqueViolation>()("UniqueViolation", {
  table: Schema.String,
  cause: Schema.Defect()
}) {
  readonly code = "unique_violation" as const;
  readonly status = 409;
  override get message() {
    return `A unique index on ${this.table} refuses this write.`;
  }
}
export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("InvalidCursor", {
  table: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {
  readonly code = "invalid_cursor" as const;
  readonly status = 400;
  override get message() {
    return `Invalid cursor for ${this.table}; use a cursor from the same table, index, order and filters.`;
  }
}
export class ItemLimit extends Schema.TaggedError<ItemLimit>()("ItemLimit", {
  maxItems: Schema.Int
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return `Table operation exceeds ${this.maxItems} items.`;
  }
}
export class IndexKeyTooLarge extends Schema.TaggedError<IndexKeyTooLarge>()("IndexKeyTooLarge", {
  table: Schema.String,
  cause: Schema.Defect()
}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return `An index key on ${this.table} exceeds the database's B-tree entry size limit.`;
  }
}
export class Busy extends Schema.TaggedError<Busy>()("TableBusy", {
  limit: Schema.Int,
  cause: Schema.Defect()
}) {
  readonly code = "busy" as const;
  readonly status = 503;
  override get message() {
    return `Company database capacity (${this.limit}) is exhausted. Try again shortly.`;
  }
}

export const config = Config.all({
  rowBytes: Config.int("PATCHY_RUNTIME_ROW_BYTES").pipe(Config.withDefault(1024 * 1024)),
  batchBytes: Config.int("PATCHY_RUNTIME_BATCH_BYTES").pipe(Config.withDefault(8 * 1024 * 1024)),
  resultBytes: Config.int("PATCHY_RUNTIME_RESULT_BYTES").pipe(Config.withDefault(8 * 1024 * 1024)),
  maxItems: Config.int("PATCHY_TABLE_MAX_ITEMS").pipe(Config.withDefault(1000)),
  defaultPage: Config.int("PATCHY_TABLE_DEFAULT_PAGE").pipe(Config.withDefault(100)),
  maxPage: Config.int("PATCHY_TABLE_MAX_PAGE").pipe(Config.withDefault(1000))
});
type Row = typeof TableRow.Type;
type Column = typeof ColumnDefinition.Type;
type Table = typeof TableDefinition.Type;
type List = typeof TableList.Type;
const isDefinitionName = Schema.is(DefinitionName);
const system = ["id", "createdAt", "updatedAt"];
const isText = Schema.is(PostgresText);
const isNumber = Schema.is(Schema.Number.check(Schema.isFinite()));
const isInteger = Schema.is(
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(-2147483648),
    Schema.isLessThanOrEqualTo(2147483647)
  )
);
const isBoolean = Schema.is(Schema.Boolean);
const isJson = Schema.is(PostgresJson);
const isTimestamp = Schema.is(IsoTimestamp);
const decodeRows = Schema.decodeUnknownSync(Schema.Array(TableRow));
const queryRows = (sql: SqlClient.SqlClient, query: string, values: ReadonlyArray<unknown>) =>
  sql.unsafe(query, values).pipe(Effect.map(decodeRows));
const cursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  binding: Schema.String,
  values: Schema.Array(Schema.Json)
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(cursorSchema), {
  onExcessProperty: "error"
});
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(cursorSchema));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const validValue = (column: Column, value: unknown): boolean => {
  if (value === null) return column.optional === true && !Object.hasOwn(column, "default");
  switch (column.kind) {
    case "integer":
      return isInteger(value);
    case "number":
      return isNumber(value);
    case "boolean":
      return isBoolean(value);
    case "timestamp":
      return isTimestamp(value);
    case "json":
      return isJson(value);
    case "text":
    case "ref":
      return isText(value);
  }
};
const columnAt = (table: Table, name: string): Column | undefined =>
  name === "id"
    ? { kind: "text" }
    : name === "createdAt" || name === "updatedAt"
      ? { kind: "timestamp" }
      : Object.hasOwn(table.columns, name)
        ? table.columns[name]
        : undefined;
// Preserve microseconds in cursors; a driver Date would truncate PostgreSQL's ordering key.
const projection = (table: Table) =>
  [...system, ...Object.keys(table.columns)]
    .map((name) =>
      columnAt(table, name)!.kind === "timestamp"
        ? `to_char(${Inventory.quoteIdentifier(name)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${Inventory.quoteIdentifier(name)}`
        : Inventory.quoteIdentifier(name)
    )
    .join(", ");
const dbValue = (column: Column, value: unknown) =>
  column.kind === "json" && value !== null ? encodeJson(value) : value;
const parameter = (column: Column, index: number) =>
  `$${index}${column.kind === "json" ? "::jsonb" : ""}`;
const isNativeIndexLimit = Schema.is(Schema.Struct({ code: Schema.Literal("54000") }));
const isNativeCheck = Schema.is(Schema.Struct({ code: Schema.Literal("23514") }));
const sqlFailure = (table: string, cause: SqlError): Runtime.RuntimeError => {
  const native = cause.reason.cause;
  if (isNativeIndexLimit(native)) return new IndexKeyTooLarge({ table, cause });
  if (isNativeCheck(native)) return new InvalidRow({ table, problem: "invalid value", cause });
  return cause.reason._tag === "UniqueViolation"
    ? new UniqueViolation({ table, cause })
    : new Runtime.SourceUnavailable({ cause });
};
const jsonBytes = (value: unknown) => Buffer.byteLength(encodeJson(value), "utf8");
const byteLimit = Effect.fn("TableOperations.byteLimit")(function* (
  value: unknown,
  maxBytes: number
) {
  if (jsonBytes(value) > maxBytes) return yield* new Runtime.TooLarge({ maxBytes });
});
const validateRow = Effect.fn("TableOperations.validateRow")(function* (
  name: string,
  table: Table,
  row: Row,
  insert: boolean
) {
  for (const key of Object.keys(row)) {
    if (system.includes(key))
      return yield* new InvalidRow({ table: name, column: key, problem: "system column" });
    if (!Object.hasOwn(table.columns, key))
      return yield* new InvalidRow({ table: name, column: key, problem: "unknown column" });
    if (!validValue(table.columns[key]!, row[key]))
      return yield* new InvalidRow({ table: name, column: key, problem: "invalid value" });
  }
  if (insert)
    for (const [key, column] of Object.entries(table.columns)) {
      if (
        !Object.hasOwn(row, key) &&
        column.optional !== true &&
        !Object.hasOwn(column, "default")
      ) {
        return yield* new InvalidRow({
          table: name,
          column: key,
          problem: "missing required value"
        });
      }
    }
});
const newId = Effect.map(Clock.currentTimeMillis, (milliseconds) => {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(milliseconds, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});
const resource: Runtime.Handler["resource"] = (args) =>
  typeof args === "object" && args !== null && "table" in args && isDefinitionName(args.table)
    ? args.table
    : null;

export const make = Effect.gen(function* () {
  const databases = yield* CompanyDatabases.CompanyDatabases;
  const settings = yield* config;
  const withTable = <A>(
    name: string,
    run: (
      sql: SqlClient.SqlClient,
      table: Table,
      qualified: string,
      patchId: string
    ) => Effect.Effect<A, Runtime.RuntimeError | SqlError>
  ) =>
    Effect.gen(function* () {
      const binding = yield* Binding.Binding;
      if (!Object.hasOwn(binding.manifest.tables, name))
        return yield* new TableNotDeclared({ table: name });
      const table = binding.manifest.tables[name]!;
      return yield* databases
        .withCompany(binding.companyId)(
          Effect.gen(function* () {
            const sql = yield* CompanyDatabases.CompanyConnection;
            return yield* run(
              sql,
              table,
              `${Inventory.quoteIdentifier(Inventory.namespace(binding.patchId))}.${Inventory.quoteIdentifier(name)}`,
              binding.patchId
            ).pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(sqlFailure(name, cause)) }));
          })
        )
        .pipe(
          Effect.catchTags({
            Busy: (cause) => Effect.fail(new Busy({ limit: cause.limit, cause })),
            CompanyDatabaseError: (cause) => Effect.fail(new Runtime.SourceUnavailable({ cause })),
            CompanyDatabaseNotReady: (cause) =>
              Effect.fail(new Runtime.SourceUnavailable({ cause })),
            CompanyIdentityMismatch: (cause) =>
              Effect.fail(new Runtime.SourceUnavailable({ cause }))
          })
        );
    });
  const insert = Effect.fn("TableOperations.insertRow")(function* (
    sql: SqlClient.SqlClient,
    table: Table,
    qualified: string,
    row: Row
  ) {
    const keys = Object.keys(row);
    const values: unknown[] = [
      yield* newId,
      ...keys.map((key) => dbValue(table.columns[key]!, row[key]))
    ];
    const columns = [Inventory.quoteIdentifier("id"), ...keys.map(Inventory.quoteIdentifier)];
    const params = ["$1", ...keys.map((key, index) => parameter(table.columns[key]!, index + 2))];
    const rows = yield* queryRows(
      sql,
      `INSERT INTO ${qualified} AS stored (${columns.join(", ")}) VALUES (${params.join(", ")}) RETURNING ${projection(table)}, to_jsonb(stored) AS "__storedRow"`,
      values
    );
    const { __storedRow, ...result } = rows[0]!;
    yield* byteLimit(__storedRow, settings.rowBytes);
    return result;
  });
  const get = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["tables.get"].request.fields.args,
      output: runtimeOperations["tables.get"].response
    },
    (args) =>
      withTable(args.table, (sql, table, qualified) =>
        Effect.map(
          queryRows(sql, `SELECT ${projection(table)} FROM ${qualified} WHERE "id" = $1`, [
            args.id
          ]),
          (rows) => rows[0] ?? null
        )
      )
  );
  const getMany = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["tables.getMany"].request.fields.args,
      output: runtimeOperations["tables.getMany"].response
    },
    (args) =>
      withTable(args.table, (sql, table, qualified) =>
        Effect.gen(function* () {
          if (args.ids.length > settings.maxItems)
            return yield* new ItemLimit({ maxItems: settings.maxItems });
          yield* byteLimit(args.ids, settings.batchBytes);
          if (args.ids.length === 0) return [];
          const { rows } = yield* boundedRows(
            sql,
            `SELECT ${projection(table)}, row_number() OVER (ORDER BY stored."id") AS "__position" FROM ${qualified} AS stored WHERE stored."id" IN (${args.ids.map((_, index) => `$${index + 1}`).join(", ")})`,
            args.ids,
            settings.maxItems,
            settings.resultBytes
          );
          const byId = new Map(rows.map((row) => [row.id, { row, bytes: jsonBytes(row) }]));
          const result: Array<Row | null> = [];
          let bytes = 2;
          for (const id of args.ids) {
            const found = byId.get(id);
            bytes += (result.length === 0 ? 0 : 1) + (found?.bytes ?? 4);
            if (bytes > settings.resultBytes)
              return yield* new Runtime.TooLarge({ maxBytes: settings.resultBytes });
            result.push(found?.row ?? null);
          }
          return result;
        })
      )
  );
  const insertOne = Runtime.handler(
    {
      kind: "mutation",
      input: runtimeOperations["tables.insert"].request.fields.args,
      output: runtimeOperations["tables.insert"].response,
      resource,
      rowCount: () => 1
    },
    (args) =>
      withTable(args.table, (sql, table, qualified) =>
        Effect.gen(function* () {
          yield* byteLimit(args.row, settings.rowBytes);
          yield* validateRow(args.table, table, args.row, true);
          return yield* sql.withTransaction(insert(sql, table, qualified, args.row));
        })
      )
  );
  const insertMany = Runtime.handler(
    {
      kind: "mutation",
      input: runtimeOperations["tables.insertMany"].request.fields.args,
      output: runtimeOperations["tables.insertMany"].response,
      resource,
      rowCount: (value) => (Array.isArray(value) ? value.length : null)
    },
    (args) =>
      withTable(args.table, (sql, table, qualified) =>
        Effect.gen(function* () {
          if (args.rows.length > settings.maxItems)
            return yield* new ItemLimit({ maxItems: settings.maxItems });
          yield* byteLimit(args.rows, settings.batchBytes);
          for (const row of args.rows) {
            yield* byteLimit(row, settings.rowBytes);
            yield* validateRow(args.table, table, row, true);
          }
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const result: Row[] = [];
              let bytes = 2;
              for (const row of args.rows) {
                const inserted = yield* insert(sql, table, qualified, row);
                bytes += (result.length === 0 ? 0 : 1) + jsonBytes(inserted);
                if (bytes > settings.resultBytes)
                  return yield* new Runtime.TooLarge({ maxBytes: settings.resultBytes });
                result.push(inserted);
              }
              return result;
            })
          );
        })
      )
  );
  const update = Runtime.handler(
    {
      kind: "mutation",
      input: runtimeOperations["tables.update"].request.fields.args,
      output: runtimeOperations["tables.update"].response,
      resource,
      rowCount: () => 1
    },
    (args) =>
      withTable(args.table, (sql, table, qualified) =>
        Effect.gen(function* () {
          yield* byteLimit(args.patch, settings.rowBytes);
          yield* validateRow(args.table, table, args.patch, false);
          const keys = Object.keys(args.patch);
          const values = keys.map((key) => dbValue(table.columns[key]!, args.patch[key]));
          const assignments =
            keys.length === 0
              ? '"id" = "id"'
              : keys
                  .map(
                    (key, index) =>
                      `${Inventory.quoteIdentifier(key)} = ${parameter(table.columns[key]!, index + 1)}`
                  )
                  .join(", ");
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const rows = yield* queryRows(
                sql,
                `UPDATE ${qualified} AS stored SET ${assignments} WHERE "id" = $${values.length + 1} RETURNING ${projection(table)}, to_jsonb(stored) AS "__storedRow"`,
                [...values, args.id]
              );
              if (rows.length === 0) return yield* new RowNotFound({ table: args.table });
              const { __storedRow, ...result } = rows[0]!;
              yield* byteLimit(__storedRow, settings.rowBytes);
              return result;
            })
          );
        })
      )
  );
  const remove = Runtime.handler(
    {
      kind: "mutation",
      input: runtimeOperations["tables.delete"].request.fields.args,
      output: runtimeOperations["tables.delete"].response,
      resource
    },
    (args) =>
      withTable(args.table, (sql, _table, qualified) =>
        Effect.as(sql.unsafe(`DELETE FROM ${qualified} WHERE "id" = $1`, [args.id]), null)
      )
  );
  const list = Runtime.handler(
    {
      kind: "read",
      input: runtimeOperations["tables.list"].request.fields.args,
      output: runtimeOperations["tables.list"].response
    },
    (args) =>
      withTable(args.table, (sql, table, qualified, patchId) =>
        Effect.gen(function* () {
          const limit = args.limit ?? settings.defaultPage;
          if (limit > settings.maxPage) return yield* new ItemLimit({ maxItems: settings.maxPage });
          const indexName = args.index ?? "createdAt";
          const declared =
            args.index !== undefined && Object.hasOwn(table.indexes, indexName)
              ? table.indexes[indexName]
              : undefined;
          const ref =
            Object.hasOwn(table.columns, indexName) && table.columns[indexName]!.kind === "ref";
          const index =
            args.index === undefined
              ? ["createdAt", "id"]
              : (declared?.columns ??
                (indexName === "createdAt" ? ["createdAt", "id"] : ref ? [indexName] : undefined));
          if (index === undefined) return yield* new Runtime.InvalidRequest({});
          const columns = [...new Set([...index, "id"])];
          const order =
            args.order ??
            (args.index === undefined || (indexName === "createdAt" && declared === undefined)
              ? "desc"
              : "asc");
          const eq = args.eq ?? {};
          const leading = Object.keys(eq).length;
          if (
            leading > index.length ||
            Object.keys(eq).some((key) => !index.slice(0, leading).includes(key))
          )
            return yield* new Runtime.InvalidRequest({});
          const values: unknown[] = [];
          const conditions: string[] = [];
          const storageColumn = (column: string) => `stored.${Inventory.quoteIdentifier(column)}`;
          const add = (column: string, value: unknown) => {
            const definition = columnAt(table, column)!;
            values.push(dbValue(definition, value));
            return parameter(definition, values.length);
          };
          for (const key of index.slice(0, leading)) {
            if (!validValue(columnAt(table, key)!, eq[key]))
              return yield* new Runtime.InvalidRequest({});
            conditions.push(
              eq[key] === null
                ? `${storageColumn(key)} IS NULL`
                : `${storageColumn(key)} = ${add(key, eq[key])}`
            );
          }
          if (args.range !== undefined) {
            const range = args.range;
            if (
              range.column !== index[leading] ||
              (range.gt !== undefined && range.gte !== undefined) ||
              (range.lt !== undefined && range.lte !== undefined)
            )
              return yield* new Runtime.InvalidRequest({});
            const bounds = ["gt", "gte", "lt", "lte"] as const;
            const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" };
            if (!bounds.some((bound) => Object.hasOwn(range, bound)))
              return yield* new Runtime.InvalidRequest({});
            for (const bound of bounds)
              if (Object.hasOwn(range, bound)) {
                const value = range[bound];
                if (value === null || !validValue(columnAt(table, range.column)!, value))
                  return yield* new Runtime.InvalidRequest({});
                conditions.push(
                  `${storageColumn(range.column)} ${operators[bound]} ${add(range.column, value)}`
                );
              }
          }
          // Only canonical, validated selectors are persisted; never raw operation arguments.
          const binding = encodeJson([
            patchId,
            args.table,
            indexName,
            columns,
            order,
            index.slice(0, leading).map((key) => [key, eq[key]]),
            args.range === undefined
              ? null
              : [
                  args.range.column,
                  ...["gt", "gte", "lt", "lte"].map(
                    (key) => args.range![key as keyof NonNullable<List["range"]>] ?? null
                  )
                ]
          ]);
          if (args.cursor !== undefined) {
            if (!/^[A-Za-z0-9_-]+$/.test(args.cursor))
              return yield* new InvalidCursor({ table: args.table });
            const decoded = yield* decodeCursor(
              Buffer.from(args.cursor, "base64url").toString("utf8")
            ).pipe(Effect.mapError((cause) => new InvalidCursor({ table: args.table, cause })));
            if (
              decoded.binding !== binding ||
              decoded.values.length !== columns.length ||
              decoded.values.some(
                (value, index) => !validValue(columnAt(table, columns[index]!)!, value)
              )
            )
              return yield* new InvalidCursor({ table: args.table });
            // Nullable keys stay NULLS LAST in either direction.
            const branches: string[] = [];
            const equal: string[] = [];
            columns.forEach((column, index) => {
              const value = decoded.values[index];
              const identifier = storageColumn(column);
              if (value !== null) {
                const param = add(column, value);
                branches.push(
                  `(${[...equal, `(${identifier} ${order === "asc" ? ">" : "<"} ${param}${validValue(columnAt(table, column)!, null) ? ` OR ${identifier} IS NULL` : ""})`].join(" AND ")})`
                );
                equal.push(`${identifier} = ${param}`);
              } else equal.push(`${identifier} IS NULL`);
            });
            conditions.push(`(${branches.length === 0 ? "FALSE" : branches.join(" OR ")})`);
          }
          values.push(limit + 1);
          const ordering = columns
            .map(
              (column) =>
                `${storageColumn(column)} ${order.toUpperCase()}${validValue(columnAt(table, column)!, null) ? " NULLS LAST" : ""}`
            )
            .join(", ");
          const { rows: page, hasMore } = yield* boundedRows(
            sql,
            `SELECT ${projection(table)}, row_number() OVER (ORDER BY ${ordering}) AS "__position" FROM (SELECT * FROM ${qualified} AS stored${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`} ORDER BY ${ordering} LIMIT $${values.length}) AS stored`,
            values,
            limit,
            settings.resultBytes
          );
          const last = page[page.length - 1];
          const cursor =
            hasMore && last !== undefined
              ? Buffer.from(
                  encodeCursor({
                    version: 1,
                    binding,
                    values: columns.map((column) => last[column]!)
                  })
                ).toString("base64url")
              : null;
          const result = { rows: page, cursor };
          yield* byteLimit(result, settings.resultBytes);
          return result;
        })
      )
  );
  return {
    "tables.get": get,
    "tables.getMany": getMany,
    "tables.list": list,
    "tables.insert": insertOne,
    "tables.insertMany": insertMany,
    "tables.update": update,
    "tables.delete": remove
  } satisfies Readonly<Record<string, Runtime.Handler>>;
});
