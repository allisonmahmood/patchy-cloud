import type { PostgresShapeColumn } from "@patchy/api";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * How a HogQL result column, typed by ClickHouse, maps onto the shape language patches use for
 * raw queries. A value either maps exactly or is refused: PostHog sends decimals and integers
 * wider than 53 bits as JSON numbers, so they must be cast, wherever they appear in a column.
 */

type Kind = (typeof PostgresShapeColumn.Type)["kind"];

/** A parsed ClickHouse type: its name and the types inside it, without literal arguments. */
export interface Type {
  readonly name: string;
  readonly args: ReadonlyArray<Type>;
}

/** ClickHouse type families, after Nullable(...) and LowCardinality(...) are unwrapped. */
type Family =
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

const token =
  /\s*(?:([(),=])|('(?:[^'\\]|\\.|'')*')|(`(?:[^`\\]|\\.)*`)|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*))/y;

/**
 * Parses a type string such as `Nullable(DateTime64(6, 'UTC'))` or
 * `Tuple(day Date, views UInt64)`. Quoted labels, numbers and tuple field names are not types;
 * an unparsable string is undefined, which no shape accepts.
 */
export const parse = (text: string): Type | undefined => {
  const tokens: Array<{ readonly kind: "punct" | "literal" | "name"; readonly text: string }> = [];
  token.lastIndex = 0;
  while (token.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(token.lastIndex))) break;
    const match = token.exec(text);
    if (match === null) return undefined;
    tokens.push(
      match[1] !== undefined
        ? { kind: "punct", text: match[1] }
        : match[5] !== undefined
          ? { kind: "name", text: match[5] }
          : match[3] !== undefined
            ? { kind: "name", text: match[3] }
            : { kind: "literal", text: match[2] ?? match[4]! }
    );
  }
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset];
  const type = (): Type | undefined => {
    const head = tokens[at];
    if (head?.kind !== "name" || head.text.startsWith("`")) return undefined;
    at++;
    if (peek()?.text !== "(") return { name: head.text, args: [] };
    at++;
    const args: Type[] = [];
    while (true) {
      const next = peek();
      if (next === undefined) return undefined;
      if (next.kind === "literal") {
        // An enum entry `'label' = 1`, a precision or a timezone: not a type.
        at++;
        if (peek()?.text === "=") at += 2;
      } else {
        // A named tuple field is a name followed by its type.
        if (next.kind === "name" && peek(1)?.kind === "name") at++;
        const inner = type();
        if (inner === undefined) return undefined;
        args.push(inner);
      }
      const separator = tokens[at++]?.text;
      if (separator === ")") return { name: head.text, args };
      if (separator !== ",") return undefined;
    }
  };
  const parsed = type();
  return parsed !== undefined && at === tokens.length ? parsed : undefined;
};

const unwrap = (type: Type): Type =>
  (type.name === "Nullable" || type.name === "LowCardinality") && type.args.length === 1
    ? unwrap(type.args[0]!)
    : type;

const family = (type: Type): Family => {
  switch (type.name) {
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
      return type.args.length === 0 ? "unknown" : "composite";
    case "Nothing":
      return "nothing";
    default:
      return "unknown";
  }
};

/** Whether every part of a type is one Patchy maps; decimals and wide integers never are. */
const mapped = (type: Type): boolean => {
  const inner = unwrap(type);
  const from = family(inner);
  return from === "composite"
    ? inner.args.every(mapped)
    : from !== "decimal" && from !== "wide" && from !== "unknown";
};

/** Whether a column of this ClickHouse type can fill the shape kind. */
export const compatible = (kind: Kind, type: Type | undefined): boolean => {
  if (type === undefined) return false;
  const from = family(unwrap(type));
  if (from === "nothing") return true;
  switch (kind) {
    case "json":
      return mapped(type);
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

/** Whether a value's 64-bit integers, wherever its type puts them, are exact. */
const exact = (type: Type, value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  const inner = unwrap(type);
  switch (inner.name) {
    case "Int64":
    case "UInt64":
      return typeof value !== "number" || Number.isSafeInteger(value);
    case "Array":
      return !Array.isArray(value) || value.every((item) => exact(inner.args[0]!, item));
    case "Nested":
      return (
        !Array.isArray(value) ||
        value.every((item) => exact({ name: "Tuple", args: inner.args }, item))
      );
    case "Tuple": {
      const items: ReadonlyArray<unknown> = Array.isArray(value)
        ? value
        : typeof value === "object"
          ? Object.values(value)
          : [];
      return items.every((item, index) => {
        const member = inner.args[index];
        return member === undefined || exact(member, item);
      });
    }
    case "Map": {
      const values = inner.args[1];
      return (
        values === undefined ||
        typeof value !== "object" ||
        Object.values(value).every((item) => exact(values, item))
      );
    }
    default:
      return true;
  }
};

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
 * an unsafe 64-bit integer at any depth, a non-finite float, or a date that isn't one.
 */
export const value = (kind: Kind, type: Type, raw: unknown): unknown => {
  switch (kind) {
    case "json":
      return exact(type, raw) ? raw : undefined;
    case "text":
      return typeof raw === "string" ? raw : undefined;
    case "integer":
      return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : undefined;
    case "number":
      return typeof raw === "number" &&
        Number.isFinite(raw) &&
        (family(unwrap(type)) === "float" || Number.isSafeInteger(raw))
        ? raw
        : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : raw === 0 ? false : raw === 1 ? true : undefined;
    case "timestamp":
      return typeof raw === "string" ? utc(raw) : undefined;
  }
};
