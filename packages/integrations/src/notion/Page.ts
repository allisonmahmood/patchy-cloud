import { NotionAccess, type NotionSnapshot } from "@patchy/api";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as ConnectionStore from "../ConnectionStore.js";
import type * as ConnectFrame from "../ConnectFrame.js";
import type * as View from "../ConnectionsView.js";
import * as Fields from "../Fields.js";
import * as Source from "./Source.js";

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "notion" }>;

export const integration = { key: "notion", label: "Notion", mark: "N" } as const;
export const offer = { integration, line: "Shared databases and pages" };
export const actions: View.Actions = {
  refresh: "Refresh workspace",
  rotate: "Replace token",
  access: "Change access"
};
export const logged =
  "Each call keeps the data source, property names and page id it named, and how many rows came back; filter values, search text, row values and page text are never logged.";
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
  hint: "Encrypted, and never shown again. Patchy checks it and reads the shared databases' schemas before saving.",
  autocomplete: "new-password",
  maxlength: 512
};
const accessField: Fields.Spec = {
  kind: "select",
  name: "access",
  field: "access",
  label: "Access",
  hint: "Read and write lets patches add, change and trash rows.",
  initial: "read",
  width: "sm",
  choices: [
    { value: "read", label: "Read" },
    { value: "write", label: "Read and write" }
  ]
};

/** What the connect page asks for, in the shared frame, of a Notion workspace owner. */
export const connect: ConnectFrame.ConnectSpec = {
  getIt: {
    title: "Make an internal connection",
    steps: [
      "In Notion's Developer portal, a workspace owner creates an internal connection with these capabilities, then shares each database patches should use with it, through Add connections. Patches see only what is shared with it."
    ],
    table: {
      head: ["Capability", "Set to"],
      rows: [
        ["Read content", "On"],
        ["Read user information", "Without email addresses"],
        ["Insert content, Update content", "On for Read and write, otherwise off"]
      ]
    },
    note: "Shared something later? Press Refresh workspace on the connection's page, and again if Notion hasn't listed it yet."
  },
  paste: { title: "Paste the token", fields: [token, accessField] },
  name: { example: "tasks", describe: "Tasks, projects and the team wiki" },
  once: {
    reads: "everything shared with this connection",
    devReads: true,
    also: ["With Read and write, those patches add, change and trash rows"],
    cannot: [
      "Nothing is written while a patch is being built",
      "Page text, comments and files are never changed"
    ],
    caveat:
      "A write is an ordinary Notion edit: it notifies people and runs automations and webhooks, and trashing a row doesn't undo those. Notion's own page permissions don't carry over."
  }
};

export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["notion_not_workspace_key", "key"],
  ["notion_other_workspace", "key"]
]);

const isAccess = Schema.is(NotionAccess);
const invalidAccess: View.Notice = {
  message: "Choose Read or Read and write.",
  code: "notion_invalid_access",
  status: 422,
  field: "access"
};

/**
 * What an admin submitted as one secret, or the refusal at the field that stops it: connect takes
 * the token and the access, Replace token only a token, Change access only the access.
 */
export const credentials = (
  form: Fields.Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  if (current !== undefined && form.key === undefined)
    return isAccess(form.access) ? Source.changeSecret({ access: form.access }) : invalidAccess;
  const key = (form.key ?? "").trim();
  if (current !== undefined) return Source.changeSecret({ key });
  return isAccess(form.access) ? Source.connectSecret({ key, access: form.access }) : invalidAccess;
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
