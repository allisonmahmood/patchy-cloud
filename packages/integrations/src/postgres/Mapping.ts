import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ColumnType, Snapshot } from "./Snapshot.js";

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const quoteLiteral = (value: string): string =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

export interface TypeMapping {
  readonly typescript: string;
  readonly comparable: boolean;
  readonly project: (quotedColumn: string) => string;
  readonly is: (value: unknown) => boolean;
}

const isDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = DateTime.make(`${value}T00:00:00Z`);
  return Option.isSome(parsed) && DateTime.formatIsoDateUtc(parsed.value) === value;
};

/** Driver timestamps are kept as text; only the whole seconds pass through DateTime. */
export const normalizeTimestamp = (value: unknown, withTimezone: boolean): string | undefined => {
  if (typeof value !== "string") return undefined;
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      value
    );
  if (!match || !isDate(match[1]!) || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(match[2]!))
    return undefined;
  const fraction = (match[3] ?? "").padEnd(6, "0");
  const zone = match[4];
  if (!withTimezone) return zone === undefined ? `${match[1]}T${match[2]}.${fraction}` : undefined;
  if (zone === undefined) return undefined;
  const offset =
    zone === "Z"
      ? zone
      : zone.length === 3
        ? `${zone}:00`
        : zone.length === 5
          ? `${zone.slice(0, 3)}:${zone.slice(3)}`
          : zone;
  const parsed = DateTime.make(`${match[1]}T${match[2]}${offset}`);
  if (Option.isNone(parsed)) return undefined;
  const utc = DateTime.formatIso(parsed.value).slice(0, 19);
  return /^\d{4}-/.test(utc) ? `${utc}.${fraction}Z` : undefined;
};

const identity = (column: string) => column;
const textProjection = (column: string) => `${column}::text`;
const text: TypeMapping = {
  typescript: "string",
  comparable: true,
  project: textProjection,
  is: Schema.is(Schema.String)
};
const integer: TypeMapping = {
  typescript: "number",
  comparable: true,
  project: identity,
  is: Schema.is(Schema.Int)
};
const number: TypeMapping = {
  typescript: "number",
  comparable: true,
  project: identity,
  is: Schema.is(Schema.Number.check(Schema.isFinite()))
};
const numeric: TypeMapping = {
  ...text,
  is: Schema.is(Schema.String.check(Schema.isPattern(/^-?\d+(?:\.\d+)?$/)))
};
const int8: TypeMapping = {
  ...text,
  is: Schema.is(
    Schema.String.check(
      Schema.makeFilter((value) => {
        if (!/^-?\d+$/.test(value)) return false;
        const integer = BigInt(value);
        return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
      })
    )
  )
};
const json: TypeMapping = {
  typescript: "unknown",
  comparable: false,
  project: (column) => `pg_catalog.to_jsonb(${column})`,
  is: Schema.is(Schema.Json)
};
const timestamp = (withTimezone: boolean): TypeMapping => ({
  ...text,
  project: (column) =>
    `CASE WHEN pg_catalog.isfinite(${column}) THEN pg_catalog.to_char(${withTimezone ? `${column} AT TIME ZONE 'UTC'` : column}, 'YYYY-MM-DD"T"HH24:MI:SS.US${withTimezone ? '"Z"' : ""}') ELSE ${column}::text END`,
  is: (value) => typeof value === "string" && normalizeTimestamp(value, withTimezone) === value
});

// This allowlist drives source support, fixture-native DDL, projection and validation.
const builtins: Readonly<Record<string, TypeMapping>> = {
  int2: {
    ...integer,
    is: Schema.is(Schema.Int.check(Schema.isBetween({ minimum: -32768, maximum: 32767 })))
  },
  int4: {
    ...integer,
    is: Schema.is(Schema.Int.check(Schema.isBetween({ minimum: -2147483648, maximum: 2147483647 })))
  },
  int8,
  numeric,
  float4: number,
  float8: number,
  text,
  varchar: text,
  bpchar: text,
  name: text,
  char: text,
  uuid: {
    ...text,
    is: Schema.is(
      Schema.String.check(
        Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      )
    )
  },
  bool: {
    typescript: "boolean",
    comparable: true,
    project: identity,
    is: Schema.is(Schema.Boolean)
  },
  timestamptz: timestamp(true),
  timestamp: timestamp(false),
  date: {
    ...text,
    project: (column) =>
      `CASE WHEN pg_catalog.isfinite(${column}) THEN pg_catalog.to_char(${column}, 'YYYY-MM-DD') ELSE ${column}::text END`,
    is: Schema.is(Schema.String.check(Schema.makeFilter(isDate)))
  },
  json,
  jsonb: json
};

