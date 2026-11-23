import * as Schema from "effect/Schema";

export const NotionAccess = Schema.Literals(["read", "write"]);
export type NotionAccess = typeof NotionAccess.Type;

const Option = Schema.Struct({ id: Schema.String, name: Schema.String });
const Property = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  options: Schema.optionalKey(Schema.Array(Option)),
  groups: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...Option.fields,
        optionIds: Schema.Array(Schema.String)
      })
    )
  ),
  relationTarget: Schema.optionalKey(Schema.String)
});

/** Connection identity and discovered schema. No credentials, rows, or page text. */
export const NotionSnapshot = Schema.Struct({
  workspace: Schema.Struct({ id: Schema.String, name: Schema.String }),
  botId: Schema.String,
  access: NotionAccess,
  dataSources: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      title: Schema.String,
      url: Schema.String,
      databaseTitle: Schema.String,
      properties: Schema.Array(Property)
    })
  ),
  exclusions: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      name: Schema.String,
      reason: Schema.Literals(["unsupported_type", "unshared_relation"])
    })
  )
});
export type NotionSnapshot = typeof NotionSnapshot.Type;
