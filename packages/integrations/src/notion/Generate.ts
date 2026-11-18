import { notionPropertyType, type NotionDeclaration, type NotionSnapshot } from "@patchy/api";
import * as Schema from "effect/Schema";

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const object = (fields: readonly (readonly [string, string])[], indent: string): string =>
  fields.length === 0
    ? "{}"
    : `{\n${fields.map(([name, type]) => `${indent}  readonly ${quote(name)}: ${type};`).join("\n")}\n${indent}}`;

const describe = (source: NotionSnapshot["dataSources"][number]): string => {
  const properties = source.properties.flatMap(({ name, type }) => {
    const descriptor = notionPropertyType(type);
    return descriptor ? [{ name, ...descriptor }] : [];
  });
  const times = ["createdTime", "lastEditedTime"].filter(
    (name) => !source.properties.some((property) => property.name === name)
  );
  return `{
    readonly values: ${object(
      properties.map(({ name, output }) => [name, output]),
      "    "
    )};
    readonly eq: ${object(
      properties.flatMap(({ name, eq }) =>
        eq === undefined ? [] : [[name, eq === "boolean" ? eq : `${eq} | null`]]
      ),
      "    "
    )};
    readonly contains: ${object(
      properties.flatMap(({ name, contains }) => (contains ? [[name, "string"]] : [])),
      "    "
    )};
    readonly range: ${object(
      [
        ...properties.flatMap(({ name, range }) =>
          range === undefined ? [] : [[name, range] as const]
        ),
        ...times.map((name) => [name, "string"] as const)
      ],
      "    "
    )};
    readonly order: ${[...properties.map(({ name }) => name), ...times].map((name) => quote(name)).join(" | ")};
  }`;
};

export const generate = (declaration: typeof NotionDeclaration.Type, snapshot: NotionSnapshot) => {
  const { workspace, access, dataSources, exclusions } = snapshot;
  return {
    client: `// Generated from an immutable Notion snapshot.
import { createNotionClient } from "patchy/client";
import type { Call, NotionClient } from "patchy/client";

export type Sources = ${object(
      dataSources.map((source) => [source.key, describe(source)]),
      ""
    )};
export type Client = NotionClient<Sources>;

export function createClient(connection: string, call: Call): Client {
  return createNotionClient<Sources>(connection, call);
}
`,
    context: `# Notion connection ${declaration.handle}

Use the data source's \`key\` in a Tier 2 action via \`ctx.connections.<alias>\`. Its \`list\` returns rows and a cursor. Read \`.agents/skills/patchy-notion/SKILL.md\` before building with this connection.

Schema and access from snapshot revision ${declaration.revision}. After an admin refreshes the connection, run \`patchy refresh\` to pick up new schema.

\`\`\`json
${json({ workspace, access, dataSources, exclusions })}
\`\`\`
`
  };
};
