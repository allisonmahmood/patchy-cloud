import type { HandlerSchema } from "./handlers.js";
import type { ColumnDefinition, TableDefinition } from "./schemas.js";

/** The JSON Schema 2020-12 subset a handler's wire values project onto, for agents. */
export interface JsonSchema {
  readonly type?: "string" | "integer" | "number" | "boolean" | "object" | "array" | "null";
  readonly description?: string;
  readonly format?: "date-time";
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
}

type Tables = Readonly<Record<string, typeof TableDefinition.Type>>;

const int32 = { type: "integer", minimum: -2147483648, maximum: 2147483647 } as const;
const isoTimestamp = { type: "string", format: "date-time" } as const;

const described = (schema: JsonSchema, description: string | undefined): JsonSchema =>
  description === undefined ? schema : { ...schema, description };

const nullable = (schema: JsonSchema): JsonSchema => {
  const { description, ...value } = schema;
  return described({ anyOf: [value, { type: "null" }] }, description);
};

const column = (definition: typeof ColumnDefinition.Type): JsonSchema => {
  switch (definition.kind) {
    case "text":
      return { type: "string" };
    case "integer":
      return int32;
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "timestamp":
      return isoTimestamp;
    case "json":
      return { description: "Any JSON value." };
    case "member":
      return { type: "string", description: "A company member's user id." };
    case "ref":
      return { type: "string", description: `The id of a row in ${definition.table}.` };
  }
};

/** A stored row: its system columns, then every defined column; optional columns may be null. */
const row = (name: string, tables: Tables): JsonSchema => {
  const table = tables[name];
  if (table === undefined) return { type: "object", description: `A row of ${name}.` };
  const properties: Record<string, JsonSchema> = {
    id: { type: "string", description: "The row's id." },
    createdAt: isoTimestamp,
    updatedAt: isoTimestamp
  };
  for (const [field, definition] of Object.entries(table.columns))
    properties[field] =
      definition.optional === true ? nullable(column(definition)) : column(definition);
  return {
    type: "object",
    description: `A row of ${name}: ${table.description}`,
    properties,
    required: Object.keys(properties),
    additionalProperties: false
  };
};

/** One handler value as JSON Schema, keeping the builder's descriptions. */
export const handlerJsonSchema = (schema: HandlerSchema, tables: Tables): JsonSchema => {
  switch (schema.kind) {
    case "text":
      return described({ type: "string" }, schema.description);
    case "integer":
      return described(int32, schema.description);
    case "number":
      return described({ type: "number" }, schema.description);
    case "boolean":
      return described({ type: "boolean" }, schema.description);
    case "timestamp":
      return described(isoTimestamp, schema.description);
    case "json":
      return { description: schema.description ?? "Any JSON value." };
    case "object":
      return described(handlerFieldsJsonSchema(schema.fields, tables), schema.description);
    case "array":
      return described(
        { type: "array", items: handlerJsonSchema(schema.element, tables) },
        schema.description
      );
    case "enum":
      return described({ type: "string", enum: schema.values }, schema.description);
    case "nullable":
      return described(nullable(handlerJsonSchema(schema.value, tables)), schema.description);
    case "row": {
      const stored = row(schema.table, tables);
      return schema.description === undefined
        ? stored
        : { ...stored, description: schema.description };
    }
    // Agent tools refuse both at publish; a page handler never reaches an agent.
    case "fileHandle":
    case "upload":
      return described({ type: "string" }, schema.description);
  }
};

/** A handler's argument record, or an object schema's fields, as one closed JSON object. */
export const handlerFieldsJsonSchema = (
  fields: Readonly<Record<string, HandlerSchema>>,
  tables: Tables
): JsonSchema => ({
  type: "object",
  properties: Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, handlerJsonSchema(field, tables)])
  ),
  required: Object.entries(fields)
    .filter(([, field]) => field.optional !== true)
    .map(([name]) => name),
  additionalProperties: false
});
