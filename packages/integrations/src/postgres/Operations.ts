import { Buffer } from "node:buffer";
import {
  PostgresGet,
  PostgresGetMany,
  PostgresKeyRows,
  PostgresList,
  PostgresPage,
  PostgresParameter,
  PostgresQuery,
  PostgresRelation,
  PostgresRows
} from "@patchy/api";
import type { PostgresDeclaration } from "@patchy/api";
import { Binding, Runtime } from "@patchy/runtime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ConnectionStore from "../ConnectionStore.js";
import { operation } from "../definition.js";
import * as Execution from "./Execution.js";
import {
  acceptedSourceTypes,
  normalizeTimestamp,
  queryTypeCompatible,
  quoteIdentifier,
  surface,
  typeMapping
} from "./Mapping.js";
import type { Column, Relation, Snapshot } from "./Snapshot.js";

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "PostgresConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This Postgres connection is not declared by this version.";
  }
}

export class RelationUnknown extends Schema.TaggedError<RelationUnknown>()(
  "PostgresRelationUnknown",
  { relation: PostgresRelation }
) {
  readonly code = "relation_unknown" as const;
  readonly status = 400;
  override get message() {
    return "This relation or keyed operation is not available in this version's Postgres snapshot.";
  }
  get details() {
    return { relation: this.relation };
  }
}

export class ShapeMismatch extends Schema.TaggedError<ShapeMismatch>()("PostgresShapeMismatch", {
  column: Schema.String,
  reason: Schema.Literals(["missing", "duplicate", "type", "null", "value", "row_width"])
}) {
  readonly code = "shape_mismatch" as const;
  readonly status = 400;
  override get message() {
    return `The Postgres result does not match the declared shape (${this.reason}).`;
  }
  get details() {
    return { column: this.column, reason: this.reason };
  }
}

export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()(
  "PostgresInvalidCursor",
  {}
) {
  readonly code = "invalid_cursor" as const;
  readonly status = 400;
  override get message() {
    return "This cursor does not match the Postgres relation, revision, filters or order.";
  }
}

export class OffsetExhausted extends Schema.TaggedError<OffsetExhausted>()(
  "PostgresOffsetExhausted",
  {}
) {
  readonly code = "offset_exhausted" as const;
  readonly status = 400;
  override get message() {
    return "An unkeyed Postgres relation can page through at most 10000 rows.";
  }
  get details() {
    return { maxOffset: 10_000 };
  }
}

export class ItemLimit extends Schema.TaggedError<ItemLimit>()("PostgresItemLimit", {}) {
  readonly code = "too_large" as const;
  readonly status = 413;
  override get message() {
    return "A Postgres list or getMany call admits at most 1000 rows.";
  }
  get details() {
    return { maxRows: 1_000 };
  }
}

export class SourceSchemaChanged extends Schema.TaggedError<SourceSchemaChanged>()(
  "PostgresSourceSchemaChanged",
  {
    relation: PostgresRelation,
    cause: Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true })
  }
) {
  readonly code = "shape_mismatch" as const;
  readonly status = 400;
  override get message() {
    return "The source schema changed: its column types no longer match this version's pinned Postgres snapshot.";
  }
  get details() {
    return { relation: this.relation, reason: "source_schema_changed" };
  }
}

export const Errors = Schema.Union([
  Execution.Errors,
  ConnectionNotDeclared,
  RelationUnknown,
  ShapeMismatch,
  InvalidCursor,
  OffsetExhausted,
  ItemLimit,
  SourceSchemaChanged,
  Runtime.InvalidRequest,
  Runtime.AccessDenied,
  Runtime.SourceUnavailable,
  Runtime.TooLarge
]);

