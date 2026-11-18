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

export const NotionRow = Schema.Struct({
  id: NotionId,
  url: Schema.String,
  createdTime: Schema.String,
  lastEditedTime: Schema.String,
  inTrash: Schema.Boolean,
  properties: Schema.Record(Name, Schema.Json)
});
export type NotionRow = typeof NotionRow.Type;

const pagination = {
  limit: Schema.optionalKey(NotionLimit),
  cursor: Schema.optionalKey(NotionCursor)
};
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
  ...pagination
};
const cursor = Schema.NullOr(NotionCursor);
const SearchKind = Schema.Literals(["page", "data_source"]);
const read = <const Name extends string, F extends Schema.Struct.Fields, O extends Schema.Top>(
  name: Name,
  input: Schema.Struct<F>,
  output: O
) => {
  const op = `notion.${name}` as const;
  const guest = Schema.Struct({ connection: DefinitionName, ...input.fields });
  return {
    op,
    input,
    guest,
    output,
    operation: {
      request: Schema.Struct({ op: Schema.Literal(op), args: guest }),
      response: output,
      kind: "integration"
    }
  } as const;
};
export const notionReads = {
  listRows: read(
    "listRows",
    Schema.Struct(listFields),
    Schema.Struct({ rows: Schema.Array(NotionRow), cursor })
  ),
  getRow: read("getRow", Schema.Struct({ source: Name, id: NotionId }), Schema.NullOr(NotionRow)),
  markdown: read(
    "markdown",
    Schema.Struct({ id: NotionId }),
    Schema.NullOr(
      Schema.Struct({
        id: NotionId,
        title: Schema.String,
        url: Schema.String,
        markdown: Schema.String,
        truncated: Schema.Boolean
      })
    )
  ),
  search: read(
    "search",
    Schema.Struct({
      text: Schema.optionalKey(Text),
      kind: Schema.optionalKey(SearchKind),
      ...pagination
    }),
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          kind: SearchKind,
          id: NotionId,
          title: Schema.String,
          url: Schema.String,
          lastEditedTime: Schema.String,
          dataSource: Schema.optionalKey(Name)
        })
      ),
      cursor
    })
  ),
  listPeople: read(
    "listPeople",
    Schema.Struct(pagination),
    Schema.Struct({
      people: Schema.Array(
        Schema.Struct({
          id: NotionId,
          name: Schema.NullOr(Schema.String),
          type: Schema.Literals(["person", "bot"])
        })
      ),
      cursor
    })
  )
};
export type NotionRead = keyof typeof notionReads;
export type NotionListInput = typeof notionReads.listRows.input.Type;
export type NotionListOutput = typeof notionReads.listRows.output.Type;
export type NotionGetInput = typeof notionReads.getRow.input.Type;
export type NotionGetOutput = typeof notionReads.getRow.output.Type;
export type NotionMarkdownInput = typeof notionReads.markdown.input.Type;
export type NotionMarkdownOutput = typeof notionReads.markdown.output.Type;
export type NotionSearchInput = typeof notionReads.search.input.Type;
export type NotionSearchOutput = typeof notionReads.search.output.Type;
export type NotionPeopleInput = typeof notionReads.listPeople.input.Type;
export type NotionPeopleOutput = typeof notionReads.listPeople.output.Type;
export const notionOperations = {
  [notionReads.listRows.op]: notionReads.listRows.operation,
  [notionReads.getRow.op]: notionReads.getRow.operation,
  [notionReads.markdown.op]: notionReads.markdown.operation,
  [notionReads.search.op]: notionReads.search.operation,
  [notionReads.listPeople.op]: notionReads.listPeople.operation
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
