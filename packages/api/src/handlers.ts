import * as Schema from "effect/Schema";

export const HandlerKind = Schema.Literals(["query", "mutation", "action"]);
export type HandlerKind = typeof HandlerKind.Type;

const moduleNamePattern = "[a-zA-Z_$][a-zA-Z0-9_$-]*";
const moduleName = new RegExp(`^${moduleNamePattern}$`);
const handlerName = new RegExp(`^${moduleNamePattern}\\.[a-zA-Z_$][a-zA-Z0-9_$]*$`);

/** One server/*.ts filename stem, without an extension or directory traversal. */
export const HandlerModuleName = Schema.String.check(
  Schema.makeFilter((name) => moduleName.test(name) || "Invalid server module name.")
);

/** One server module and one named export, without directory traversal. */
export const HandlerName = Schema.String.check(
  Schema.makeFilter(
    (name) => handlerName.test(name) || "Handler names must be module.export, one level deep."
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
) & { readonly optional?: true; readonly description?: string };

/** Readers accept any description; where descriptors are built checks their length. */
const description = Schema.optionalKey(Schema.String);
const modifiers = { optional: Schema.optionalKey(Schema.Literal(true)), description };
// Preserve only `default` for the check; other unknown keys retain normal parser behavior.
// A pattern-keyed rest schema keeps this forbidden key out of the declared wire properties.
const forbiddenDefault = Schema.Record(
  Schema.String.check(Schema.isPattern(/^default$/)),
  Schema.Unknown
);
const node = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [forbiddenDefault]).check(
    Schema.makeFilter(
      (value) => !Object.hasOwn(value, "default") || "Defaults are allowed only on table columns."
    )
  );
const fields = <S extends Schema.Top>(value: S) =>
  Schema.Record(Schema.String, value).check(
    Schema.makeFilter(
      (record) =>
        Object.keys(record).every((name) => name.length > 0) || "Field names must not be empty."
    )
  );

export const HandlerSchema: Schema.Codec<HandlerSchema> = Schema.suspend(() =>
  Schema.Union([
    node({
      kind: Schema.Literals(["text", "integer", "number", "boolean", "timestamp", "json"]),
      ...modifiers
    }),
    node({
      kind: Schema.Literal("object"),
      fields: fields(HandlerSchema),
      ...modifiers
    }),
    node({ kind: Schema.Literal("array"), element: HandlerSchema, ...modifiers }),
    node({
      kind: Schema.Literal("enum"),
      values: Schema.Array(Schema.String).check(
        Schema.isMinLength(1),
        Schema.makeFilter(
          (values) => new Set(values).size === values.length || "Enum values must be distinct."
        )
      ),
      ...modifiers
    }),
    node({ kind: Schema.Literal("nullable"), value: HandlerSchema, ...modifiers }),
    node({
      kind: Schema.Literal("row"),
      table: Schema.String.check(
        Schema.makeFilter(
          (name) => /^[a-z][a-zA-Z0-9]{0,62}$/.test(name) || "Invalid row table name."
        )
      ),
      ...modifiers
    }),
    node({ kind: Schema.Literals(["fileHandle", "upload"]), ...modifiers })
  ])
).annotate({ identifier: "HandlerSchema" });

const schemaProblem = (
  schema: HandlerSchema,
  kind: HandlerKind,
  position: "args" | "result",
  field: boolean
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
        const problem = schemaProblem(child, kind, position, true);
        if (problem !== undefined) return problem;
      }
      return undefined;
    case "array":
      return schemaProblem(schema.element, kind, position, false);
    case "nullable":
      return schemaProblem(schema.value, kind, position, false);
    default:
      return undefined;
  }
};

/**
 * One handler's contract. An action marked `readOnly` is held to reads by the runtime. A handler
 * built from a patch's `agent/` folder is marked `agentTool`, and only agents may call it. Absent
 * marks are omitted, never written as false.
 */