const MAX_ROWS = 1_000;
const MAX_BYTES = 8 * 1024 * 1024;
const SCHEMA_DRIFT = "Patchy source schema drift";
const MAX_OFFSET = 10_000;
type Row = Record<string, typeof Schema.Json.Type>;
type Parameter = typeof PostgresParameter.Type;
type Resolved = {
  readonly binding: Binding.Binding["Service"];
  readonly declaration: typeof PostgresDeclaration.Type;
};
type BoundRelation = Resolved & {
  readonly relation: typeof Relation.Type;
  readonly snapshot: typeof Snapshot.Type;
};
const Scalar = Schema.Union([
  Schema.String,
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  Schema.Null
]);
const Cursor = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("keyset"),
    binding: Schema.String,
    values: Schema.Array(Scalar)
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("offset"),
    binding: Schema.String,
    offset: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(MAX_OFFSET)
    )
  })
]);
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor), {
  onExcessProperty: "error"
});
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const isJson = Schema.is(Schema.Json);
const isRelation = Schema.is(PostgresRelation);
const isScalar = Schema.is(Scalar);
const stored = (name: string) => `stored.${quoteIdentifier(name)}`;
const validValue = (column: typeof Column.Type, value: unknown) =>
  value === null ? column.nullable : typeMapping(column.type)?.is(value) === true;
const checkedBytes = Effect.fn("PostgresOperations.checkedBytes")(function* <
  A extends typeof Schema.Json.Type
>(value: A) {
  if (Buffer.byteLength(encodeJson(value), "utf8") > MAX_BYTES)
    return yield* new Runtime.TooLarge({ maxBytes: MAX_BYTES });
  return value;
});

const resolve = Effect.fn("PostgresOperations.resolve")(function* (alias: string) {
  const binding = yield* Binding.Binding;
  const declaration = binding.manifest.uses[alias];
  if (!Object.hasOwn(binding.manifest.uses, alias) || declaration?.kind !== "postgres")
    return yield* new ConnectionNotDeclared({});
  if (
    binding.scope !== "company" ||
    binding.identity === null ||
    binding.principal === null ||
    binding.identity.company.id !== binding.companyId ||
    binding.identity.user.id !== binding.principal.userId
  )
    return yield* new Runtime.AccessDenied({});
  const connections = yield* ConnectionStore.ConnectionStore;
  const connection = yield* connections
    .get(binding.companyId, declaration.id)
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ConnectionNotFound"
          ? new Runtime.AccessDenied({ cause })
          : new Runtime.SourceUnavailable({ cause })
      )
    );
  if (
    connection.companyId !== binding.companyId ||
    connection.id !== declaration.id ||
    connection.integration !== "postgres" ||
    connection.mode !== "company" ||
    connection.handle !== declaration.handle ||
    connection.status !== "connected"
  )
    return yield* new Runtime.AccessDenied({});
  return { binding, declaration };
});

const resolveRelation = Effect.fn("PostgresOperations.resolveRelation")(function* (
  alias: string,
  requested: typeof PostgresRelation.Type,
  keyed: boolean
) {
  const resolved = yield* resolve(alias);
  const connections = yield* ConnectionStore.ConnectionStore;
  const snapshot = yield* connections
    .snapshot(resolved.binding.companyId, resolved.declaration.id, resolved.declaration.revision)
    .pipe(Effect.mapError((cause) => new Runtime.SourceUnavailable({ cause })));
  const relation = surface(snapshot).relations.find(
    (item) => item.schema === requested.schema && item.name === requested.name
  );
  if (relation === undefined || (keyed && relation.primaryKey === null))
    return yield* new RelationUnknown({ relation: requested });
  return { ...resolved, relation, snapshot };
});

const execute = Effect.fn("PostgresOperations.execute")(function* (
  resolved: Resolved,
  text: string,
  parameters: ReadonlyArray<Parameter>,
  relation?: typeof Relation.Type
) {
  const execution = yield* Execution.Execution;
  return yield* execution
    .query({
      companyId: resolved.binding.companyId,
      declaration: resolved.declaration,
      text,
      parameters
    })
    .pipe(
      Effect.catchTags({
        PostgresInvalidQuery: (cause) =>
          relation !== undefined &&
          ((cause.details.sqlstate === "22P02" && cause.details.message.includes(SCHEMA_DRIFT)) ||
            cause.details.sqlstate === "42703" ||
            cause.details.sqlstate === "42P01")
            ? Effect.fail(
                new SourceSchemaChanged({
                  relation: { schema: relation.schema, name: relation.name },
                  cause: Redacted.make(cause)
                })
              )
            : Effect.fail(cause)
      })
    );
});

