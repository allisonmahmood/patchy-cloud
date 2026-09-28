import * as Schema from "effect/Schema";

export const HandlerKind = Schema.Literals(["query", "mutation", "action"]);
export type HandlerKind = typeof HandlerKind.Type;

/** One server module and one named export, without directory traversal. */
export const HandlerName = Schema.String.check(
  Schema.makeFilter(
    (name) =>
      /^[a-zA-Z_$][a-zA-Z0-9_$-]*\.[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ||
      "Handler names must be module.export, one level deep."
  )
);

export type HandlerSchema = (
  | { readonly kind: "text" | "integer" | "number" | "boolean" | "timestamp" | "json" }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, HandlerSchema>> }
  | { readonly kind: "array"; readonly element: HandlerSchema }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "nullable"; readonly value: HandlerSchema }
  | { readonly kind: "row"; readonly table: string }
  | { readonly kind: "fileHandle" | "upload" }
) & { readonly optional?: true };

const modifiers = {
  optional: Schema.optionalKey(Schema.Literal(true)),
  // A default is a table-column modifier, never a handler-field modifier.
  default: Schema.optionalKey(Schema.Never)
};
const fields = <S extends Schema.Top>(value: S) =>
  Schema.Record(Schema.String, value).check(
    Schema.makeFilter(
      (record) =>
        Object.keys(record).every((name) => name.length > 0) || "Field names must not be empty."
    )
  );

export const HandlerSchema: Schema.Codec<HandlerSchema> = Schema.suspend(() =>
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literals(["text", "integer", "number", "boolean", "timestamp", "json"]),
      ...modifiers
    }),
    Schema.Struct({
      kind: Schema.Literal("object"),
      fields: fields(HandlerSchema),
      ...modifiers
    }),
    Schema.Struct({ kind: Schema.Literal("array"), element: HandlerSchema, ...modifiers }),
    Schema.Struct({
      kind: Schema.Literal("enum"),
      values: Schema.Array(Schema.String).check(
        Schema.isMinLength(1),
        Schema.makeFilter(
          (values) => new Set(values).size === values.length || "Enum values must be distinct."
        )
      ),
      ...modifiers
    }),
    Schema.Struct({ kind: Schema.Literal("nullable"), value: HandlerSchema, ...modifiers }),
    Schema.Struct({
      kind: Schema.Literal("row"),
      table: Schema.String.check(
        Schema.makeFilter(
          (name) => /^[a-z][a-zA-Z0-9]{0,62}$/.test(name) || "Invalid row table name."
        )
      ),
      ...modifiers
    }),
    Schema.Struct({ kind: Schema.Literals(["fileHandle", "upload"]), ...modifiers })
  ])
);

const schemaProblem = (
  schema: HandlerSchema,
  kind: HandlerKind,
  position: "args" | "result",
  field: boolean,
  tables?: Readonly<Record<string, unknown>>
): string | undefined => {
  if (schema.optional === true && !field) return "Only object and argument fields may be optional.";
  switch (schema.kind) {
    case "fileHandle":
      return position === "result"
        ? undefined
        : "File handles are allowed only in handler results.";
    case "upload":
      return position === "args" && kind === "action"
        ? undefined
        : "Uploads are allowed only in action arguments.";
    case "object":
      for (const child of Object.values(schema.fields)) {
        const problem = schemaProblem(child, kind, position, true, tables);
        if (problem !== undefined) return problem;
      }
      return undefined;
    case "array":
      return schemaProblem(schema.element, kind, position, false, tables);
    case "nullable":
      return schemaProblem(schema.value, kind, position, false, tables);
    case "row":
      return tables === undefined || Object.hasOwn(tables, schema.table)
        ? undefined
        : `Row schema names unknown table "${schema.table}".`;
    default:
      return undefined;
  }
};

export const HandlerDescriptor = Schema.Struct({
  kind: HandlerKind,
  args: fields(HandlerSchema),
  result: HandlerSchema,
  errors: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1))))
}).check(
  Schema.makeFilter((handler) => {
    for (const field of Object.values(handler.args)) {
      const problem = schemaProblem(field, handler.kind, "args", true);
      if (problem !== undefined) return problem;
    }
    return schemaProblem(handler.result, handler.kind, "result", false) ?? true;
  })
);
export type HandlerDescriptor = typeof HandlerDescriptor.Type;

const isHandlerName = Schema.is(HandlerName);
export const HandlerDescriptors = Schema.Record(Schema.String, HandlerDescriptor).check(
  Schema.makeFilter(
    (handlers) =>
      Object.keys(handlers).every(isHandlerName) ||
      "Handler names must be module.export, one level deep."
  )
);
export type HandlerDescriptors = typeof HandlerDescriptors.Type;

/** Resolve every row descriptor against this manifest, including nested descriptors. */
export const handlerTablesValid = (manifest: {
  readonly tables: Readonly<Record<string, unknown>>;
  readonly handlers?: HandlerDescriptors;
}): true | string => {
  for (const handler of Object.values(manifest.handlers ?? {})) {
    for (const field of Object.values(handler.args)) {
      const problem = schemaProblem(field, handler.kind, "args", true, manifest.tables);
      if (problem !== undefined) return problem;
    }
    const problem = schemaProblem(handler.result, handler.kind, "result", false, manifest.tables);
    if (problem !== undefined) return problem;
  }
  return true;
};
