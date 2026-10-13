import type { Snapshot } from "@patchy/api/postgres-snapshot";
import { escapeAttribute } from "@patchy/core";
import type * as ConnectionStore from "../ConnectionStore.js";

/** What the connections pages say about Postgres; the layout around it is every integration's. */

export const integration = { key: "postgres", label: "Postgres" } as const;
export const offer = {
  integration,
  reads: "A database reachable over TLS: read-only queries through a role you supply.",
  mode: "Company-wide · read-only"
};
export const actions = {
  refresh: "Refresh schema",
  rotate: "Replace credentials",
  retarget: "Point elsewhere"
};

export const source = (connection: ConnectionStore.Connection) =>
  `${connection.display.database} on ${connection.display.host}`;
export const facts = (
  connection: ConnectionStore.Connection
): ReadonlyArray<readonly [string, string]> => [
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
  "Patchy tests the connection and discovers its schema before saving anything. The database must be reachable from the internet over TLS with a verified certificate and hostname; superusers and roles with CREATEDB or CREATEROLE are refused.";

/** The access note sits with the credentials field: it is about the role inside that string. */
const promise = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member can query this database through any patch that declares it, as the role you supply.</p><p>Patchy sends constrained reads through the role you supplied, but a SELECT can still invoke functions and extensions, so this is not a promise that arbitrary SQL is harmless. Supply a dedicated, least-privileged role.</p></div>`;
const credentials = (note = "") =>
  `${note}<label class="field-label" for="connection-credentials">Connection string</label><input class="field" id="connection-credentials" type="password" name="credentials" required autocomplete="new-password" spellcheck="false" aria-describedby="connection-credentials-hint"><p id="connection-credentials-hint" class="field-hint">A Postgres connection string with a password and sslmode=verify-full. Only host, port, database, user, password and sslmode are accepted. Credentials are encrypted and never shown again.</p>`;

/** The connect form's fields; a refused submit keeps the handle and description, never credentials. */
export const connectFields = (submitted: {
  readonly handle?: string;
  readonly description?: string;
}) =>
  `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">postgres/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="connection-handle-hint"></div><p id="connection-handle-hint" class="field-hint">3–32 lowercase letters, digits or hyphens, with no leading or trailing hyphen. Patches declare it by this name, which can't be changed later.</p><label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}" aria-describedby="connection-description-hint"><p id="connection-description-hint" class="field-hint">One line telling builders what this database is for. With many connections, it's how people find the right one.</p>${credentials(promise)}`;

export const rotate = {
  title: (name: string) => `Replace credentials for ${name}`,
  consequence:
    "Patchy tests the new credentials against the same database before saving them. The connection keeps its identity and what patches can read, but a different role changes what every declaring patch can reach. To use another database, point it elsewhere instead.",
  fields: credentials()
};
export const retarget = {
  title: (name: string) => `Point ${name} elsewhere`,
  consequence:
    "Patchy tests the new destination and discovers its schema before switching. Every declaring patch then reads the new database through the schema it was published with, until it is refreshed and published again. A disconnected connection stays disconnected.",
  fields: credentials(promise)
};
