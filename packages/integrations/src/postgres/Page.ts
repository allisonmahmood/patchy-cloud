import type { Snapshot } from "@patchy/api/postgres-snapshot";
import * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import type * as ConnectFrame from "../ConnectFrame.js";
import type * as View from "../ConnectionsView.js";
import * as Fields from "../Fields.js";

/** What the connections pages say about Postgres; the layout around it is every integration's. */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "postgres" }>;

export const integration = { key: "postgres", label: "Postgres", mark: "Pg" } as const;
export const offer = { integration, line: "Your own database, read-only" };
/** What recent calls keep of a Postgres call. */
export const logged =
  "Query text keeps its first 8 KiB; parameters and returned rows are never logged.";
export const actions = {
  refresh: "Refresh schema",
  rotate: "Replace credentials",
  retarget: "Point elsewhere"
};
export const results = {
  reconnect: "Tested and resumed. Its schema revision is unchanged."
};

export const source = (connection: Connection) =>
  `${connection.display.database} on ${connection.display.host}`;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Host", `${connection.display.host}:${connection.display.port}`],
  ["Database", connection.display.database],
  ["Role", connection.display.role]
];
/** What it holds, as Settings names it: the connection string, never shown, and whose role. */
export const credential = (connection: Connection) => ({
  label: "Connection string",
  detail: `Stored · as the role ${connection.display.role}`
});
/** Where it reads, which Point elsewhere changes. */
export const target = (connection: Connection) => ({
  label: "Database",
  value: source(connection)
});

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const SHOWN = 5;

/** "23 tables and 4 views in 2 schemas.", the first relations by name, and what was left out. */
export const reads = (snapshot: typeof Snapshot.Type) => {
  const tables = snapshot.relations.filter((relation) => relation.kind === "table").length;
  const views = snapshot.relations.length - tables;
  const schemas = new Set(snapshot.relations.map((relation) => relation.schema)).size;
  const denied = snapshot.exclusions.filter((exclusion) => exclusion.reason === "access_denied");
  const deniedColumns = denied.filter((exclusion) => exclusion.column !== undefined).length;
  const unreadable = [
    deniedColumns > 0 ? plural(deniedColumns, "column") : null,
    denied.length > deniedColumns ? plural(denied.length - deniedColumns, "relation") : null
  ].filter((part) => part !== null);
  const other = snapshot.exclusions.length - denied.length;
  const found =
    snapshot.relations.length === 0
      ? "No tables or views the role can read."
      : `${[tables > 0 ? plural(tables, "table") : null, views > 0 ? plural(views, "view") : null].filter((part) => part !== null).join(" and ")} in ${plural(schemas, "schema")}.`;
  const left = [
    denied.length === 0
      ? null
      : `${unreadable.join(" and ")} ${denied.length === 1 ? "is" : "are"} left out because the role can't read ${denied.length === 1 ? "it" : "them"}.`,
    other === 0
      ? null
      : `${plural(other, "other item")} ${other === 1 ? "is" : "are"} left out by Patchy's limits or unsupported types.`
  ].filter((part) => part !== null);
  return {
    summary: [found, ...left].join(" "),
    items: snapshot.relations
      .slice(0, SHOWN)
      .map((relation) =>
        relation.schema === "public" ? relation.name : `${relation.schema}.${relation.name}`
      ),
    more: Math.max(0, snapshot.relations.length - SHOWN)
  };
};

/** Refusals about the connection string itself, shown under it rather than atop the page. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map(
  [
    "invalid_credentials",
    "tls_required",
    "public_address_required",
    "superuser_refused",
    "createdb_refused",
    "createrole_refused",
    "connection_retarget_required"
  ].map((code) => [code, "credentials"])
);

/** The pasted connection string, or the form's own refusal when there is none. */
export const credentials = (
  form: Readonly<Record<string, string | undefined>>
): Redacted.Redacted<string> | View.Notice =>
  form.credentials === undefined
    ? {
        message: "Complete the form and submit it again. Connection strings are never redisplayed.",
        code: "invalid_request",
        status: 422
      }
    : Redacted.make(form.credentials);

/** The connection string, as Replace credentials and Point elsewhere ask for it. */
const connectionString: Fields.Spec = {
  kind: "secret",
  name: "credentials",
  field: "credentials",
  label: "Connection string",
  hint: "With a password and sslmode=verify-full, for a database reachable from the internet. Encrypted, and never shown again.",
  autocomplete: "new-password"
};

/** What the connect page asks for, in the shared frame. */
export const connect: ConnectFrame.ConnectSpec = {
  getIt: {
    title: "Get a read-only role",
    steps: [
      "Ask whoever runs the database for a role that reads only what patches need. Patchy refuses superusers and roles that can create databases or roles."
    ]
  },
  paste: { title: "Paste its connection string", fields: [connectionString] },
  name: { example: "warehouse", describe: "Finance warehouse: invoices, projects and hours" },
  once: {
    reads: "this database, as the role you gave",
    devReads: false,
    cannot: ["Nothing is written: every query runs read-only"],
    caveat:
      "A SELECT can still call functions and extensions, so give Patchy a dedicated, least-privileged role."
  }
};

export const rotate = {
  title: (name: string) => `Replace credentials for ${name}`,
  consequence:
    "Patchy tests the new credentials against the same database before saving them. The connection keeps its identity and what patches can read, but a different role changes what every declaring patch can reach. To use another database, point it elsewhere instead.",
  fields: (submitted: Fields.Submitted, refusal?: View.Notice) =>
    Fields.render(connectionString, submitted, refusal, true),
  shows: ["credentials"]
} as const;
export const retarget = {
  title: (name: string) => `Point ${name} elsewhere`,
  consequence:
    "Patchy tests the new destination and discovers its schema before switching. Every declaring patch then reads the new database through the schema it was published with, until it is refreshed and published again. A paused connection stays paused.",
  fields: (submitted: Fields.Submitted, refusal?: View.Notice) =>
    Fields.render(connectionString, submitted, refusal, true),
  shows: ["credentials"]
} as const;
