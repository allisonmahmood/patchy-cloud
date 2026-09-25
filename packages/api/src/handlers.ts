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
// PROTOTYPE for #314 round 2: the grammar is closed; a descriptor carries only its own keys.
const descriptorKeys: Record<string, ReadonlySet<string>> = {
  ref: new Set(["kind", "table", "optional"]),
  row: new Set(["kind", "table", "optional"]),
  object: new Set(["kind", "fields", "optional"]),
  array: new Set(["kind", "items", "optional"]),
  enum: new Set(["kind", "values", "optional"]),
  nullable: new Set(["kind", "inner", "optional"])
};
const scalarKeys = new Set(["kind", "optional"]);

/** Structural check of a descriptor; `depth` bounds hostile nesting. */
export const isTypeDescriptor = (value: unknown, depth = 0): value is TypeDescriptor => {
  if (depth > 16 || !isRecord(value) || typeof value.kind !== "string") return false;
  if (value.optional !== undefined && typeof value.optional !== "boolean") return false;
  const allowedKeys = descriptorKeys[value.kind] ?? scalarKeys;
  if (!Object.keys(value).every((key) => allowedKeys.has(key))) return false;
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

const handlerKeys = new Set(["kind", "args", "result", "errors"]);
export const isHandlerDescriptor = (value: unknown): value is HandlerDescriptor =>
  isRecord(value) &&
  Object.keys(value).every((key) => handlerKeys.has(key)) &&
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
/** A pinned manifest's table definitions, for `t.row` validation. */
export type TableShapes = Readonly<
  Record<
    string,
    {
      readonly columns: Readonly<
        Record<string, { readonly kind: string; readonly optional?: boolean | undefined }>
      >;
    }
  >
>;
const systemColumns = { id: "text", createdAt: "timestamp", updatedAt: "timestamp" } as const;

export const checkValue = (
  descriptor: TypeDescriptor,
  value: unknown,
  path = "$",
  tables?: TableShapes
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
      return value === null ? undefined : checkValue(descriptor.inner, value, path, tables);
    case "array": {
      if (!Array.isArray(value)) return `${path}: expected an array`;
      for (let index = 0; index < value.length; index++) {
        const problem = checkValue(descriptor.items, value[index], `${path}[${index}]`, tables);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    case "row": {
      // PROTOTYPE for #314 round 2: the declared row shape from the pinned manifest, system
      // columns included, no unknown keys; without table shapes only the id is checked.
      if (!isRecord(value) || typeof value.id !== "string")
        return `${path}: expected a ${descriptor.table} row`;
      const table = tables?.[descriptor.table];
      if (table === undefined)
        return tables === undefined
          ? undefined
          : `${path}: table ${descriptor.table} is not declared`;
      const columns: Record<string, { kind: string; optional?: boolean | undefined }> = {
        ...Object.fromEntries(
          Object.entries(systemColumns).map(([name, kind]) => [name, { kind }])
        ),
        ...table.columns
      };
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(columns, key))
          return `${path}.${key}: not a column of ${descriptor.table}`;
      }
      for (const [name, column] of Object.entries(columns)) {
        const field = value[name];
        if (field === null || field === undefined) {
          if (column.optional === true) continue;
          return `${path}.${name}: missing`;
        }
        const kind = column.kind === "ref" ? "text" : column.kind;
        if (!scalarKinds.has(kind)) return `${path}.${name}: unsupported column kind ${kind}`;
        const problem = checkValue(
          { kind: kind as "text" | "integer" | "number" | "boolean" | "timestamp" | "json" },
          field,
          `${path}.${name}`
        );
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
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
        const problem = checkValue(field, value[key], `${path}.${key}`, tables);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
  }
};

/**
 * PROTOTYPE for #314 round 2: the first path at which two handler maps differ, for the publish
 * refusal (`notes.add.args.fields.title.kind: declared text, bundle says integer`).
 */
export const diffHandlers = (declared: Handlers, derived: Handlers): string | undefined => {
  const walk = (a: unknown, b: unknown, path: string): string | undefined => {
    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!Object.hasOwn(a, key)) return `${path}.${key}: not declared, bundle has it`;
        if (!Object.hasOwn(b, key)) return `${path}.${key}: declared, bundle does not have it`;
        const problem = walk(a[key], b[key], `${path}.${key}`);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length)
        return `${path}: declared ${a.length} entries, bundle says ${b.length}`;
      for (let index = 0; index < a.length; index++) {
        const problem = walk(a[index], b[index], `${path}[${index}]`);
        if (problem !== undefined) return problem;
      }
      return undefined;
    }
    return a === b
      ? undefined
      : `${path}: declared ${JSON.stringify(a)}, bundle says ${JSON.stringify(b)}`;
  };
  for (const name of new Set([...Object.keys(declared), ...Object.keys(derived)])) {
    if (!Object.hasOwn(declared, name)) return `${name}: not declared, bundle has it`;
    if (!Object.hasOwn(derived, name)) return `${name}: declared, bundle does not have it`;
    const problem = walk(declared[name], derived[name], name);
    if (problem !== undefined) return problem;
  }
  return undefined;
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
