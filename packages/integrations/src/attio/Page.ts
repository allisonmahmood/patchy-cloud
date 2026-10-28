import type { AttioAttribute, AttioExclusion, AttioSnapshot } from "@patchy/api";
import { ago, escapeAttribute, escapeHtml } from "@patchy/core";
import * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Source from "./Source.js";

/**
 * What the connections pages say about Attio; the layout around it is every integration's. The
 * connect page is the shared form inside a walkthrough, one submit: the key check refuses within
 * a second, then discovery reads the workspace. The connection page opens with what discovery
 * skipped and left out, then each object and list as a counted row that opens to its attributes.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "attio" }>;

export const integration = { key: "attio", label: "Attio" } as const;
export const offer = {
  integration,
  reads: "A workspace's objects, lists and members, read-only.",
  mode: "Company-wide · read-only"
};
export const actions: View.Actions = { refresh: "Refresh workspace", rotate: "Replace key" };
export const results = {
  connect: "Attio connected and its workspace discovered.",
  rotate: (connection: ConnectionStore.Connection) =>
    connection.status === "connected"
      ? "Key replaced and the workspace discovered again. Existing patches keep what they were published with."
      : "Key replaced and the workspace discovered again. The connection stays disconnected until you Reconnect.",
  refresh:
    "Workspace refreshed. Existing patches keep their pinned shape; regenerate before publishing against the new one.",
  reconnect: "Key checked and the connection reconnected. Its snapshot revision is unchanged."
};

const workspace = (connection: Connection) =>
  `${connection.display.workspace.name} (${connection.display.workspace.slug})`;
const named = (scopes: ReadonlyArray<string>) => {
  const names = [...new Set(scopes.map(Source.scopeName))];
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
};
/** The key's read scopes by Attio's names: the ones Patchy needs in its order, then the rest. */
const reading = (scopes: ReadonlyArray<string>) => {
  const needed: ReadonlyArray<string> = Source.requiredScopes;
  return [
    ...new Set([
      ...needed.filter((scope) => scopes.includes(scope)).map(Source.scopeName),
      ...scopes
        .filter((scope) => !needed.includes(scope))
        .map(Source.scopeName)
        .sort()
    ])
  ].join(", ");
};

export const source = (connection: Connection) => connection.display.workspace.name;
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => {
  const writable = connection.display.writable;
  return [
    ["Workspace", workspace(connection)],
    ["Key", connection.display.keyHint],
    [
      "Key reads",
      `${reading(connection.display.scopes)}${writable === undefined ? "" : `; ${named(writable.scopes)} ${writable.scopes.length === 1 ? "is" : "are"} Read-write`}`
    ]
  ];
};

const checks = { test: "Test", refresh: "Refresh", reconnect: "Reconnect" } as const;
/**
 * A key a check found writable, until Replace key or a Reconnect's check finds a read-only one:
 * whose check it was, when, which scopes, and the way back.
 */
export const standing = (
  connection: Connection,
  people: ReadonlyMap<string, string>,
  now: number
): ReadonlyArray<View.Standing> => {
  const writable = connection.display.writable;
  if (writable === undefined) return [];
  const who = people.get(writable.by) ?? "An admin";
  const scopes = named(writable.scopes);
  return [
    {
      tone: "refused",
      title: "Disconnected: this key can now write",
      text: `${who}'s ${checks[writable.during]}, ${ago(writable.at, now)}, found ${scopes} set to Read-write on this key, so Patchy stopped using it. Patches that declare attio/${connection.handle} can't read until it's reconnected. In Attio, set ${scopes} back to Read or off, then Reconnect. Or replace the key with a read-only one, then Reconnect.`,
      actions: [
        {
          href: View.connectionPath(connection.id, "reconnect"),
          label: "Reconnect",
          primary: true,
          post: true
        },
        { href: View.connectionPath(connection.id, "rotate"), label: "Replace key…" }
      ]
    }
  ];
};

// ---------- what patches can read ----------

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
const codes = (values: ReadonlyArray<string>) => values.map(code).join(", ");
/** Rows a group shows before the rest fold behind "more", and attributes a row's table shows. */
const SHOWN = 10;
const ATTRIBUTES_SHOWN = 100;
const OPTIONS_SHOWN = 5;

const reasons: Readonly<Record<AttioExclusion["reason"], string>> = {
  archived: "archived in Attio",
  no_slug: "no API slug",
  unsupported_type: "a type Patchy doesn't read",
  no_parent: "its parent object isn't read"
};

const type = (attribute: AttioAttribute) =>
  `${attribute.type.replaceAll("-", " ")}${attribute.targets === undefined ? "" : ` → ${attribute.targets.map((target) => target.slug).join(", ") || "nothing Patchy reads"}`}${attribute.multiselect ? " · many" : ""}`;
