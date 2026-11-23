import { notionPropertyType, type NotionDeclaration, type NotionSnapshot } from "@patchy/api";
import * as Schema from "effect/Schema";

const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const object = (fields: readonly (readonly [string, string])[], indent: string): string =>
  fields.length === 0
    ? "{}"
    : `{\n${fields.map(([name, type]) => `${indent}  readonly ${quote(name)}: ${type};`).join("\n")}\n${indent}}`;

type DataSource = NotionSnapshot["dataSources"][number];
/** What a write takes for each writable type; options come from the snapshot. */
const writeTypes: Readonly<Record<string, string>> = {
  title: "string",
  rich_text: "string",
  number: "number | null",
  date: "{ readonly start: string; readonly end?: string | null } | null",
  checkbox: "boolean",
  url: "string | null",
  email: "string | null",
  phone_number: "string | null",
  people: "readonly string[]",
  relation: "readonly string[]"
};
const writableType = ({ type, options }: DataSource["properties"][number]): string | undefined => {
  if (type === "select" || type === "status" || type === "multi_select") {
    const names = options?.map(({ name }) => quote(name)).join(" | ") || "never";
    return type === "multi_select" ? `readonly (${names})[]` : `${names} | null`;
  }
  return Object.hasOwn(writeTypes, type) ? writeTypes[type] : undefined;
};

const describe = (source: DataSource, access: NotionSnapshot["access"]): string => {
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
    readonly order: ${[...properties.map(({ name }) => name), ...times].map((name) => quote(name)).join(" | ")};${
      access === "write"
        ? `
    readonly writable: ${object(
      source.properties.flatMap((property) => {
        const type = writableType(property);
        return type === undefined ? [] : [[property.name, type]];
      }),
      "    "
    )};`
        : ""
    }
  }`;
};

export const generate = (declaration: typeof NotionDeclaration.Type, snapshot: NotionSnapshot) => {
  const { workspace, access, dataSources, exclusions } = snapshot;
  return {
    client: `// Generated from an immutable Notion snapshot.
import { createNotionClient } from "patchy/client";
import type { Call, NotionClient } from "patchy/client";

export type Sources = ${object(
      dataSources.map((source) => [source.key, describe(source, access)]),
      ""
    )};
export type Client = NotionClient<Sources, "${access}">;

export function createClient(connection: string, call: Call): Client {
  return createNotionClient<Sources, "${access}">(connection, call);
}
`,
    context: `# Notion connection ${declaration.handle}

Use the data source's \`key\` in a Tier 2 action via \`ctx.connections.<alias>\`. Use \`list\` for a page of rows and \`get(id)\` for one row. The connection also exposes \`pages.markdown(id)\`, \`search\` and \`people.list\`. Read \`.agents/skills/patchy-notion/SKILL.md\` before building with this connection.

${
  access === "write"
    ? "Read and write: each data source also has `create(properties)`, `update(id, properties)`, `trash(id)` and `restore(id)`, typed by its `writable` properties. A write sets each property it names whole. Select, multi-select and status take only the options below; a status set to null may go back to its default. Writes notify people and run automations as an edit in Notion does. `patchy dev` simulates them, so later reads don't show them."
    : "Read only: the client has no write methods, and Patchy refuses one forced past its types."
}

Schema and access from snapshot revision ${declaration.revision}. After an admin refreshes the connection, run \`patchy refresh\` to pick up new schema.

\`\`\`json
${json({ workspace, access, dataSources, exclusions })}
\`\`\`
`
  };
};
