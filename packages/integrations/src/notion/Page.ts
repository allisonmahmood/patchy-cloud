import { NotionAccess, type NotionSnapshot } from "@patchy/api";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as ConnectionStore from "../ConnectionStore.js";
import type * as ConnectFrame from "../ConnectFrame.js";
import type * as View from "../ConnectionsView.js";
import * as Fields from "../Fields.js";

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "notion" }>;

export const integration = { key: "notion", label: "Notion", mark: "N" } as const;
export const offer = { integration, line: "Shared databases and pages" };
export const actions: View.Actions = {
  refresh: "Refresh workspace",
  rotate: "Replace token",
  access: "Change access"
};
export const logged = "Recent reads show the operation, data source, and property names.";
export const results = {
  connect: "Notion connected and its data sources discovered.",
  rotate: "Token replaced and the workspace discovered again.",
  refresh: "Workspace refreshed. Run patchy refresh to get its new schema.",
  access: "Access changed. Run patchy refresh to get the new connection revision."
};

export const source = (connection: Connection) => connection.display.workspace.name;
export const credential = (connection: Connection) => ({
  label: "Internal connection token",
  detail: `Stored · ${connection.display.keyHint}`
});
export const allowed = (connection: Connection) =>
  connection.display.access === "write" ? "Read and write" : "Read";
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Workspace", source(connection)],
  ["Access", allowed(connection)]
];

const token: Fields.Spec = {
  kind: "secret",
  name: "key",
  field: "key",
  label: "Internal connection token",
  hint: "Patchy checks the token and discovers data sources before saving. The token is encrypted and never shown again.",
  autocomplete: "new-password",
  maxlength: 512
};
const accessField: Fields.Spec = {
  kind: "select",
  name: "access",
  field: "access",
  label: "Access",
  initial: "read",
  choices: [
    { value: "read", label: "Read" },
    { value: "write", label: "Read and write" }
  ]
};

export const connect: ConnectFrame.ConnectSpec = {
  getIt: {
    title: "Set up an internal connection",
    steps: [
      "As a workspace owner, create an internal connection in the Notion Developer portal.",
      "Enable Read content and Read user information without email. For write access, also enable Insert content and Update content.",
      "Use Add connections on each database in Notion to share it directly with this connection."
    ],
    note: "After sharing more databases, use Refresh workspace. Notion search can take time to find newly shared content."
  },
  paste: { title: "Paste the token", fields: [token] },
  name: { example: "probe", describe: "Tasks and team pages", fields: [accessField] },
  once: {
    reads: "rows in data sources shared with this connection through Tier 2 actions",
    devReads: true,
    cannot: ["Change Notion content"],
    caveat: "Individual Notion permissions don't carry over."
  }
};

export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["notion_not_workspace_key", "key"],
  ["notion_other_workspace", "key"]
]);

export const credentials = (form: Fields.Submitted) => Redacted.make((form.key ?? "").trim());
export const isAccess = Schema.is(NotionAccess);
export const invalidAccess: View.Notice = {
  message: "Choose Read or Read and write.",
  code: "notion_invalid_access",
  status: 422,
  field: "access"
};

export const rotate = {
  title: (name: string) => `Replace the token for ${name}`,
  consequence:
    "Paste the replacement from the same Notion workspace as soon as you reset the token. Requests using a revoked token fail until you replace it. Patchy checks the new token and discovers what it can see before saving it.",
  fields: (submitted: Fields.Submitted, refusal?: View.Notice) =>
    Fields.render(token, submitted, refusal, true),
  shows: ["key"]
} as const;

export const access = {
  title: (name: string) => `Change access for ${name}`,
  consequence:
    "Change what patches may do through this connection. The Notion token stays the same.",
  submit: "Save access",
  initial: (connection: ConnectionStore.Connection) =>
    connection.integration === "notion" ? { access: connection.display.access } : {},
  fields: (submitted: Fields.Submitted, refusal?: View.Notice) =>
    Fields.render(accessField, submitted, refusal),
  shows: ["access"]
} as const;

const entry = (source: NotionSnapshot["dataSources"][number]): View.ReadsEntry => {
  const { databaseTitle, key, properties, title } = source;
  const label =
    databaseTitle === "" || databaseTitle === title ? title : `${title} · ${databaseTitle}`;
  return {
    name: key,
    label: `${label} · ${properties.length} ${properties.length === 1 ? "property" : "properties"}`,
    columns: ["Property", "Type"],
    rows: properties.map((property) => [property.name, property.type.replaceAll("_", " ")])
  };
};

export const reads = (snapshot: NotionSnapshot) =>
  ({
    heading: "Discovered data sources",
    summary:
      snapshot.dataSources.length === 0
        ? "No data sources found. Share a database directly with the connection in Notion, then refresh."
        : `${snapshot.dataSources.length} data ${snapshot.dataSources.length === 1 ? "source" : "sources"}. Search can miss databases shared only through a parent page.`,
    items: [],
    more: 0,
    groups:
      snapshot.dataSources.length === 0
        ? []
        : [
            {
              title: "Schema",
              entries: snapshot.dataSources.slice(0, 10).map(entry),
              ...(snapshot.dataSources.length <= 10
                ? {}
                : {
                    rest: {
                      label: `${snapshot.dataSources.length - 10} more data sources`,
                      entries: snapshot.dataSources.slice(10).map(entry)
                    }
                  })
            }
          ],
    caveats:
      snapshot.exclusions.length === 0
        ? []
        : [
            {
              title: `Left out: ${snapshot.exclusions.length}`,
              lines: snapshot.exclusions.map(
                ({ source, name, reason }) =>
                  `${source} · ${name} (${reason === "unshared_relation" ? "related database isn't shared" : "unsupported type"})`
              )
            }
          ]
  }) satisfies Omit<View.Reads, "revision" | "foundAt">;
