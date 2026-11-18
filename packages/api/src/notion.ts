import * as Schema from "effect/Schema";
import { DefinitionName } from "./schemas.js";

const Name = Schema.String.check(Schema.isBetweenLength(1, 512));
const Text = Schema.String.check(Schema.isMaxLength(2000));
const Numeric = Schema.Number.check(Schema.isFinite());
const Bound = Schema.Union([Numeric, Text]);
const Value = Schema.Union([Bound, Schema.Boolean, Schema.Null]);
export const NotionLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
export const NotionCursor = Schema.String.check(Schema.isBetweenLength(1, 4096));
export const NotionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
);

const listFields = {
  source: Name,
  eq: Schema.optionalKey(Schema.Record(Name, Value)),
  contains: Schema.optionalKey(Schema.Record(Name, Text)),
  range: Schema.optionalKey(
    Schema.Struct({
      property: Name,
      gt: Schema.optionalKey(Bound),
      gte: Schema.optionalKey(Bound),
      lt: Schema.optionalKey(Bound),
      lte: Schema.optionalKey(Bound)
    })
  ),
  orderBy: Schema.optionalKey(
    Schema.Struct({
      property: Name,
      direction: Schema.optionalKey(Schema.Literals(["asc", "desc"]))
    })
  ),
  select: Schema.optionalKey(Schema.Array(Name).check(Schema.isBetweenLength(1, 200))),
  limit: Schema.optionalKey(NotionLimit),
  cursor: Schema.optionalKey(NotionCursor)
};
export const NotionRow = Schema.Struct({
  id: NotionId,
  url: Schema.String,
  createdTime: Schema.String,
  lastEditedTime: Schema.String,
  inTrash: Schema.Boolean,
  properties: Schema.Record(Name, Schema.Json)
});
export type NotionRow = typeof NotionRow.Type;

export const notionReads = {
  listRows: {
    input: Schema.Struct(listFields),
    output: Schema.Struct({ rows: Schema.Array(NotionRow), cursor: Schema.NullOr(NotionCursor) })
  }
} as const;
export type NotionListInput = typeof notionReads.listRows.input.Type;
export type NotionListOutput = typeof notionReads.listRows.output.Type;
export const NotionListRows = Schema.Struct({ connection: DefinitionName, ...listFields });

export const notionOperations = {
  "notion.listRows": {
    request: Schema.Struct({ op: Schema.Literal("notion.listRows"), args: NotionListRows }),
    response: notionReads.listRows.output,
    kind: "integration"
  }
} as const;

interface PropertyType {
  readonly output: string;
  readonly eq?: "string" | "number" | "boolean";
  readonly contains?: true;
  readonly range?: "string" | "number";
}
const text = { output: "string | null", eq: "string" } as const;
const actor = "{ readonly id: string; readonly name: string | null }";
/** Filter capabilities and generated values for the property types Patchy reads. */
export const notionPropertyTypes = {
  title: { ...text, contains: true },
  rich_text: { ...text, contains: true },
  number: { output: "number | null", eq: "number", range: "number" },
  select: text,
  status: text,
  multi_select: { output: "readonly string[]", contains: true },
  date: {
    output: "{ readonly start: string; readonly end: string | null } | null",
    eq: "string",
    range: "string"
  },
  checkbox: { output: "boolean", eq: "boolean" },
  url: text,
  email: text,
  phone_number: text,
  people: { output: `readonly ${actor}[]`, contains: true },
  relation: { output: "readonly string[]", contains: true },
  files: { output: "readonly string[]" },
  created_time: { output: "string", range: "string" },
  created_by: { output: actor },
  last_edited_time: { output: "string", range: "string" },
  last_edited_by: { output: actor },
  unique_id: { output: "string | null" }
} as const satisfies Readonly<Record<string, PropertyType>>;
const propertyTypes: Readonly<Record<string, PropertyType>> = notionPropertyTypes;
export const notionPropertyType = (type: string): PropertyType | undefined =>
  Object.hasOwn(propertyTypes, type) ? propertyTypes[type] : undefined;