const options = (attribute: AttioAttribute) =>
  attribute.optionsSkipped === true
    ? '<br><span class="tag">Options skipped</span>'
    : attribute.options === undefined
      ? ""
      : `<br><span class="supporting-text">${escapeHtml(
          attribute.options.length === 0
            ? "no active options"
            : attribute.options.length <= OPTIONS_SHOWN
              ? attribute.options.join(" · ")
              : `${attribute.options.slice(0, OPTIONS_SHOWN - 1).join(" · ")} · +${attribute.options.length - OPTIONS_SHOWN + 1}`
        )}</span>`;
const table = (attributes: ReadonlyArray<AttioAttribute>) =>
  `<div class="attio-attributes"><table class="table"><thead><tr><th scope="col">Attribute</th><th scope="col">Title</th><th scope="col">Type</th></tr></thead><tbody>${attributes
    .slice(0, ATTRIBUTES_SHOWN)
    .map(
      (attribute) =>
        `<tr><td>${code(attribute.slug)}</td><td>${escapeHtml(attribute.title)}</td><td>${escapeHtml(type(attribute))}${options(attribute)}</td></tr>`
    )
    .join(
      ""
    )}</tbody></table></div>${attributes.length > ATTRIBUTES_SHOWN ? `<p class="supporting-text">${escapeHtml(`And ${attributes.length - ATTRIBUTES_SHOWN} more, in the context agents get.`)}</p>` : ""}`;

type Container = AttioSnapshot["objects"][number] & {
  readonly parents?: AttioSnapshot["lists"][number]["parents"];
};
const row = (container: Container, excluded: ReadonlyArray<AttioExclusion>) => {
  const left = excluded.filter((item) => item.kind === "attribute" && item.in === container.slug);
  const skipped = container.attributes.filter((item) => item.optionsSkipped === true).length;
  return `<li class="list-row"><details><summary>${code(container.slug)} ${escapeHtml(container.name)}${container.parents === undefined ? "" : ` <span class="supporting-text">of ${escapeHtml(container.parents.map((parent) => parent.slug).join(", "))}</span>`} <span class="count">· ${plural(container.attributes.length, "attribute")}</span>${left.length === 0 ? "" : ` <span class="tag">${left.length} left out</span>`}${skipped === 0 ? "" : ` <span class="tag">${skipped} options skipped</span>`}</summary>${table(container.attributes)}${left.length === 0 ? "" : `<p class="supporting-text">Left out: ${left.map((item) => `${code(item.name)} (${reasons[item.reason]})`).join(", ")}.</p>`}</details></li>`;
};
const group = (
  title: string,
  containers: ReadonlyArray<Container>,
  excluded: ReadonlyArray<AttioExclusion>
) =>
  containers.length === 0
    ? ""
    : `<h3>${escapeHtml(title)} <span class="count">${containers.length}</span></h3><ul class="list list-compact">${containers
        .slice(0, SHOWN)
        .map((container) => row(container, excluded))
        .join("")}${
        containers.length > SHOWN
          ? `<li class="list-row"><details><summary>${escapeHtml(`${containers.length - SHOWN} more ${title.toLowerCase()}`)}</summary><ul class="list list-compact">${containers
              .slice(SHOWN)
              .map((container) => row(container, excluded))
              .join("")}</ul></details></li>`
          : ""
      }</ul>`;

/** What discovery left out, grouped by why. */
const leftOut = (excluded: ReadonlyArray<AttioExclusion>) => {
  if (excluded.length === 0) return "";
  const name = (item: AttioExclusion) =>
    item.in === undefined ? item.name : `${item.in}.${item.name}`;
  const archived = excluded.filter((item) => item.reason === "archived");
  const slugless = excluded.filter((item) => item.reason === "no_slug");
  const unsupported = excluded.filter((item) => item.reason === "unsupported_type");
  const orphans = excluded.filter((item) => item.reason === "no_parent");
  const rows = [
    archived.length === 0
      ? ""
      : `${escapeHtml(plural(archived.length, "archived attribute"))}: ${codes(archived.map(name))}`,
    slugless.length === 0
      ? ""
      : `No API slug: ${slugless.map((item) => `the ${item.kind} <strong>${escapeHtml(name(item))}</strong>`).join(", ")}`,
    unsupported.length === 0 ? "" : `A type Patchy doesn't read: ${codes(unsupported.map(name))}`,
    orphans.length === 0
      ? ""
      : `Its parent object isn't read: ${orphans.map((item) => `the list ${code(item.name)}`).join(", ")}`
  ].filter((text) => text !== "");
  return `<div class="note"><strong class="note-title">Left out: ${excluded.length}</strong><ul class="list list-compact">${rows.map((text) => `<li class="list-row">${text}</li>`).join("")}</ul></div>`;
};