const projection = (columns: ReadonlyArray<typeof Column.Type>) =>
  columns
    .map(
      (column) =>
        `${typeMapping(column.type)!.project(stored(column.name))} AS ${quoteIdentifier(column.name)}`
    )
    .join(", ");

/** Limit evaluates OFFSET before reading rows, including an empty relation or an unmatched filter. */
const typeGuardOffset = ({ relation, snapshot }: BoundRelation, parameters: Parameter[]) => {
  const composite = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`;
  const checks = relation.columns.map((column) => {
    const accepted = acceptedSourceTypes(column.type, snapshot).map((type) => {
      parameters.push(type);
      return `pg_catalog.to_regtype($${parameters.length})`;
    });
    return `pg_catalog.pg_typeof((NULL::${composite}).${quoteIdentifier(column.name)}) IN (${accepted.join(", ")})`;
  });
  // Cast the completed CASE, not a constant ELSE branch that the planner could evaluate eagerly.
  return `(CASE WHEN ${checks.join(" AND ")} THEN '0' ELSE '${SCHEMA_DRIFT}' END)::bigint`;
};

const checkFields = Effect.fn("PostgresOperations.checkFields")(function* (
  result: Execution.QueryResult,
  names: ReadonlyArray<string>
) {
  const indices = new Map<string, number>();
  for (const [index, field] of result.fields.entries()) {
    if (indices.has(field.name))
      return yield* new ShapeMismatch({ column: field.name, reason: "duplicate" });
    indices.set(field.name, index);
  }
  for (const name of names)
    if (!indices.has(name)) return yield* new ShapeMismatch({ column: name, reason: "missing" });
  return indices;
});

const mappedRows = Effect.fn("PostgresOperations.mappedRows")(function* (
  result: Execution.QueryResult,
  columns: ReadonlyArray<typeof Column.Type>,
  present?: number
) {
  const indices = yield* checkFields(
    result,
    columns.map((column) => column.name)
  );
  const rows: Array<Row | null> = [];
  for (const source of result.rows) {
    if (source.length !== result.fields.length)
      return yield* new ShapeMismatch({ column: "", reason: "row_width" });
    if (present !== undefined && source[present] === false) {
      rows.push(null);
      continue;
    }
    const row: Row = {};
    for (const column of columns) {
      const value = source[indices.get(column.name)!];
      if (!validValue(column, value) || !isJson(value))
        return yield* new ShapeMismatch({
          column: column.name,
          reason: value === null ? "null" : "value"
        });
      Object.defineProperty(row, column.name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    rows.push(row);
  }
  return rows;
});

const list = operation({
  input: PostgresList,
  output: PostgresPage,
  errors: Errors,
  run: Effect.fn("PostgresOperations.list")(function* (args: typeof PostgresList.Type) {
    const resolved = yield* resolveRelation(args.connection, args.relation, false);
    const { relation } = resolved;
    const limit = args.limit ?? 100;
    if (limit > MAX_ROWS) return yield* new ItemLimit({});
    const columns = new Map(relation.columns.map((column) => [column.name, column]));
    const selected = args.select ?? relation.columns.map((column) => column.name);
    if (new Set(selected).size !== selected.length || selected.some((name) => !columns.has(name)))
      return yield* new Runtime.InvalidRequest({});
    const order = args.orderBy?.direction ?? "asc";
    const orderNames = [
      ...new Set([
        ...(args.orderBy === undefined ? [] : [args.orderBy.column]),
        ...(relation.primaryKey?.columns ?? [])
      ])
    ];
    for (const name of orderNames)
      if (!columns.has(name) || typeMapping(columns.get(name)!.type)?.comparable !== true)
        return yield* new Runtime.InvalidRequest({});
    const parameters: Parameter[] = [];
    const parameter = (value: Parameter) => {
      parameters.push(value);
      return `$${parameters.length}`;
    };
    const conditions: string[] = [];
    const eq = Object.entries(args.eq ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    for (const [name, value] of eq) {
      const column = columns.get(name);
      if (
        column === undefined ||
        typeMapping(column.type)?.comparable !== true ||
        !validValue(column, value)
      )
        return yield* new Runtime.InvalidRequest({});
      conditions.push(
        value === null ? `${stored(name)} IS NULL` : `${stored(name)} = ${parameter(value)}`
      );
    }
    const range = args.range;
    const bounds = ["gt", "gte", "lt", "lte"] as const;
    const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" };
    if (range !== undefined) {
      const column = columns.get(range.column);
      if (
        column === undefined ||
        typeMapping(column.type)?.comparable !== true ||
        (range.gt !== undefined && range.gte !== undefined) ||
        (range.lt !== undefined && range.lte !== undefined) ||
        !bounds.some((bound) => Object.hasOwn(range, bound))
      )
        return yield* new Runtime.InvalidRequest({});
      for (const bound of bounds)
        if (Object.hasOwn(range, bound)) {
          const value = range[bound];
          if (value === undefined || value === null || !validValue(column, value))
            return yield* new Runtime.InvalidRequest({});
          conditions.push(`${stored(range.column)} ${operators[bound]} ${parameter(value)}`);
        }
    }
    const cursorBinding = encodeJson([
      resolved.binding.companyId,
      resolved.declaration.id,
      relation.schema,
      relation.name,
      resolved.declaration.revision,
      eq,
      range === undefined ? null : [range.column, ...bounds.map((bound) => range[bound] ?? null)],
      orderNames,
      order
    ]);
    let offset = 0;
    if (args.cursor !== undefined) {
      if (args.cursor.length > 256 * 1024 || !/^[A-Za-z0-9_-]+$/.test(args.cursor))
        return yield* new InvalidCursor({});
      const cursor = yield* decodeCursor(
        Buffer.from(args.cursor, "base64url").toString("utf8")
      ).pipe(Effect.mapError(() => new InvalidCursor({})));
      if (cursor.binding !== cursorBinding) return yield* new InvalidCursor({});
      if (relation.primaryKey === null) {
        if (cursor.kind !== "offset") return yield* new InvalidCursor({});
        offset = cursor.offset;
        if (offset >= MAX_OFFSET) return yield* new OffsetExhausted({});
      } else {
        if (
          cursor.kind !== "keyset" ||
          cursor.values.length !== orderNames.length ||
          cursor.values.some((value, index) => !validValue(columns.get(orderNames[index]!)!, value))
        )
          return yield* new InvalidCursor({});
        const equal: string[] = [];
        const branches: string[] = [];
        for (const [index, name] of orderNames.entries()) {
          const value = cursor.values[index]!;
          if (value === null) equal.push(`${stored(name)} IS NULL`);
          else {
            const placeholder = parameter(value);
            branches.push(
              `(${[...equal, `(${stored(name)} ${order === "asc" ? ">" : "<"} ${placeholder}${columns.get(name)!.nullable ? ` OR ${stored(name)} IS NULL` : ""})`].join(" AND ")})`
            );
            equal.push(`${stored(name)} = ${placeholder}`);
          }
        }
        conditions.push(`(${branches.length === 0 ? "FALSE" : branches.join(" OR ")})`);
      }
    }
    const fetchedNames = [...new Set([...selected, ...orderNames])];
    const fetchedColumns = fetchedNames.map((name) => columns.get(name)!);
    const pageSize = relation.primaryKey === null ? Math.min(limit, MAX_OFFSET - offset) : limit;
    const ordering =
      orderNames.length === 0
        ? ""
        : ` ORDER BY ${orderNames.map((name) => `${stored(name)} ${order.toUpperCase()} NULLS LAST`).join(", ")}`;
    const guardOffset = typeGuardOffset(resolved, parameters);
    const text = `SELECT ${projection(fetchedColumns)} FROM ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)} AS stored${conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`}${ordering} LIMIT ${parameter(pageSize)} OFFSET (${guardOffset} + ${parameter(offset)})`;
    const result = yield* execute(resolved, text, parameters, relation);
    const mapped = yield* mappedRows(result, fetchedColumns);
    const rows = mapped.map((row) =>
      Object.fromEntries(selected.map((name) => [name, row![name]!]))
    );
    const last = mapped[mapped.length - 1];
    let cursor: string | null = null;
    // A full page may have a following empty page; never collect a 1001st row to discover it.
    if (mapped.length === pageSize && last !== undefined && last !== null) {
      if (relation.primaryKey === null)
        cursor = encodeCursor({
          version: 1,
          kind: "offset",
          binding: cursorBinding,
          offset: offset + mapped.length
        });
      else {
        const values = orderNames.map((name) => last[name]);
        if (!values.every(isScalar))
          return yield* new ShapeMismatch({ column: "", reason: "value" });
        cursor = encodeCursor({ version: 1, kind: "keyset", binding: cursorBinding, values });
      }
      cursor = Buffer.from(cursor, "utf8").toString("base64url");
    }
    return yield* checkedBytes({ ok: true as const, rows, cursor });
  })
});

