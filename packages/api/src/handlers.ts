// PROTOTYPE for #314: handler descriptors on the wire.
//
// A tier 2 manifest carries `handlers: { "<module>.<export>": { kind, args, result, errors? } }`.
// The descriptors are JSON produced by the `t` builders in `patchy/config`; this module owns
// their grammar, a structural validator the runtime applies to arguments before an invocation
// and to the result after it, and the canonical form the server compares against what the
// engine re-derives from the uploaded bundle.
import * as Schema from "effect/Schema";

export type HandlerKind = "query" | "mutation" | "action";

/** The serialised form of a `t` value used for arguments and results. */
export type TypeDescriptor =
  | {
      readonly kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json";
      readonly optional?: boolean;
    }
  | { readonly kind: "ref"; readonly table: string; readonly optional?: boolean }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, TypeDescriptor>>;
      readonly optional?: boolean;
    }
  | { readonly kind: "array"; readonly items: TypeDescriptor; readonly optional?: boolean }
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly optional?: boolean }
  | { readonly kind: "nullable"; readonly inner: TypeDescriptor; readonly optional?: boolean }
  | { readonly kind: "row"; readonly table: string; readonly optional?: boolean };

// A type alias, not an interface: object literal types carry an implicit index signature, so
// a descriptor map is assignable to the schema's `Record<string, Json>`.
export type HandlerDescriptor = {
  readonly kind: HandlerKind;
  readonly args: TypeDescriptor & { readonly kind: "object" };
  readonly result: TypeDescriptor;
  readonly errors?: readonly string[];
};

const scalarKinds = new Set(["text", "integer", "number", "boolean", "timestamp", "json"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Structural check of a descriptor; `depth` bounds hostile nesting. */
export const isTypeDescriptor = (value: unknown, depth = 0): value is TypeDescriptor => {
  if (depth > 16 || !isRecord(value) || typeof value.kind !== "string") return false;
  if (value.optional !== undefined && typeof value.optional !== "boolean") return false;
  if (Object.hasOwn(value, "default")) return false;
  switch (value.kind) {
    case "ref":
    case "row":
      return typeof value.table === "string" && value.table.length > 0;
    case "object":
      return (
        isRecord(value.fields) &&
        Object.values(value.fields).every((field) => isTypeDescriptor(field, depth + 1))
      );
    case "array":
      return isTypeDescriptor(value.items, depth + 1);
    case "enum":
      return (
        Array.isArray(value.values) &&
        value.values.length > 0 &&
        value.values.every((entry) => typeof entry === "string")
      );
    case "nullable":
      return isTypeDescriptor(value.inner, depth + 1);
    default:
      return scalarKinds.has(value.kind);
  }
};

export const isHandlerDescriptor = (value: unknown): value is HandlerDescriptor =>
  isRecord(value) &&
  (value.kind === "query" || value.kind === "mutation" || value.kind === "action") &&
  isTypeDescriptor(value.args) &&
  (value.args as TypeDescriptor).kind === "object" &&
  isTypeDescriptor(value.result) &&
  (value.errors === undefined ||
    (Array.isArray(value.errors) && value.errors.every((code) => typeof code === "string")));

const handlerName = /^[a-z][a-zA-Z0-9]{0,62}\.[a-zA-Z_$][a-zA-Z0-9_$]{0,62}$/;
export const isHandlerName = (name: string): boolean => handlerName.test(name);

/** The manifest field: descriptors keyed by `<module>.<export>`, validated structurally. */
export const Handlers = Schema.Record(Schema.String, Schema.Json).check(
  Schema.makeFilter(
    (record) =>
      Object.entries(record).every(
        ([name, value]) => isHandlerName(name) && isHandlerDescriptor(value)
      ) ||
      "Handlers must be keyed by <module>.<export> and carry kind, args (object) and result descriptors."
  )
);
export type Handlers = Readonly<Record<string, HandlerDescriptor>>;

const isIso = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);

/**
 * Validates a JSON value against a descriptor. Returns the first problem as a path and reason,
 * or undefined when the value conforms. Unknown object fields are refused so a handler never
 * sees an argument its declaration did not name.
 */
export const checkValue = (
  descriptor: TypeDescriptor,
  value: unknown,
  path = "$"
): string | undefined => {
  switch (descriptor.kind) {
    case "text":
    case "ref":
      return typeof value === "string" ? undefined : `${path}: expected a string`;
    case "integer":
      return Number.isSafeInteger(value) ? undefined : `${path}: expected an integer`;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? undefined
        : `${path}: expected a number`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path}: expected a boolean`;
    case "timestamp":
      return typeof value === "string" && isIso(value)
        ? undefined
        : `${path}: expected an ISO timestamp`;
    case "json":
      return value === undefined ? `${path}: expected JSON` : undefined;
    case "enum":
      return typeof value === "string" && descriptor.values.includes(value)
        ? undefined
        : `${path}: expected one of ${descriptor.values.join(", ")}`;
    case "nullable":
      return value === null ? undefined : checkValue(descriptor.inner, value, path);
    case "array": {
      if (!Array.isArray(value)) return `${path}: expected an array`;
      for (let index = 0; index < value.length; index++) {
        const problem = checkValue(descriptor.items, value[index], `${path}[${index}]`);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case "row":
      return isRecord(value) && typeof value.id === "string"
        ? undefined
        : `${path}: expected a ${descriptor.table} row`;
    case "object": {
      if (!isRecord(value)) return `${path}: expected an object`;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(descriptor.fields, key)) return `${path}.${key}: unknown field`;
      }
      for (const [key, field] of Object.entries(descriptor.fields)) {
        const present = Object.hasOwn(value, key) && value[key] !== undefined;
        if (!present) {
          if (field.optional === true) continue;
          return `${path}.${key}: missing`;
        }
        const problem = checkValue(field, value[key], `${path}.${key}`);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
  }
};

/** Key-order-independent form for comparing a manifest's handlers with the engine's discovery. */
export const canonicalHandlers = (handlers: Handlers): string =>
  JSON.stringify(handlers, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value
  );

/** The typed view of a decoded manifest's `handlers` field (the schema keeps it as JSON). */
export const handlersOf = (value: Readonly<Record<string, unknown>> | undefined): Handlers => {
  const result: Record<string, HandlerDescriptor> = {};
  for (const [name, descriptor] of Object.entries(value ?? {})) {
    if (isHandlerName(name) && isHandlerDescriptor(descriptor)) result[name] = descriptor;
  }
  return result;
};
