import type { AttioAttribute, AttioExclusion, AttioObject, AttioSnapshot } from "@patchy/api";
import { ago } from "@patchy/core";
import * as Redacted from "effect/Redacted";
import type * as ConnectionStore from "../ConnectionStore.js";
import type * as ConnectFrame from "../ConnectFrame.js";
import * as View from "../ConnectionsView.js";
import * as Fields from "../Fields.js";
import * as Source from "./Source.js";

/**
 * What the connections pages say about Attio; the layout around it is every integration's. The
 * connect page is the shared frame, one submit: the key check refuses within
 * a second, then discovery reads the workspace. The connection page says what discovery skipped
 * and left out, then lists each object and list as a counted row that opens to its attributes.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "attio" }>;

export const integration = { key: "attio", label: "Attio", mark: { logo: "attio" } } as const;
export const offer = { integration, line: "CRM records, lists and members" };
/** What recent calls keep of an Attio call. */
export const logged =
  "Each call keeps the object or list it read and how many rows came back; filters, ids, values and records are never logged.";
export const actions: View.Actions = { refresh: "Refresh workspace", rotate: "Replace key" };
export const results = {
  connect: "Attio connected and its workspace discovered.",
  rotate: (connection: ConnectionStore.Connection) =>
    connection.status === "connected"
      ? "Key replaced and the workspace discovered again. Existing patches keep what they were published with."
      : "Key replaced and the workspace discovered again. The connection stays paused until you resume it.",
  refresh:
    "Workspace refreshed. Existing patches keep their pinned shape; regenerate before publishing against the new one.",
  reconnect: "Key checked and resumed. Its snapshot revision is unchanged."
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
/** What it holds, as Settings names it: the token, never shown, by the last characters it showed at connect. */
export const credential = (connection: Connection) => ({
  label: "Access token",
  detail: `Stored · ${connection.display.keyHint}`
});
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

const checks = { test: "Test", refresh: "Refresh", reconnect: "Resume" } as const;
/**
 * A key a check found writable, until Replace key or a Resume's check finds a read-only one:
 * whose check it was, when, which scopes, and the way back. Patchy paused it for this.
 */
export const attention = (
  connection: Connection,
  people: ReadonlyMap<string, string>,
  now: number
): View.Attention | undefined => {
  const writable = connection.display.writable;
  if (writable === undefined) return undefined;
  const who = people.get(writable.by) ?? "An admin";
  const scopes = named(writable.scopes);
  return {
    tone: "danger",
    title: "This key can now write",
    text: `${who}'s ${checks[writable.during]}, ${ago(writable.at, now)}, found ${scopes} set to Read-write on this key, so Patchy paused the connection. Patches that declare attio/${connection.handle} can't read until it resumes. In Attio, set ${scopes} back to Read or off, then Resume. Or replace the key with a read-only one, then Resume.`,
    paused: true,
    fixes: [
      {
        href: View.connectionPath(connection.id, "reconnect"),
        label: "Resume",
        primary: true,
        post: true
      },
      { href: View.connectionPath(connection.id, "rotate"), label: "Replace key…" }
    ]
  };
};

// ---------- what patches can read ----------

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
/** Rows a group shows before the rest fold away, and attributes a row's table shows. */
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
    ? " · options skipped"
    : attribute.options === undefined
      ? ""
      : ` · ${
          attribute.options.length === 0
            ? "no active options"
            : attribute.options.length <= OPTIONS_SHOWN
              ? attribute.options.join(" · ")
              : `${attribute.options.slice(0, OPTIONS_SHOWN - 1).join(" · ")} · +${attribute.options.length - OPTIONS_SHOWN + 1}`
        }`;

type Container = AttioSnapshot["objects"][number] & {
  readonly parents?: AttioSnapshot["lists"][number]["parents"];
};
/** One object or list: its name and counts, a table of its attributes, and what was left out of it. */
const entry = (
  kind: "object" | "list",
  container: Container,
  excluded: ReadonlyArray<AttioExclusion>
) => {
  // Objects and lists are named apart, so an object and a list may share a slug.
  const left = excluded.filter(
    (item) => item.kind === "attribute" && item.in?.kind === kind && item.in.slug === container.slug
  );
  const skipped = container.attributes.filter((item) => item.optionsSkipped === true).length;
  const shown = container.attributes.slice(0, ATTRIBUTES_SHOWN);
  return {
    name: container.slug,
    label: [
      container.name,
      container.parents === undefined
        ? null
        : `of ${container.parents.map((parent) => parent.slug).join(", ")}`,
      plural(container.attributes.length, "attribute"),
      left.length === 0 ? null : `${left.length} left out`,
      skipped === 0 ? null : `${skipped} options skipped`
    ]
      .filter((part) => part !== null)
      .join(" · "),
    columns: ["Attribute", "Title", "Type"],
    rows: shown.map((attribute) => [
      attribute.slug,
      attribute.title,
      `${type(attribute)}${options(attribute)}`
    ]),
    notes: [
      ...(container.attributes.length > ATTRIBUTES_SHOWN
        ? [`And ${container.attributes.length - ATTRIBUTES_SHOWN} more, in the context agents get.`]
        : []),
      ...(left.length === 0
        ? []
        : [`Left out: ${left.map((item) => `${item.name} (${reasons[item.reason]})`).join(", ")}.`])
    ]
  };
};
const group = (
  title: string,
  kind: "object" | "list",
  containers: ReadonlyArray<Container>,
  excluded: ReadonlyArray<AttioExclusion>
): ReadonlyArray<View.ReadsGroup> =>
  containers.length === 0
    ? []
    : [
        {
          title: `${title} · ${containers.length}`,
          entries: containers.slice(0, SHOWN).map((container) => entry(kind, container, excluded)),
          ...(containers.length > SHOWN
            ? {
                rest: {
                  label: `${containers.length - SHOWN} more ${title.toLowerCase()}`,
                  entries: containers
                    .slice(SHOWN)
                    .map((container) => entry(kind, container, excluded))
                }
              }
            : {})
        }
      ];

/** What discovery left out, grouped by why, a line each. */
const leftOut = (excluded: ReadonlyArray<AttioExclusion>) => {
  if (excluded.length === 0) return [];
  // An attribute by its owner and name; a list's is marked, so it's never taken for an object's.
  const owned = (item: AttioExclusion) =>
    item.in === undefined
      ? item.name
      : `${item.in.slug}.${item.name}${item.in.kind === "list" ? " (list)" : ""}`;
  const archived = excluded.filter((item) => item.reason === "archived");
  const slugless = excluded.filter((item) => item.reason === "no_slug");
  const unsupported = excluded.filter((item) => item.reason === "unsupported_type");
  const orphans = excluded.filter((item) => item.reason === "no_parent");
  return [
    {
      title: `Left out: ${excluded.length}`,
      lines: [
        archived.length === 0
          ? ""
          : `${plural(archived.length, "archived attribute")}: ${archived.map(owned).join(", ")}`,
        slugless.length === 0
          ? ""
          : `No API slug: ${slugless.map((item) => (item.kind === "attribute" ? `the attribute ${owned(item)}` : `the ${item.kind} ${item.name}`)).join(", ")}`,
        unsupported.length === 0
          ? ""
          : `A type Patchy doesn't read: ${unsupported.map(owned).join(", ")}`,
        orphans.length === 0
          ? ""
          : `Its parent object isn't read: ${orphans.map((item) => `the list ${item.name}`).join(", ")}`
      ].filter((text) => text !== "")
    }
  ];
};

/** Skipped options, then exclusions, then every object and list, each opening to its attributes. */
export const reads = (snapshot: AttioSnapshot) => {
  const containers = [...snapshot.objects, ...snapshot.lists];
  const attributes = containers.reduce((sum, item) => sum + item.attributes.length, 0);
  // A list's are marked, as Left out marks them: an object and a list may share a slug.
  const skippedIn = (containers: ReadonlyArray<AttioObject>, list: boolean) =>
    containers.flatMap((container) =>
      container.attributes
        .filter((item) => item.optionsSkipped === true)
        .map((item) => `${container.slug}.${item.slug}${list ? " (list)" : ""}`)
    );
  const skipped = [...skippedIn(snapshot.objects, false), ...skippedIn(snapshot.lists, true)];
  return {
    summary: `${plural(snapshot.objects.length, "object")} and ${plural(snapshot.lists.length, "list")}, ${plural(attributes, "attribute")}.`,
    items: [],
    more: 0,
    caveats: [
      ...(skipped.length === 0
        ? []
        : [
            {
              title: `Options skipped on ${plural(skipped.length, "attribute")}`,
              lines: [
                "Discovery ran out of time before reading their options. Patches still read and filter them; their context lists no options.",
                skipped.join(", ")
              ]
            }
          ]),
      ...leftOut(snapshot.excluded)
    ],
    groups: [
      ...group("Objects", "object", snapshot.objects, snapshot.excluded),
      ...group("Lists", "list", snapshot.lists, snapshot.excluded)
    ]
  };
};

// ---------- connecting ----------

const required = [
  "Records",
  "Object configuration",
  "List entries",
  "List configuration",
  "User management"
];

type Submitted = Readonly<Record<string, string | undefined>>;

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

/** The access token, as Replace key asks for it. */
const tokenSpec: Fields.Spec = {
  kind: "secret",
  name: "key",
  field: "key",
  label: "Access token",
  hint: "Encrypted, and never shown again. Patchy checks it, then reads your workspace for up to a minute; nothing is saved until both finish.",
  autocomplete: "new-password"
};

/** What the connect page asks for, in the shared frame, by an Attio workspace admin. */
export const connect: ConnectFrame.ConnectSpec = {
  getIt: {
    title: "Make a read-only access token",
    steps: [
      "In Attio, open Workspace settings › Developers › New access token, with these scopes. Only workspace admins see Developers."
    ],
    table: {
      head: ["Scope", "Set to"],
      rows: [
        ...required.map((scope) => [scope, "Read"] as const),
        ["Anything else", "Read or off, never Read-write"]
      ]
    }
  },
  paste: { title: "Paste the token", fields: [tokenSpec] },
  name: { example: "crm", describe: "Your CRM: deals, companies and people" },
  once: {
    reads: "everything this token reads",
    devReads: true,
    cannot: ["Nothing is written to Attio"],
    caveat: "Attio's own member permissions don't carry over."
  }
};

export const rotate = {
  title: (name: string) => `Replace the key for ${name}`,
  consequence: (connection: ConnectionStore.Connection) =>
    `Patchy checks the new key and reads the workspace again before saving either. The key must read ${connection.integration === "attio" ? workspace(connection) : "the same workspace"}.`,
  fields: (submitted: Submitted, refusal?: View.Notice) =>
    Fields.render(tokenSpec, submitted, refusal, true),
  shows: ["key"]
} as const;

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