const keyedRows = Effect.fn("PostgresOperations.keyedRows")(function* (
  resolved: BoundRelation,
  keys: (typeof PostgresGetMany.Type)["keys"]
) {
  if (keys.length > MAX_ROWS) return yield* new ItemLimit({});
  const { relation } = resolved;
  const names = relation.primaryKey!.columns;
  const parameters: Parameter[] = [];
  const conditions: string[] = [];
  for (const [index, key] of keys.entries()) {
    if (Object.keys(key).length !== names.length || names.some((name) => !Object.hasOwn(key, name)))
      return yield* new Runtime.InvalidRequest({});
    const terms: string[] = [`requested.position = ${index}`];
    for (const name of names) {
      const value = key[name]!;
      const column = relation.columns.find((column) => column.name === name)!;
      if (value === null || !validValue(column, value))
        return yield* new Runtime.InvalidRequest({});
      parameters.push(value);
      terms.push(`${stored(name)} = $${parameters.length}`);
    }
    conditions.push(`(${terms.join(" AND ")})`);
  }
  if (keys.length === 0) return { ok: true as const, rows: [] };
  let presenceIndex = 0;
  let presence = "__patchy_present";
  while (relation.columns.some((column) => column.name === presence))
    presence = `__patchy_present_${++presenceIndex}`;
  const guardOffset = typeGuardOffset(resolved, parameters);
  const result = yield* execute(
    resolved,
    `SELECT ${projection(relation.columns)}, (${stored(names[0]!)} IS NOT NULL) AS ${quoteIdentifier(presence)} FROM generate_series(0, ${keys.length - 1}) AS requested(position) LEFT JOIN ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)} AS stored ON ${conditions.join(" OR ")} ORDER BY requested.position LIMIT ${keys.length} OFFSET ${guardOffset}`,
    parameters,
    relation
  );
  const rows = yield* mappedRows(result, relation.columns, relation.columns.length);
  if (rows.length !== keys.length)
    return yield* new ShapeMismatch({ column: "", reason: "row_width" });
  return yield* checkedBytes({ ok: true as const, rows });
});

