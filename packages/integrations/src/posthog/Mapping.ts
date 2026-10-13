import type { PostgresShapeColumn } from "@patchy/api";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * How a HogQL result column, typed by ClickHouse, maps onto the shape language patches use for
 * raw queries. A value either maps exactly or is refused with the cast that would fix it.
 */

type Kind = (typeof PostgresShapeColumn.Type)["kind"];
/** ClickHouse type families, after Nullable(...) and LowCardinality(...) are unwrapped. */
export type Family =
  | "string"
  | "date"
  | "integer"
  | "int64"
  | "wide"
  | "float"
  | "decimal"
  | "boolean"
  | "datetime"
  | "composite"
  | "nothing"
  | "unknown";

const wrapper = /^(Nullable|LowCardinality)\((.*)\)$/s;

/** The family of a ClickHouse type string such as `Nullable(DateTime64(6, 'UTC'))`. */
export const family = (type: string): Family => {
  let base = type.trim();
  for (let match = wrapper.exec(base); match !== null; match = wrapper.exec(base))
    base = match[2]!.trim();
  const name = /^[A-Za-z0-9]+/.exec(base)?.[0] ?? "";
  switch (name) {
    case "String":
    case "FixedString":
    case "UUID":
    case "Enum8":
    case "Enum16":
    case "IPv4":
    case "IPv6":
      return "string";
    case "Date":
    case "Date32":
      return "date";
    case "Int8":
    case "Int16":
    case "Int32":
    case "UInt8":
    case "UInt16":
    case "UInt32":
      return "integer";
    case "Int64":
    case "UInt64":
      return "int64";
    case "Int128":
    case "UInt128":
    case "Int256":
    case "UInt256":
      return "wide";
    case "Float32":
    case "Float64":
      return "float";
    case "Decimal":
    case "Decimal32":
    case "Decimal64":
    case "Decimal128":
    case "Decimal256":
      return "decimal";
    case "Bool":
    case "Boolean":
      return "boolean";
    case "DateTime":
    case "DateTime64":
      return "datetime";
    case "Array":
    case "Tuple":
    case "Map":
    case "Nested":
    case "JSON":
    case "Object":
    case "Variant":
    case "Dynamic":
      return "composite";
    case "Nothing":
      return "nothing";
    default:
      return "unknown";
  }
};

/** Types PostHog sends as rounded numbers: decimals and integers wider than 64 bits. */
const rounded = /\b(?:Decimal(?:32|64|128|256)?|U?Int(?:128|256))\b/;
/** 64-bit integers, which are numbers in JSON and exact only while they are safe. */
const int64 = /\bU?Int64\b/;

/**
 * Whether a column of this ClickHouse type can fill the shape kind. A type that PostHog would
 * round, at any depth, must be cast whatever the shape; an unknown type is refused.
 */
export const compatible = (kind: Kind, type: string): boolean => {
  const from = family(type);
  if (from === "nothing") return true;
  switch (kind) {
    case "json":
      return from !== "decimal" && from !== "wide" && from !== "unknown" && !rounded.test(type);
    case "text":
      return from === "string" || from === "date";
    case "integer":
      return from === "integer" || from === "int64";
    case "number":
      return from === "integer" || from === "int64" || from === "float";
    case "boolean":
      // ClickHouse comparisons return UInt8 0 or 1.
      return from === "boolean" || from === "integer";
    case "timestamp":
      return from === "datetime";
  }
};

/** Whether a JSON value holds an integer too large to be exact, at any depth. */
const unsafe = (value: unknown): boolean =>
  typeof value === "number"
    ? Number.isInteger(value) && !Number.isSafeInteger(value)
    : Array.isArray(value)
      ? value.some(unsafe)
      : typeof value === "object" && value !== null
        ? Object.values(value).some(unsafe)
        : false;

const datetime =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/** A ClickHouse DateTime as UTC ISO with six fractional digits, as Postgres timestamps are. */
export const utc = (value: string): string | undefined => {
  const match = datetime.exec(value);
  if (match === null) return undefined;
  const zone = match[4] ?? "Z";
  const offset =
    zone === "Z" ? zone : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  const parsed = DateTime.make(`${match[1]}T${match[2]}${offset}`);
  if (Option.isNone(parsed)) return undefined;
  const iso = DateTime.formatIso(parsed.value);
  if (!/^\d{4}-/.test(iso)) return undefined;
  return `${iso.slice(0, 19)}.${(match[3] ?? "").padEnd(9, "0").slice(0, 6)}Z`;
};

/**
 * One value of a compatible column as the shape returns it, or undefined when it doesn't fit:
 * an unsafe integer at any depth, a non-finite float, or a date that isn't one.
 */
export const value = (kind: Kind, type: string, raw: unknown): unknown => {
  const from = family(type);
  switch (kind) {
    case "json":
      return int64.test(type) && unsafe(raw) ? undefined : raw;
    case "text":
      return typeof raw === "string" ? raw : undefined;
    case "integer":
      return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : undefined;
    case "number":
      return typeof raw === "number" &&
        Number.isFinite(raw) &&
        (from === "float" || Number.isSafeInteger(raw))
        ? raw
        : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : raw === 0 ? false : raw === 1 ? true : undefined;
    case "timestamp":
      return typeof raw === "string" ? utc(raw) : undefined;
  }
};