export const HandlerDescriptor = Schema.Struct({
  kind: HandlerKind,
  description,
  readOnly: Schema.optionalKey(Schema.Literal(true)),
  agentTool: Schema.optionalKey(Schema.Literal(true)),
  args: fields(HandlerSchema),
  result: HandlerSchema,
  errors: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1))))
}).check(
  Schema.makeFilter((handler) => {
    if (handler.readOnly === true && handler.kind !== "action")
      return "Only actions may be read-only.";
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
  ),
  // The build folds agent/ into the one module named agent.
  Schema.makeFilter(
    (handlers) =>
      Object.entries(handlers).every(
        ([name, handler]) => handler.agentTool !== true || name.startsWith("agent.")
      ) || "Only agent.* handlers may be agent tools."
  )
);
export type HandlerDescriptors = typeof HandlerDescriptors.Type;

/** The most Unicode code points a handler or value description may have. */
export const descriptionLimit = 2_000;

/** A description that breaks the rule: where it is, and whether it is blank or too long. */
export const DescriptionProblem = Schema.Struct({
  /** The handler, `module.export`. */
  handler: Schema.String,
  /** The value's path, such as `args.filter.ids[]`; absent for the handler's own description. */
  value: Schema.optionalKey(Schema.String),
  violation: Schema.Literals(["blank", "long"]),
  /** In code points. */
  length: Schema.Number
});
export type DescriptionProblem = typeof DescriptionProblem.Type;

const violation = (text: string) => {
  const length = [...text].length;
  if (text.trim() === "") return { violation: "blank" as const, length };
  return length > descriptionLimit ? { violation: "long" as const, length } : undefined;
};

const valueProblem = (
  schema: HandlerSchema,
  handler: string,
  value: string
): DescriptionProblem | undefined => {
  const own = schema.description === undefined ? undefined : violation(schema.description);
  if (own !== undefined) return { handler, value, ...own };
  switch (schema.kind) {
    case "object":
      for (const [name, field] of Object.entries(schema.fields)) {
        const problem = valueProblem(field, handler, `${value}.${name}`);
        if (problem !== undefined) return problem;
      }
      return undefined;
    case "array":
      return valueProblem(schema.element, handler, `${value}[]`);
    case "nullable":
      return valueProblem(schema.value, handler, value);
    default:
      return undefined;
  }
};

/**
 * The first description that breaks the rule, nonblank and at most 2,000 code points. Readers
 * accept any description, so the CLI's build and the instance's publish run this on the
 * descriptors they inspect.
 */
export const descriptionProblem = (
  handlers: HandlerDescriptors
): DescriptionProblem | undefined => {
  for (const [handler, descriptor] of Object.entries(handlers)) {
    const own =
      descriptor.description === undefined ? undefined : violation(descriptor.description);
    if (own !== undefined) return { handler, ...own };
    for (const [field, schema] of Object.entries(descriptor.args)) {
      const problem = valueProblem(schema, handler, `args.${field}`);
      if (problem !== undefined) return problem;
    }
    const problem = valueProblem(descriptor.result, handler, "result");
    if (problem !== undefined) return problem;
  }
  return undefined;
};

/** What a description problem says: the handler, the value and how to fix it. */
export const descriptionRefusal = (problem: DescriptionProblem): string => {
  const what =
    problem.value === undefined
      ? `${problem.handler}'s description`
      : `${problem.handler}'s description of ${problem.value}`;
  if (problem.violation === "blank")
    return `${what} is blank. ${problem.value === undefined ? "Say what it does, or leave the description out." : "Say what it holds, or remove its .describe()."}`;
  return `${what} is ${problem.length.toLocaleString("en-US")} characters; descriptions are at most ${descriptionLimit.toLocaleString("en-US")}. Shorten it.`;
};

export const handlerKinds = (
  handlers: HandlerDescriptors | undefined
): Readonly<Record<string, HandlerKind>> =>
  Object.fromEntries(
    Object.entries(handlers ?? {}).map(([name, descriptor]) => [name, descriptor.kind])
  );

/** An agent tool's name: its export, the handler name after `agent.`. */
export const agentToolName = (handler: string) => handler.slice("agent.".length);

/**
 * Each value in a handler's arguments and result, outermost first, at its path such as
 * `args.filter.ids[]`. A nullable value shares its wrapper's path.
 */
export function* handlerValues(
  descriptor: Pick<HandlerDescriptor, "args" | "result">
): Generator<{ readonly path: string; readonly schema: HandlerSchema }> {
  function* walk(
    schema: HandlerSchema,
    path: string
  ): Generator<{ readonly path: string; readonly schema: HandlerSchema }> {
    yield { path, schema };
    switch (schema.kind) {
      case "object":
        for (const [name, field] of Object.entries(schema.fields))
          yield* walk(field, `${path}.${name}`);
        return;
      case "array":
        return yield* walk(schema.element, `${path}[]`);
      case "nullable":
        return yield* walk(schema.value, path);
    }
  }
  for (const [name, field] of Object.entries(descriptor.args)) yield* walk(field, `args.${name}`);
  yield* walk(descriptor.result, "result");
}

/** What a row naming a table its patch doesn't define says, naming the handler or tool. */
export const unknownRowRefusal = (name: string, value: string, table: string) =>
  `${name}'s ${value} is t.row("${table}"), but this patch defines no table ${table}. Define the table in patchy.config.ts, or name one it defines.`;

/**
 * Resolve every row descriptor against this manifest, including nested descriptors. The
 * refusal names an agent tool by its tool name and any other handler by `module.export`.
 */
export const handlerTablesValid = (manifest: {
  readonly tables: Readonly<Record<string, unknown>>;
  readonly handlers?: HandlerDescriptors;
}): true | string => {
  for (const [name, handler] of Object.entries(manifest.handlers ?? {}))
    for (const { path, schema } of handlerValues(handler))
      if (schema.kind === "row" && !Object.hasOwn(manifest.tables, schema.table))
        return unknownRowRefusal(
          handler.agentTool === true ? agentToolName(name) : name,
          path,
          schema.table
        );
  return true;
};