const get = operation({
  input: PostgresGet,
  output: PostgresKeyRows,
  errors: Errors,
  run: Effect.fn("PostgresOperations.get")(function* (args: typeof PostgresGet.Type) {
    const resolved = yield* resolveRelation(args.connection, args.relation, true);
    return yield* keyedRows(resolved, [args.key]);
  })
});
const getMany = operation({
  input: PostgresGetMany,
  output: PostgresKeyRows,
  errors: Errors,
  run: Effect.fn("PostgresOperations.getMany")(function* (args: typeof PostgresGetMany.Type) {
    const resolved = yield* resolveRelation(args.connection, args.relation, true);
    return yield* keyedRows(resolved, args.keys);
  })
});

const query = operation({
  input: PostgresQuery,
  output: PostgresRows,
  errors: Errors,
  run: Effect.fn("PostgresOperations.query")(function* (args: typeof PostgresQuery.Type) {
    const resolved = yield* resolve(args.connection);
    const result = yield* execute(resolved, args.sql, args.params);
    const indices = yield* checkFields(result, Object.keys(args.shape));
    for (const [name, shape] of Object.entries(args.shape)) {
      const oid = result.fields[indices.get(name)!]!.dataTypeID;
      if (!queryTypeCompatible(shape.kind, oid))
        return yield* new ShapeMismatch({ column: name, reason: "type" });
    }
    const rows: Row[] = [];
    for (const source of result.rows) {
      if (source.length !== result.fields.length)
        return yield* new ShapeMismatch({ column: "", reason: "row_width" });
      const row: Row = {};
      for (const [name, shape] of Object.entries(args.shape)) {
        const index = indices.get(name)!;
        const raw = source[index];
        if (raw === null) {
          if (shape.optional !== true)
            return yield* new ShapeMismatch({ column: name, reason: "null" });
          Object.defineProperty(row, name, { value: null, enumerable: true });
          continue;
        }
        const value =
          shape.kind === "timestamp"
            ? normalizeTimestamp(raw, result.fields[index]!.dataTypeID === 1184)
            : raw;
        const valid =
          shape.kind === "text"
            ? typeof value === "string"
            : shape.kind === "integer"
              ? typeof value === "number" && Number.isSafeInteger(value)
              : shape.kind === "number"
                ? typeof value === "number" && Number.isFinite(value)
                : shape.kind === "boolean"
                  ? typeof value === "boolean"
                  : shape.kind === "timestamp"
                    ? value !== undefined
                    : isJson(value);
        if (!valid || !isJson(value))
          return yield* new ShapeMismatch({ column: name, reason: "value" });
        Object.defineProperty(row, name, { value, enumerable: true });
      }
      rows.push(row);
    }
    return yield* checkedBytes({ ok: true as const, rows });
  })
});