/** Skipped options, then exclusions, then every object and list, each opening to its attributes. */
export const reads = (snapshot: AttioSnapshot) => {
  const containers = [...snapshot.objects, ...snapshot.lists];
  const attributes = containers.reduce((sum, item) => sum + item.attributes.length, 0);
  const skipped = containers.flatMap((container) =>
    container.attributes
      .filter((item) => item.optionsSkipped === true)
      .map((item) => `${container.slug}.${item.slug}`)
  );
  return {
    summary: `${plural(snapshot.objects.length, "object")} and ${plural(snapshot.lists.length, "list")}, ${plural(attributes, "attribute")}.`,
    items: [],
    more: 0,
    detail: `${
      skipped.length === 0
        ? ""
        : `<div class="note note-warn"><strong class="note-title">Options skipped on ${escapeHtml(plural(skipped.length, "attribute"))}</strong>Discovery ran out of time before reading their options. Patches still read and filter them; their context lists no options.<details><summary>The ${skipped.length} attributes</summary><p class="supporting-text">${skipped.map(code).join(" ")}</p></details></div>`
    }${leftOut(snapshot.excluded)}${group("Objects", snapshot.objects, snapshot.excluded)}${group("Lists", snapshot.lists, snapshot.excluded)}`
  };
};

// ---------- connecting ----------

export const connectIntro =
  "About two minutes, by an Attio workspace admin. Connecting checks the key, then reads your workspace for up to a minute; nothing is saved until both finish.";

const required = [
  "Records",
  "Object configuration",
  "List entries",
  "List configuration",
  "User management"
];
export const walkthrough: View.Walkthrough = {
  before: [
    {
      title: "Make a read-only access token in Attio",
      text: "Workspace settings › Developers › New access token. Only workspace admins see Developers.",
      detail: `<table class="table attio-scopes"><thead><tr><th scope="col">Scope</th><th scope="col">Set to</th></tr></thead><tbody>${required.map((scope) => `<tr><td>${scope}</td><td><strong>Read</strong></td></tr>`).join("")}<tr><td>Anything else</td><td>Read or off</td></tr></tbody></table><p><strong>Never Read-write.</strong></p>`
    }
  ],
  current: "Paste it here",
  after: [
    {
      title: "Use it in a patch",
      text: "Ask your agent to add it to a patch by its name, such as attio/crm."
    }
  ]
};

const notes = `<div class="note"><strong class="note-title">Company-wide access</strong><p>Every member reads everything this key reads, through any patch that declares it. Attio's own member permissions don't carry over.</p></div><div class="note note-warn"><strong class="note-title">Agents read your CRM while building</strong><p>While someone builds a patch with this connection, their agent reads the real workspace through Patchy, as them. Nothing is written, and every read appears in recent calls.</p></div>`;

type Submitted = Readonly<Record<string, string | undefined>>;

const keyField = (refusal: View.Notice | undefined) => {
  const note = View.fieldNote(
    "connection-key",
    "key",
    "Patchy encrypts it and never shows it again.",
    refusal
  );
  return `<label class="field-label" for="connection-key">Access token</label><input class="field" id="connection-key" type="password" name="key" required autocomplete="new-password" spellcheck="false"${note.attributes}>${note.note}`;
};

/** Refusals about the key, shown under its field rather than atop the page. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map([
  ["invalid_credentials", "key"],
  ["attio_key_unknown", "key"],
  ["attio_not_a_token", "key"],
  ["attio_not_workspace_key", "key"],
  ["attio_missing_scopes", "key"],
  ["attio_write_scopes", "key"],
  ["attio_other_workspace", "key"]
]);

/** The connect form's fields; a refused submit keeps everything typed except the key. */
export const connectFields = (submitted: Submitted, refusal?: View.Notice) => {
  const handle = View.fieldNote(
    "connection-handle",
    "handle",
    "Patches use this name, which can't be changed later.",
    refusal
  );
  const description = View.fieldNote(
    "connection-description",
    "description",
    "One line on what this workspace holds, so builders pick the right one.",
    refusal
  );
  return `<label class="field-label" for="connection-handle">Name</label><div class="field field-group"><label class="field-prefix" for="connection-handle">attio/</label><input id="connection-handle" name="handle" value="${escapeAttribute(submitted.handle ?? "")}" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9\\-]{1,30}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"${handle.attributes}></div>${handle.note}<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(submitted.description ?? "")}"${description.attributes}>${description.note}${keyField(refusal)}${notes}`;
};

export const rotate = {
  title: (name: string) => `Replace the key for ${name}`,
  consequence: (connection: ConnectionStore.Connection) =>
    `Patchy checks the new key and reads the workspace again before saving either. The key must read ${connection.integration === "attio" ? workspace(connection) : "the same workspace"}.`,
  fields: (_submitted: Submitted, refusal?: View.Notice) => keyField(refusal)
};

/** The pasted key, or the refusal under its field. Attio itself says whether it's a token. */
export const credentials = (form: Submitted): Redacted.Redacted<string> | View.Notice => {
  const key = (form.key ?? "").trim();
  if (!/^[\x21-\x7e]{1,512}$/.test(key))
    return {
      message: new Source.InvalidCredentials({}).message,
      code: "invalid_credentials",
      status: 422,
      field: "key"
    };
  return Redacted.make(key);
};

/** Layout only: a long attribute table scrolls inside its row, and the scope table stays narrow. */
export const styles = `
  .attio-attributes { max-height: 26rem; overflow: auto; }
  .attio-scopes { max-width: 30rem; }
`;