export const typeMapping = (type: typeof ColumnType.Type): TypeMapping | undefined => {
  if (type.kind === "enum") return text;
  if (type.kind === "array") return json;
  if (type.baseName === "citext") return text;
  if (type.baseSchema === "pg_catalog" && Object.hasOwn(builtins, type.baseName))
    return builtins[type.baseName];
  return undefined;
};

/** Never execute format_type output from a remote catalog as SQL. Domains use their resolved base. */
export const nativeType = (
  type: typeof ColumnType.Type,
  snapshot: typeof Snapshot.Type
): string | undefined => {
  if (type.kind === "enum") {
    return snapshot.enums.some(
      (item) => item.schema === type.baseSchema && item.name === type.baseName
    )
      ? `${quoteIdentifier(type.baseSchema)}.${quoteIdentifier(type.baseName)}`
      : undefined;
  }
  if (type.kind === "array") {
    const element = type.element;
    if (element) {
      const base = nativeType(
        { ...element, schema: element.baseSchema, name: element.baseName, sql: "" },
        snapshot
      );
      return base === undefined ? undefined : `${base}[]`;
    }
    if (
      type.baseSchema === "pg_catalog" &&
      type.baseName.startsWith("_") &&
      Object.hasOwn(builtins, type.baseName.slice(1))
    ) {
      return `${quoteIdentifier("pg_catalog")}.${quoteIdentifier(type.baseName.slice(1))}[]`;
    }
    return undefined;
  }
  return typeMapping(type) === undefined
    ? undefined
    : `${quoteIdentifier(type.baseSchema)}.${quoteIdentifier(type.baseName)}`;
};

export const reservedRelation = (
  schema: string,
  name: string,
  schemas: ReadonlySet<string>
): boolean => schema === "query" || name === "query" || (schema === "public" && schemas.has(name));

/** All consumers see the same explicitly named exclusions, including old stored snapshots. */
export const surface = (snapshot: typeof Snapshot.Type): typeof Snapshot.Type => {
  const schemas = new Set(
    [
      ...snapshot.relations.map((item) => item.schema),
      ...snapshot.exclusions.map((item) => item.schema)
    ].filter((name) => name !== "public")
  );
  const exclusions = [...snapshot.exclusions];
  const relations: Array<(typeof Snapshot.Type.relations)[number]> = [];
  for (const relation of snapshot.relations) {
    const reserved = reservedRelation(relation.schema, relation.name, schemas);
    const unsupported = relation.columns.filter(
      (column) =>
        typeMapping(column.type) === undefined || nativeType(column.type, snapshot) === undefined
    );
    const previous = exclusions.some(
      (item) =>
        item.schema === relation.schema &&
        item.relation === relation.name &&
        (item.column === undefined ||
          item.reason === "unsupported_type" ||
          item.reason === "enum_limit")
    );
    if (reserved || unsupported.length > 0 || previous || relation.columns.length === 0) {
      for (const column of unsupported) {
        if (
          !exclusions.some(
            (item) =>
              item.schema === relation.schema &&
              item.relation === relation.name &&
              item.column === column.name
          )
        )
          exclusions.push({
            schema: relation.schema,
            relation: relation.name,
            column: column.name,
            reason: "unsupported_type"
          });
      }
      if (
        !exclusions.some(
          (item) =>
            item.schema === relation.schema &&
            item.relation === relation.name &&
            item.column === undefined
        )
      )
        exclusions.push({
          schema: relation.schema,
          relation: relation.name,
          reason: reserved ? "reserved_name" : "unsupported_type"
        });
      continue;
    }
    const primaryKey =
      relation.primaryKey !== null &&
      relation.primaryKey.columns.every((name) =>
        relation.columns.some(
          (column) =>
            column.name === name && !column.nullable && typeMapping(column.type)?.comparable
        )
      )
        ? relation.primaryKey
        : null;
    relations.push({ ...relation, primaryKey });
  }
  return { ...snapshot, relations, exclusions };
};