export const operations = { list, get, getMany, query };

const resource: Runtime.JsonHandler["resource"] = (args) =>
  Predicate.isObject(args) && Object.hasOwn(args, "relation") && isRelation(args.relation)
    ? `${quoteIdentifier(args.relation.schema)}.${quoteIdentifier(args.relation.name)}`
    : null;
const connectionId = (args: unknown, binding: Binding.Binding["Service"]): string | null => {
  if (
    !Predicate.isObject(args) ||
    typeof args.connection !== "string" ||
    !Object.hasOwn(binding.manifest.uses, args.connection)
  )
    return null;
  const declaration = binding.manifest.uses[args.connection];
  return declaration?.kind === "postgres" ? declaration.id : null;
};
const rowCount: Runtime.JsonHandler["rowCount"] = (value) => {
  if (!Predicate.isObject(value) || !Array.isArray(value.rows)) return null;
  let count = 0;
  for (const row of value.rows) if (row !== null) count++;
  return count;
};

/** Production and dev capture the same dependencies; admission supplies only Binding per call. */
export const makeHandlers = Effect.gen(function* () {
  const execution = yield* Execution.Execution;
  const connections = yield* ConnectionStore.ConnectionStore;
  const capture = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      Binding.Binding | Execution.Execution | ConnectionStore.ConnectionStore
    >
  ) =>
    effect.pipe(
      Effect.provideService(Execution.Execution, execution),
      Effect.provideService(ConnectionStore.ConnectionStore, connections)
    );
  const metadata = { kind: "integration" as const, resource, connectionId, rowCount };
  return {
    "postgres.list": Runtime.handler({ ...metadata, ...list }, (args) => capture(list.run(args))),
    "postgres.get": Runtime.handler({ ...metadata, ...get }, (args) => capture(get.run(args))),
    "postgres.getMany": Runtime.handler({ ...metadata, ...getMany }, (args) =>
      capture(getMany.run(args))
    ),
    "postgres.query": Runtime.handler(
      {
        ...metadata,
        ...query,
        sql: (args: unknown) =>
          Predicate.isObject(args) && typeof args.sql === "string" ? args.sql : undefined
      },
      (args) => capture(query.run(args))
    )
  };
});
