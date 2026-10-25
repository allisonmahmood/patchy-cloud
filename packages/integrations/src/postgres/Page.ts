import type { Snapshot } from "@patchy/api/postgres-snapshot";
import { escapeAttribute } from "@patchy/core";
import * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";

/** What the connections pages say about Postgres; the layout around it is every integration's. */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "postgres" }>;

export const integration = { key: "postgres", label: "Postgres" } as const;
export const offer = {
  integration,
  reads: "Queries against your own database, through a role you supply.",
  mode: "Company-wide · read-only"
};
export const actions = {
  refresh: "Refresh schema",
  rotate: "Replace credentials",
  retarget: "Point elsewhere"
};

export const source = (connection: Connection) =>
  `${connection.display.database} on ${connection.display.host}`;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  ["Host", `${connection.display.host}:${connection.display.port}`],
  ["Database", connection.display.database],
  ["Role", connection.display.role]
];

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

export const connectIntro =
  "Nothing is saved until Patchy has tested the connection and found its schema.";

/** What to have in hand first, so the form is one paste for whoever holds the database's keys. */
export const walkthrough: View.Walkthrough = {
  before: [
    {
      title: "Get a read-only role",
      text: "Ask whoever runs the database for a role that reads only what patches need. Superusers and roles with CREATEDB or CREATEROLE are refused."
    }
  ],
  current: "Paste its connection string",
  after: [
    {
      title: "Use it in a patch",
      text: "Ask your agent to add it to a patch by its name, such as postgres/warehouse."
    }
  ]
};

/** The access note sits with the credentials field: it is about the role inside that string. */
const promise = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member can query this database through any patch that declares it, as the role you supply.</p><p>Reads are constrained, but a SELECT can still call functions and extensions, so arbitrary SQL isn't guaranteed harmless. Supply a dedicated, least-privileged role.</p></div>`;
const credentialsField = (refusal: View.Notice | undefined, note = "") => {
  const field = View.fieldNote(
    "connection-credentials",
    "credentials",
    "With a password and sslmode=verify-full, for a database reachable from the internet. Patchy encrypts it and never shows it again.",
    refusal
  );
  return `${note}<label class="field-label" for="connection-credentials">Connection string</label><input class="field" id="connection-credentials" type="password" name="credentials" required autocomplete="new-password" spellcheck="false"${field.attributes}>${field.note}`;
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

/** The connect form's fields; a refused submit keeps the handle and description, never credentials. */
export const connectFields = (
  submitted: Readonly<Record<string, string | undefined>>,
  refusal?: View.Notice
) => {
  const handle = View.fieldNote(
    "connection-handle",
    "handle",
    "3–32 lowercase letters, digits or hyphens. Patches use this name, which can't be changed later.",
    refusal
  );
  const description = View.fieldNote(
    "connection-description",
    "description",
    "One line on what this database is for, so builders pick the right one.",
    refusal
  );
  return `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">postgres/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}${credentialsField(refusal, promise)}`;
};

export const rotate = {
  title: (name: string) => `Replace credentials for ${name}`,
  consequence:
    "Patchy tests the new credentials against the same database before saving them. The connection keeps its identity and what patches can read, but a different role changes what every declaring patch can reach. To use another database, point it elsewhere instead.",
  fields: (_submitted: Readonly<Record<string, string | undefined>>, refusal?: View.Notice) =>
    credentialsField(refusal)
};
export const retarget = {
  title: (name: string) => `Point ${name} elsewhere`,
  consequence:
    "Patchy tests the new destination and discovers its schema before switching. Every declaring patch then reads the new database through the schema it was published with, until it is refreshed and published again. A disconnected connection stays disconnected.",
  fields: (_submitted: Readonly<Record<string, string | undefined>>, refusal?: View.Notice) =>
    credentialsField(refusal, promise)
};
