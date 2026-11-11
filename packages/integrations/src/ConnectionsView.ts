import {
  ago,
  badge,
  button,
  card,
  copyLine,
  copyScriptPath,
  detailPage,
  dialog,
  dot,
  emptyState,
  escapeAttribute,
  expandingTable,
  escapeHtml,
  facts,
  field,
  idFor,
  indexPage,
  input,
  linkButton,
  menu,
  type MenuItem,
  notice as noticeBox,
  productMark,
  type ProductMark,
  receipt,
  row,
  rows,
  searchField,
  section,
  segmented,
  settingRow,
  settingsPage,
  switchForm,
  table,
  type Template,
  tabs,
  tellPatchyPanel
} from "@patchy/core";
import type { RuntimeLog } from "@patchy/runtime";
import type { Usage } from "./ConnectionStore.js";
import * as Fields from "./Fields.js";

/**
 * The Integrations pages, rendered from plain values. One layout serves every integration: an
 * integration supplies its words and facts, and these draw them on core's templates, so the
 * index reads the same at one connection or thirty across fifteen integrations.
 *
 * Words, one per action: Pause and Resume stop a connection and start it again with its
 * credentials kept (stored as disconnected and reconnected); Disconnect forgets its credentials
 * (stored as deleted); Replace key gives it new ones for the same place (rotate).
 */

/** An integration as the pages name it. */
export interface Integration {
  /** The name agents type before the handle: `postgres` in `postgres/warehouse`. */
  readonly key: string;
  readonly label: string;
  /**
   * Its mark: its logo where Patchy knows it, else an icon or letters. A connection's can be the
   * provider it reaches, such as Gmail's for a mailbox on Gmail's server.
   */
  readonly mark: ProductMark;
}

/** An integration Patchy offers, as the catalogue lists it. */
export interface Offer {
  readonly integration: Integration;
  /** What connecting one gives patches, in at most eight words. */
  readonly line: string;
}

/** An action that settles why a connection needs an admin; `post` submits rather than links. */
export interface Fix {
  readonly href: string;
  readonly label: string;
  readonly primary?: boolean;
  readonly post?: boolean;
}

/**
 * Why a connection needs an admin, in its integration's words, with what fixes it: an Attio key
 * a check found writable, a mailbox whose server refused the password, a Pidgeon key Patchy
 * replaced but couldn't revoke. Each integration has its own reasons; the pages show one.
 */
export interface Attention {
  readonly tone: "warning" | "danger";
  readonly title: string;
  readonly text: string;
  /**
   * Patchy stored it as paused for this reason, as Attio's key check does, so the pages don't also
   * say an admin paused it. A reason that leaves the status alone, such as IMAP's login pause,
   * shows beside an admin's pause.
   */
  readonly paused?: boolean;
  readonly fixes?: ReadonlyArray<Fix>;
}

/** One connection as the index lists it. */
export interface Row extends Usage {
  readonly id: string;
  readonly integration: Integration;
  readonly handle: string;
  readonly description: string;
  /** Where it reads from, in the integration's words. */
  readonly source: string;
  readonly status: "connected" | "disconnected";
  /** A word beside its name wherever it's shown, such as a test connection's. */
  readonly tag?: string;
  readonly attention?: Attention;
}

/** When each connection's newest call began, or "unavailable" when the call log could not be read. */
export type LastCalls = ReadonlyMap<string, string> | "unavailable";

/** A completed action (no status) or a refusal, with the code agents and support can quote. */
export interface Notice {
  /** Bold over the message, when the message alone would read as a wall of text. */
  readonly title?: string;
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
  /** Where to go instead, such as Point elsewhere after credentials name another database. */
  readonly next?: { readonly href: string; readonly label: string };
  /** The form field a refusal is about; it then reads under that field instead of above the form. */
  readonly field?: Field;
}

/** The connection forms' fields a refusal can sit at; an integration names its own credential fields. */
export type Field =
  | "handle"
  | "description"
  | "credentials"
  | "region"
  | "project"
  | "key"
  | "address"
  | "access"
  | "host"
  | "port"
  | "security"
  | "username"
  | "password";

export type View = "all" | "attention" | "paused" | "unused";
export interface Filters {
  /** Lowercased search over names and descriptions; empty for none. */
  readonly q: string;
  /** An integration key, or undefined for every source. */
  readonly source: string | undefined;
  readonly view: View;
}
export const noFilters: Filters = { q: "", source: undefined, view: "all" };

/** Below this many connections the whole list fits on a screen, so the index offers no controls. */
export const CONTROLS_AT = 9;

export const indexPath = "/settings/integrations";
export const cataloguePath = `${indexPath}/connect`;
export const connectPath = (integration: string) =>
  `${cataloguePath}/${encodeURIComponent(integration)}`;
export const connectionPath = (id: string, action = "") =>
  `${indexPath}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
const filterPath = (filters: Filters) => {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.source !== undefined) params.set("source", filters.source);
  if (filters.view !== "all") params.set("view", filters.view);
  const search = params.toString();
  return search ? `${indexPath}?${search}` : indexPath;
};

/**
 * How a company asks Patchy for an integration it would connect: a button opening the shell's
 * Tell Patchy panel beside itself with Request picked, so the ask lands with Patchy's requests.
 */
const ask = (
  label: string,
  look: { readonly kind?: "quiet"; readonly size?: "sm"; readonly ariaLabel?: string } = {}
) =>
  button(label, {
    ...look,
    type: "button",
    popovertarget: tellPatchyPanel,
    data: { kind: "request" }
  });

const name = (connection: { readonly integration: Integration; readonly handle: string }) =>
  `${connection.integration.key}/${connection.handle}`;
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
/** "512 B", "48 KB", "2.4 MB": a call's bytes at a glance, in powers of 1,024. */
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
/** "Ada", "Ada and Ben", "Ada, Ben and Cleo". */
const listed = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const muted = (text: string) => `<span class="meta">${escapeHtml(text)}</span>`;
const code = (text: string) => `<code>${escapeHtml(text)}</code>`;

/**
 * What the last form did or why it was refused, under the page's header: a completed action is a
 * receipt; a refusal is a notice, with its code and where to go instead. A refusal about a field
 * reads under that field instead.
 */
export const feedback = (value: Notice | undefined) => {
  if (value === undefined || value.field !== undefined) return "";
  if (value.status === undefined) return receipt(value.message);
  return noticeBox({
    tone: value.status >= 400 ? "danger" : "warning",
    title: value.title ?? value.message,
    body: `${value.title === undefined ? "" : `<p>${escapeHtml(value.message)}</p>`}${value.code === undefined ? "" : `<p>${code(value.code)}</p>`}`,
    ...(value.next === undefined
      ? {}
      : { action: linkButton(value.next.label, value.next.href, { size: "sm" }) })
  });
};

/** The words for who can change what a member reads: "Only admins connect integrations. Admins: Ada." */
const onlyAdmins = (admins: ReadonlyArray<string>) =>
  `Only admins connect integrations.${admins.length === 0 ? "" : ` Admins: ${listed(admins)}.`}`;

/** A connection's state in words: Connected quietly; Needs attention and Paused as badges. */
const status = (item: {
  readonly status: "connected" | "disconnected";
  readonly attention?: Attention | undefined;
}) => {
  const words = [
    item.attention === undefined ? "" : badge("Needs attention", item.attention.tone),
    item.status === "disconnected" && item.attention?.paused !== true ? badge("Paused") : ""
  ].filter((part) => part !== "");
  return words.length === 0 ? dot("Connected", "success") : words.join(" ");
};
const needsAttention = (row: Row) => row.attention !== undefined;
const isPaused = (row: Row) => row.status === "disconnected" && row.attention?.paused !== true;

// ---------- the index ----------

/**
 * A connection no live patch uses: "None", or while stored versions still declare it, which ones
 * in Patchy's words: "None live · 3 retired · 2 older versions".
 */
const unusedNow = (usage: Usage) => {
  const kept = [
    usage.retired > 0 ? `${usage.retired} retired` : null,
    usage.deleted > 0 ? `${usage.deleted} deleted` : null,
    usage.disabled > 0 ? `${usage.disabled} disabled` : null,
    usage.olderVersions > 0 ? plural(usage.olderVersions, "older version") : null
  ].filter((part) => part !== null);
  return usage.declared ? `None live ${muted(`· ${kept.join(" · ")}`)}` : muted("None");
};

const usedByCell = (usage: Usage) =>
  usage.usedBy.length === 0
    ? unusedNow(usage)
    : escapeHtml(
        usage.usedBy.length === 1
          ? usage.usedBy[0]!
          : `${usage.usedBy[0]} and ${usage.usedBy.length - 1} more`
      );

const lastCallCell = (lastCalls: LastCalls, id: string, now: number) => {
  if (lastCalls === "unavailable") return muted("Unknown");
  const at = lastCalls.get(id);
  return at === undefined
    ? muted("Never")
    : `<time datetime="${escapeAttribute(at)}">${escapeHtml(ago(at, now))}</time>`;
};

/** A row's one line: its description, else where it reads, then a test connection's word. */
const line = (row: Row) =>
  [row.description || row.source, row.tag].filter((part) => part !== undefined).join(" · ");

/** What an admin does to one connection from its row: test it, replace its key, pause or resume it. */
const rowMenu = (row: Row, rotate: string) =>
  menu({
    id: idFor("connection", row.id),
    label: name(row),
    items: [
      { kind: "post", label: "Test", action: connectionPath(row.id, "test") },
      { kind: "link", label: `${rotate}…`, href: connectionPath(row.id, "rotate") },
      { kind: "link", label: "Settings", href: connectionPath(row.id, "settings") },
      { kind: "rule" },
      row.status === "connected"
        ? { kind: "link", label: "Pause…", href: connectionPath(row.id, "disconnect") }
        : { kind: "post", label: "Resume", action: connectionPath(row.id, "reconnect") }
    ]
  });

const connectionsTable = (
  shown: ReadonlyArray<Row>,
  input: {
    readonly admin: boolean;
    readonly lastCalls: LastCalls | undefined;
    readonly rotate: (integration: string) => string;
    readonly now: number;
  }
) =>
  table({
    label: "Connections",
    columns: [
      { label: "Connection" },
      { label: "Status" },
      { label: "Used by", hideOnPhone: true },
      ...(input.lastCalls === undefined ? [] : [{ label: "Last call", hideOnPhone: true }]),
      ...(input.admin ? [{ label: "Actions", hidden: true, align: "end" as const }] : [])
    ],
    rows: shown.map((item) => [
      `<div class="cell-name">${productMark(item.integration.mark)}<div class="row-main"><a class="row-link" href="${escapeAttribute(connectionPath(item.id))}">${escapeHtml(name(item))}</a><span class="row-desc">${escapeHtml(line(item))}</span></div></div>`,
      status(item),
      usedByCell(item),
      ...(input.lastCalls === undefined ? [] : [lastCallCell(input.lastCalls, item.id, input.now)]),
      ...(input.admin ? [rowMenu(item, input.rotate(item.integration.key))] : [])
    ])
  });

/**
 * Every integration Patchy offers, one row each: its mark, name, one line and Connect, then a
 * row to ask for another. The same at the same width on the catalogue page and on an empty
 * Integrations page. Members read it without Connect.
 */
const catalogue = (offers: ReadonlyArray<Offer>, rows_: ReadonlyArray<Row>, admin: boolean) =>
  rows(
    [
      ...offers.map((offer) => {
        const count = rows_.filter((item) => item.integration.key === offer.integration.key).length;
        const href = connectPath(offer.integration.key);
        return row({
          lead: productMark(offer.integration.mark),
          name: offer.integration.label,
          description: count === 0 ? offer.line : `${offer.line} · ${count} connected`,
          ...(admin
            ? {
                href,
                end: linkButton("Connect", href, {
                  size: "sm",
                  ariaLabel: `Connect ${offer.integration.label}`
                })
              }
            : {})
        });
      }),
      row({
        lead: productMark("+", { dashed: true }),
        name: "Something else",
        description: "Tell us what you'd connect",
        end: ask("Ask", { kind: "quiet", size: "sm", ariaLabel: "Ask for an integration" })
      })
    ],
    true
  );

/** Rows the filters keep; a member's view never narrows to Unused. */
const matches = (row: Row, filters: Filters) =>
  (filters.q === "" ||
    name(row).toLowerCase().includes(filters.q) ||
    row.description.toLowerCase().includes(filters.q)) &&
  (filters.source === undefined || row.integration.key === filters.source) &&
  (filters.view === "all" ||
    (filters.view === "attention"
      ? needsAttention(row)
      : filters.view === "paused"
        ? isPaused(row)
        : !row.declared));

/**
 * The index's toolbar: its views, each with its count, Needs attention and Paused only while any
 * are; the integrations its connections come from, each a link; and search. All are URLs, and each
 * keeps the others.
 */
const toolbar = (rows_: ReadonlyArray<Row>, filters: Filters, admin: boolean) => {
  const attention = rows_.filter(needsAttention).length;
  const paused = rows_.filter(isPaused).length;
  const views: ReadonlyArray<readonly [View, string, number]> = [
    ["all", "All", rows_.length],
    ...(attention > 0 || filters.view === "attention"
      ? [["attention", "Needs attention", attention] as const]
      : []),
    ...(paused > 0 || filters.view === "paused" ? [["paused", "Paused", paused] as const] : []),
    ...(admin ? [["unused", "Unused", rows_.filter((row) => !row.declared).length] as const] : [])
  ];
  const sources = [
    ...new Map(rows_.map((row) => [row.integration.key, row.integration])).values()
  ].sort((a, b) => a.label.localeCompare(b.label));
  const chosen = sources.find((integration) => integration.key === filters.source);
  return `${segmented({
    label: "Show",
    current: views.find(([key]) => key === filters.view)?.[1] ?? "All",
    items: views.map(([view, text, count]) => ({
      label: text,
      href: filterPath({ ...filters, view }),
      count
    }))
  })}${
    sources.length < 2 && chosen === undefined
      ? ""
      : segmented({
          label: "Integration",
          current: chosen?.label ?? "Every integration",
          items: [
            { label: "Every integration", href: filterPath({ ...filters, source: undefined }) },
            ...sources.map((integration) => ({
              label: integration.label,
              href: filterPath({ ...filters, source: integration.key }),
              count: rows_.filter((row) => row.integration.key === integration.key).length
            }))
          ]
        })
  }${searchField({
    action: indexPath,
    id: "connections-q",
    query: filters.q,
    placeholder: "Name or description",
    label: "Search connections",
    keep: {
      ...(filters.view === "all" ? {} : { view: filters.view }),
      ...(filters.source === undefined ? {} : { source: filters.source })
    },
    className: "grow"
  })}`;
};

/**
 * `/settings/integrations`: one table across integrations, behind Connect an integration; with
 * nothing connected, the catalogue in its place. Its controls appear once it outgrows a screen;
 * filters in a link still apply below that, so a saved view keeps its meaning.
 */
export const renderIndex = (input: {
  readonly admin: boolean;
  /** Active admins' names, for the line that tells members whom to ask. */
  readonly admins: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Row>;
  /** Admins only; members never read the call log. */
  readonly lastCalls?: LastCalls;
  readonly offers: ReadonlyArray<Offer>;
  /** The word for replacing an integration's credentials, by its key: "Replace key". */
  readonly rotate: (integration: string) => string;
  readonly filters: Filters;
  readonly now: number;
  readonly notice?: Notice;
}): Template => {
  const { admin, rows: given } = input;
  const all = [...given].sort((a, b) => name(a).localeCompare(name(b)));
  if (all.length === 0)
    return indexPage({
      title: "Integrations",
      meta: [escapeHtml(admin ? "Nothing is connected yet" : onlyAdmins(input.admins))],
      content: `${feedback(input.notice)}<div class="page-flow">${catalogue(input.offers, all, admin)}</div>`
    });
  // A member's link to Unused shows everything rather than a view they cannot choose.
  const filters =
    input.filters.view === "unused" && !admin
      ? { ...input.filters, view: "all" as const }
      : input.filters;
  const shown = all.filter((row) => matches(row, filters));
  const filtered = filters.q !== "" || filters.source !== undefined || filters.view !== "all";
  const count = `<p class="meta">${escapeHtml(`Showing ${shown.length} of ${all.length}.`)} <a href="${indexPath}">Clear filters</a></p>`;
  return indexPage({
    title: "Integrations",
    meta: [
      escapeHtml(plural(all.length, "connection")),
      ...(admin ? [] : [escapeHtml(onlyAdmins(input.admins))])
    ],
    actions: admin
      ? linkButton("Connect an integration", cataloguePath, { kind: "primary", icon: "plus" })
      : ask("Ask for an integration"),
    ...(all.length >= CONTROLS_AT ? { toolbar: toolbar(all, filters, admin) } : {}),
    content: `${feedback(input.notice)}${
      shown.length === 0
        ? `<div class="box">${emptyState({ title: "No connections match these filters" })}</div>${count}`
        : `${connectionsTable(shown, {
            admin,
            lastCalls: admin ? input.lastCalls : undefined,
            rotate: input.rotate,
            now: input.now
          })}${filtered ? count : ""}`
    }`
  });
};

/** `/settings/integrations/connect`: every integration Patchy offers, behind Connect an integration. */
export const renderCatalogue = (input: {
  readonly admin: boolean;
  readonly admins: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Row>;
  readonly offers: ReadonlyArray<Offer>;
}): Template =>
  settingsPage({
    parent: { label: "Integrations", href: indexPath },
    title: "Connect an integration",
    ...(input.admin ? {} : { meta: [escapeHtml(onlyAdmins(input.admins))] }),
    // The catalogue's one width, here and on an empty Integrations page.
    cards: [`<div class="page-flow">${catalogue(input.offers, input.rows, input.admin)}</div>`]
  });

// ---------- one connection ----------

/** A connection as its own page shows it. */
export interface Connection extends Usage {
  readonly id: string;
  readonly integration: Integration;
  readonly handle: string;
  readonly description: string;
  readonly status: "connected" | "disconnected";
  /** Whether patches that declare it turn their guests away. */
  readonly blockGuests: boolean;
  readonly testedAt: string | null;
  readonly addedBy: string;
  /** The integration's facts about where it reads from, as label and value. */
  readonly facts: ReadonlyArray<readonly [string, string]>;
  /** What it holds to reach its source, as Settings names it: "Personal API key", "Stored · …a1b2". */
  readonly credential: { readonly label: string; readonly detail: string };
  /** Where it reads, for an integration that can point it elsewhere: "Project", "12345, US Cloud". */
  readonly target?: { readonly label: string; readonly value: string };
  /** What its credentials may do, for an integration where that's a choice: "Read and send". */
  readonly access?: string;
  readonly attention?: Attention;
  /** A word beside its name, as the index shows it. */
  readonly tag?: string;
}

/** What the connection's current metadata lets patches read, in the integration's words. */
export interface Reads {
  /** The section's heading, where an integration's connections also act: "What patches can read and do". */
  readonly heading?: string;
  readonly summary: string;
  /** The first things it reads by name, such as tables or folders. */
  readonly items: ReadonlyArray<string>;
  readonly more: number;
  /** Things that open to their parts, in place of `items`, such as Attio's objects and lists. */
  readonly groups?: ReadonlyArray<ReadsGroup>;
  /** What discovery left out or didn't finish, each opening to its lines. */
  readonly caveats?: ReadonlyArray<{
    readonly title: string;
    readonly lines: ReadonlyArray<string>;
  }>;
  readonly revision: number;
  readonly foundAt: string | null;
}

/** A kind of thing a connection reads, such as Attio's objects, each opening to its fields. */
export interface ReadsGroup {
  readonly title: string;
  readonly entries: ReadonlyArray<ReadsEntry>;
  /** The rest, folded behind a disclosure such as "2 more objects". */
  readonly rest?: { readonly label: string; readonly entries: ReadonlyArray<ReadsEntry> };
}

/** One thing in a `ReadsGroup`, opening to a table of its fields. */
export interface ReadsEntry {
  /** Its API name, as patches type it. */
  readonly name: string;
  /** What it is and holds: "Companies · 18 attributes · 2 left out". */
  readonly label: string;
  readonly columns: ReadonlyArray<string>;
  /** Its fields' cells, as plain text; the first cell is a name patches type. */
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  /** Lines after its fields, such as what was left out and why. */
  readonly notes?: ReadonlyArray<string>;
}

/** The labels of an integration's own actions. */
export interface Actions {
  readonly refresh: string;
  /** Replacing the credentials, keeping where they point: "Replace key". */
  readonly rotate: string;
  /** Pointing the connection elsewhere; absent where it can't move. */
  readonly retarget?: string;
  /** Changing what the stored credentials may do. */
  readonly access?: string;
}

/** Stored ids in the reader's words, for the calls. */
export interface CallNames {
  readonly people: ReadonlyMap<string, string>;
  readonly versions: ReadonlyMap<string, { readonly patch: string; readonly number: number }>;
}

export const RECENT_CALLS = 10;

/** A connection's pages: Overview for everyone; Calls and Settings for admins. */
export type Tab = "overview" | "calls" | "settings";
const tabPath = (id: string, tab: Tab) => connectionPath(id, tab === "overview" ? "" : tab);

const outcome = (call: RuntimeLog.Call) => {
  const word =
    call.outcome === "success"
      ? muted("Succeeded")
      : call.outcome === "pending"
        ? badge("Running", "info")
        : call.outcome === "unknown"
          ? muted("Unknown")
          : badge("Failed", "danger");
  return call.outcomeCode === null ? word : `${word} ${code(call.outcomeCode)}`;
};
/** Stored timestamps are UTC instants; readers get the minute. */
const minute = (at: Date) => {
  const iso = at.toISOString();
  return `<time datetime="${escapeAttribute(iso)}">${escapeHtml(`${iso.slice(0, 10)} ${iso.slice(11, 16)}`)}</time>`;
};
// Stored relations are quoted identifiers; plain ones read better bare.
const relation = (value: string) =>
  value.replace(/"([a-z_][a-z0-9_]*)"/gu, "$1").replace(/^public\./u, "");
/**
 * "customers.list", "query", "discover": the method, on its Postgres relation when it has one. A
 * PostHog query's resource is its name, shown as written: "query dailyRequests". A Pidgeon call's
 * resource names its own operation: "messages.send “Order 1043” to sam@customer.example".
 */
const callName = (call: RuntimeLog.Call) => {
  const method = call.op.slice(call.op.indexOf(".") + 1);
  if (call.resource === null) return method;
  if (call.op.startsWith("pidgeon.")) return call.resource;
  return call.op.startsWith("posthog.")
    ? `${method} ${call.resource}`
    : `${relation(call.resource)}.${method}`;
};
/**
 * Where a call came from, as markup: a patch and version (one since reclaimed leaves its ids in
 * Details), the connection pages, or `patchy dev` on someone's machine, marked Dev.
 */
const from = (call: RuntimeLog.Call, names: CallNames) => {
  if (call.machine !== null)
    return `${badge("Dev")} ${escapeHtml(`patchy dev on ${call.machine.name}`)}`;
  if (call.patchId === null) return "Connection administration";
  const version = call.versionId === null ? undefined : names.versions.get(call.versionId);
  return escapeHtml(
    version === undefined ? "A patch since deleted" : `${version.patch} v${version.number}`
  );
};
/** Whose authority a call used: the patch, or its person, "via Claude" when their agent called. */
const as = (call: RuntimeLog.Call, names: CallNames) =>
  call.effectivePrincipal === "patch"
    ? "the patch"
    : `${names.people.get(call.effectivePrincipal) ?? call.effectivePrincipal}${call.agent === null ? "" : ` via ${call.agent.name}`}`;
const credential = (call: RuntimeLog.Call) =>
  call.machine !== null
    ? `The computer ${call.machine.name}, reading the real connection while building a patch`
    : call.agent !== null
      ? `A person's app, ${call.agent.name}, using a patch's agent tool`
      : call.credentialKind === "admin"
        ? "Admin, managing the connection"
        : "A viewer's session";
const took = (call: RuntimeLog.Call) =>
  [
    call.durationMs === null
      ? null
      : call.durationMs < 1_000
        ? `${call.durationMs} ms`
        : `${(call.durationMs / 1_000).toFixed(1)} s`,
    call.rowCount === null ? null : plural(call.rowCount, "row"),
    call.bytes === undefined || call.bytes === null ? null : size(call.bytes)
  ]
    .filter((part) => part !== null)
    .join(" · ") || "—";

/**
 * The Calls tab: the latest calls, newest first, each opening to its ids, credential and query.
 * Every column stays on a phone, where the table scrolls in its wrapper. A log that can't be read
 * says so in the table's place, so the page's one notice stays the connection's own. `logged` is
 * what the integration's calls keep, and what they never do, in its own words.
 */
const callsTable = (
  calls: ReadonlyArray<RuntimeLog.Call> | "unavailable",
  names: CallNames,
  logged: string
) => {
  if (calls === "unavailable")
    return `<div class="box">${emptyState({ title: "Calls could not be loaded", body: "Reload the page to try again." })}</div>`;
  if (calls.length === 0)
    return `<div class="box">${emptyState({ title: "No calls yet", body: logged })}</div>`;
  const latest = calls.length >= RECENT_CALLS ? `The latest ${RECENT_CALLS} calls` : "Calls";
  return `${expandingTable({
    label: "Calls",
    compact: true,
    wide: true,
    columns: [
      { label: "When (UTC)" },
      { label: "From" },
      { label: "Call" },
      { label: "As" },
      { label: "Took", align: "end" },
      { label: "Outcome" }
    ],
    rows: calls.map((call) => ({
      cells: [
        minute(call.at),
        from(call, names),
        code(callName(call)),
        escapeHtml(as(call, names)),
        escapeHtml(took(call)),
        outcome(call)
      ],
      detail: {
        summary: "Details",
        body: `${facts([
          ...(call.patchId === null
            ? []
            : [
                [
                  "Patch / version",
                  `${code(call.patchId)} / ${code(call.versionId ?? "unknown")}`
                ] as const
              ]),
          ["Correlation ID", code(call.correlationId)],
          ["Credential", escapeHtml(credential(call))]
        ])}${call.sql === null ? "" : `<pre class="code-panel"><code>${escapeHtml(call.sql)}</code></pre>`}`
      }
    }))
  })}<p class="meta">${escapeHtml(`${latest}, newest first. Only admins see this. ${logged}`)}</p>`;
};

const patchLink = (patch: string) =>
  `<a href="/patches/${encodeURIComponent(patch)}">${escapeHtml(patch)}</a>`;
/** The first five live patches, then the rest behind a disclosure. */
const usedByFact = (usage: Usage) => {
  if (usage.usedBy.length === 0) return unusedNow(usage);
  const first = usage.usedBy.slice(0, 5).map(patchLink);
  const rest = usage.usedBy.slice(5).map(patchLink);
  return rest.length === 0
    ? listed(first)
    : `${first.join(", ")}<details><summary>${escapeHtml(`and ${rest.length} more`)}</summary>${listed(rest)}</details>`;
};

/**
 * Why a connection that stored versions declare can't be disconnected yet, and what to do: every
 * patch with a declaring version by name, live users first.
 */
export const declaredBy = (usage: Usage) => {
  const live = usage.usedBy;
  const stored = usage.declaredBy;
  const also = stored.length === 0 ? "" : ` Stored versions of ${listed(stored)} declare it too.`;
  if (live.length > 0)
    return `Used by ${listed(live)}. Remove it from ${live.length === 1 ? "that patch" : "those patches"} before disconnecting.${also}`;
  return stored.length === 0
    ? "A stored patch version declares it, so it can be disconnected only once none does. Pause it instead."
    : `Stored versions of ${listed(stored)} still declare it, so it can be disconnected only once none does. Pause it instead.`;
};

const postForm = (path: string, label: string, look: Parameters<typeof button>[1] = {}) =>
  `<form method="post" action="${escapeAttribute(path)}">${button(label, look)}</form>`;

/** The fixes a reason offers, under its words, for admins: under them, so a phone keeps the words wide. */
const fixButtons = (fixes: ReadonlyArray<Fix>) =>
  `<div class="actions">${fixes
    .map((fix) => {
      const look = {
        size: "sm" as const,
        ...(fix.primary === true ? { kind: "primary" as const } : {})
      };
      return fix.post === true
        ? postForm(fix.href, fix.label, look)
        : linkButton(fix.label, fix.href, look);
    })
    .join("")}</div>`;

/**
 * The one notice a connection's page holds: a refusal from the last action, else why it needs an
 * admin with its fixes, else that it's paused with Resume; a completed action is a receipt.
 */
const connectionNotice = (connection: Connection, admin: boolean, notice: Notice | undefined) => {
  // A refusal takes the notice's place; a completed action's receipt is no notice, so what still
  // holds, such as an old key the action couldn't revoke, keeps saying so beside it.
  if (notice !== undefined && notice.field === undefined && notice.status !== undefined)
    return feedback(notice);
  const done = notice !== undefined && notice.status === undefined ? receipt(notice.message) : "";
  return `${done}${standing(connection, admin)}`;
};

/** Why the connection needs an admin with its fixes, else that it's paused with Resume. */
const standing = (connection: Connection, admin: boolean) => {
  const reason = connection.attention;
  if (reason !== undefined)
    return noticeBox({
      tone: reason.tone,
      title: reason.title,
      body: `<p>${escapeHtml(reason.text)}</p>${admin && reason.fixes !== undefined && reason.fixes.length > 0 ? fixButtons(reason.fixes) : ""}`
    });
  if (connection.status === "disconnected")
    return noticeBox({
      tone: "info",
      title: "Paused",
      body: `<p>${escapeHtml(`Patches that use it can't read it until ${admin ? "you resume" : "an admin resumes"} it. Nothing is lost.`)}</p>`,
      ...(admin
        ? {
            action: postForm(connectionPath(connection.id, "reconnect"), "Resume", {
              size: "sm",
              kind: "primary"
            })
          }
        : {})
    });
  return "";
};

/** What an admin does from a connection's header: Test, then the rest behind ⋯. */
const headerActions = (connection: Connection, actions: Actions) => {
  const path = (action: string) => connectionPath(connection.id, action);
  const connected = connection.status === "connected";
  const items: ReadonlyArray<MenuItem> = [
    ...(connected
      ? [{ kind: "post" as const, label: actions.refresh, action: path("refresh") }]
      : []),
    { kind: "link", label: `${actions.rotate}…`, href: path("rotate") },
    ...(actions.retarget === undefined
      ? []
      : [{ kind: "link" as const, label: `${actions.retarget}…`, href: path("retarget") }]),
    ...(actions.access === undefined
      ? []
      : [{ kind: "link" as const, label: `${actions.access}…`, href: path("access") }]),
    { kind: "copy", label: "Copy name", text: name(connection) },
    { kind: "rule" },
    connected
      ? { kind: "link", label: "Pause…", href: path("disconnect") }
      : { kind: "post", label: "Resume", action: path("reconnect") }
  ];
  return `${postForm(path("test"), "Test")}${menu({ id: idFor("connection", connection.id), label: name(connection), items })}`;
};

const overview = (
  connection: Connection,
  reads: Reads | null,
  input: { readonly admin: boolean; readonly admins: ReadonlyArray<string>; readonly now: number }
) => {
  const description = `<p class="prose">${escapeHtml(connection.description || "No description.")}</p>`;
  const found =
    reads === null
      ? ""
      : `found ${reads.foundAt === null ? "at an unknown time" : ago(reads.foundAt, input.now)} (revision ${reads.revision})`;
  const readsBody =
    reads === null
      ? `<p class="meta">Its current metadata is unavailable. Refresh it to see what patches can read.</p>`
      : `${(reads.caveats ?? [])
          .map(
            (caveat) =>
              `<details><summary>${escapeHtml(caveat.title)}</summary>${caveat.lines.map((text) => `<p class="meta">${escapeHtml(text)}</p>`).join("")}</details>`
          )
          .join("")}${
          reads.groups !== undefined
            ? reads.groups.map(readsGroup).join("")
            : reads.items.length === 0
              ? ""
              : rows(
                  reads.items.map((item) => row({ name: item })),
                  true
                )
        }<p class="meta">${escapeHtml(`${reads.more > 0 ? `And ${reads.more} more. ` : ""}Agents get the full discovered metadata when they add the connection.`)}</p>`;
  const readsSection = section({
    title: reads?.heading ?? "What patches can read",
    ...(reads === null ? {} : { description: `${reads.summary} ${capitalise(found)}.` }),
    body: readsBody
  });
  const use =
    connection.status === "connected" && connection.attention?.tone !== "danger"
      ? section({
          title: "Use it in a patch",
          description: "Ask your agent to add it, or run:",
          body: copyLine(
            `patchy add ${name(connection)}`,
            "Command that adds this connection to a patch",
            "the add command"
          )
        })
      : "";
  const about = `<div class="box box-pad">${section({
    title: "About",
    body: `${facts([
      ...connection.facts.map(([label, value]) => [label, escapeHtml(value)] as const),
      ["Used by", usedByFact(connection)],
      ["Guests", connection.blockGuests ? "Blocked" : "Allowed"],
      ["Added by", escapeHtml(connection.addedBy)]
    ])}${input.admin ? "" : `<p class="meta">${escapeHtml(`Only admins can change it.${input.admins.length === 0 ? "" : ` Admins: ${listed(input.admins)}.`}`)}</p>`}`
  })}</div>`;
  return { main: `${description}${readsSection}${use}`, aside: about };
};
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One thing a connection reads, opening to a table of its fields. */
const readsEntry = (entry: ReadsEntry) =>
  `<details class="box-pad"><summary>${code(entry.name)} ${muted(entry.label)}</summary>${table({
    label: `${entry.name} fields`,
    columns: entry.columns.map((label) => ({ label })),
    rows: entry.rows.map((cells) =>
      cells.map((cell, index) => (index === 0 ? code(cell) : escapeHtml(cell)))
    )
  })}${(entry.notes ?? []).map((text) => `<p class="meta">${escapeHtml(text)}</p>`).join("")}</details>`;

/** One kind of thing a connection reads, each opening to its fields, the rest folded away. */
const readsGroup = (group: ReadsGroup) =>
  section({
    title: group.title,
    body: rows(
      [
        ...group.entries.map(readsEntry),
        ...(group.rest === undefined || group.rest.entries.length === 0
          ? []
          : [
              `<details class="box-pad"><summary>${escapeHtml(group.rest.label)}</summary>${rows(group.rest.entries.map(readsEntry), true)}</details>`
            ])
      ],
      true
    )
  });

/** The description, as Settings edits it, keeping what a refused save typed. */
const descriptionCard = (
  connection: Connection,
  form: { readonly description?: string; readonly notice?: Notice; readonly focus?: boolean }
) => {
  const error = Fields.errorAt("description", form.notice);
  return card({
    body: field({
      id: "connection-description",
      label: "Description",
      hint: "Builders choose by it. It neither grants nor restricts access.",
      ...(error === undefined ? {} : { error }),
      control: (aria) =>
        input(aria, {
          name: "description",
          value: form.description ?? connection.description,
          maxlength: 500,
          autofocus: error !== undefined || form.focus === true
        })
    }),
    foot: `<span class="meta">One line, up to 500 characters</span>${button("Save", { kind: "primary", size: "sm" })}`,
    form: { action: connectionPath(connection.id, "description") }
  });
};

const settings = (
  connection: Connection,
  actions: Actions,
  form: { readonly description?: string; readonly notice?: Notice; readonly focus?: boolean }
) => {
  const path = (action: string) => connectionPath(connection.id, action);
  const connected = connection.status === "connected";
  const access = card({
    rows: [
      settingRow({
        title: connection.credential.label,
        description: connection.credential.detail,
        control: linkButton(`${actions.rotate}…`, path("rotate"), { size: "sm" })
      }),
      ...(actions.retarget === undefined || connection.target === undefined
        ? []
        : [
            settingRow({
              title: connection.target.label,
              description: connection.target.value,
              control: linkButton(`${actions.retarget}…`, path("retarget"), { size: "sm" })
            })
          ]),
      ...(actions.access === undefined || connection.access === undefined
        ? []
        : [
            settingRow({
              title: "Patches may",
              description: connection.access,
              control: linkButton(`${actions.access}…`, path("access"), { size: "sm" })
            })
          ]),
      settingRow({
        title: "Guests",
        description: connection.blockGuests
          ? "Patches that use it turn their guests away."
          : "Guests of patches that use it read it too.",
        control: switchForm({
          action: path(connection.blockGuests ? "allow-guests" : "block-guests"),
          label: "Guests can use it",
          checked: !connection.blockGuests
        })
      })
    ]
  });
  const danger = card({
    title: "Stop using it",
    danger: true,
    rows: [
      connected
        ? settingRow({
            title: "Pause",
            description: "Patches can't read it until you resume it. Nothing is lost.",
            control: linkButton("Pause…", path("disconnect"), { size: "sm" })
          })
        : settingRow({
            title: "Resume",
            description: "Patchy tests what it stored first, then patches can read it again.",
            control: postForm(path("reconnect"), "Resume", { size: "sm" })
          }),
      settingRow({
        title: "Disconnect",
        description: connection.declared
          ? declaredBy(connection)
          : "Patchy forgets its credentials and frees its name. What patches were published against is kept.",
        control: connection.declared
          ? ""
          : linkButton("Disconnect…", path("delete"), { size: "sm", kind: "danger" })
      })
    ]
  });
  return `<div class="page-settings">${descriptionCard(connection, form)}${access}<div class="card-gap">${danger}</div></div>`;
};

/**
 * `/settings/integrations/:id` and its tabs: the same Detail page for every integration. Its
 * header holds Test and ⋯ for admins; Overview says what patches can read beside the facts;
 * Calls (admins) lists the latest calls; Settings (admins) holds the description, credentials,
 * guests and, last, pausing and disconnecting.
 */
export const renderConnection = (input: {
  readonly connection: Connection;
  readonly tab: Tab;
  readonly reads: Reads | null;
  readonly actions: Actions;
  /** Admins only; members never read the call log. */
  readonly calls?: {
    readonly list: ReadonlyArray<RuntimeLog.Call> | "unavailable";
    readonly names: CallNames;
    /** What the integration's calls keep and never keep, in its own words. */
    readonly logged: string;
  };
  readonly admin: boolean;
  /** Active admins' names, for the line that tells members whom to ask. */
  readonly admins: ReadonlyArray<string>;
  readonly now: number;
  readonly notice?: Notice;
  /** A description a refused save typed, kept for Settings. */
  readonly description?: string;
  /** Settings opens with the description in focus, as Edit description's old address asks. */
  readonly focusDescription?: boolean;
}): Template => {
  const { connection, admin } = input;
  // A member reads Overview only; Calls and Settings refuse them before here.
  const tab = admin ? input.tab : "overview";
  const tested =
    connection.testedAt === null ? "never tested" : `tested ${ago(connection.testedAt, input.now)}`;
  const navigation = admin
    ? tabs({
        label: name(connection),
        current: tab === "overview" ? "Overview" : tab === "calls" ? "Calls" : "Settings",
        items: (["overview", "calls", "settings"] as const).map((item) => ({
          label: item === "overview" ? "Overview" : item === "calls" ? "Calls" : "Settings",
          href: tabPath(connection.id, item)
        }))
      })
    : "";
  const content =
    tab === "calls" && input.calls !== undefined
      ? { main: callsTable(input.calls.list, input.calls.names, input.calls.logged) }
      : tab === "settings"
        ? {
            main: settings(connection, input.actions, {
              ...(input.description === undefined ? {} : { description: input.description }),
              ...(input.notice === undefined ? {} : { notice: input.notice }),
              ...(input.focusDescription === undefined ? {} : { focus: input.focusDescription })
            })
          }
        : overview(connection, input.reads, input);
  return detailPage({
    parent: { label: "Integrations", href: indexPath },
    mark: productMark(connection.integration.mark, { large: true }),
    title: name(connection),
    meta: [
      status(connection),
      escapeHtml(connection.integration.label),
      ...(connection.tag === undefined ? [] : [escapeHtml(connection.tag)]),
      escapeHtml(tested),
      escapeHtml(`added by ${connection.addedBy}`)
    ],
    ...(admin ? { actions: headerActions(connection, input.actions) } : {}),
    // The page's one notice or receipt sits under its header, above the tabs.
    tabs: `${connectionNotice(connection, admin, input.notice)}${navigation}`,
    main: `${content.main}<script defer src="${copyScriptPath}"></script>`,
    ...("aside" in content ? { aside: content.aside } : {})
  });
};

// ---------- dialogs over Settings ----------

export type Confirmation =
  "rotate" | "retarget" | "access" | "description" | "disconnect" | "delete";

/**
 * A change that needs its own form or a second look, as a dialog over the connection's Settings:
 * Replace key, Change project or Point elsewhere, Change access, Pause and Disconnect. Each has its
 * own address and works without script; a refusal draws it again with what was typed, never a
 * secret. The integration supplies a credentials form's title, meaning and fields.
 */
export const renderDialog = (input: {
  readonly connection: Connection;
  readonly action: Exclude<Confirmation, "description">;
  readonly actions: Actions;
  readonly form?: {
    readonly title: string;
    readonly consequence: string;
    readonly fields: string;
    /** The submit button's label, where testing first isn't what it does. */
    readonly submit?: string;
  };
  /** The integration's own words for what pausing or disconnecting does, where they differ. */
  readonly consequences?: Partial<Record<"delete" | "disconnect", string>>;
  readonly notice?: Notice;
}): string => {
  const { connection, action } = input;
  const label = name(connection);
  const back = connectionPath(connection.id, "settings");
  // A refusal not about a field sits above the actions and takes focus, so it's read first;
  // otherwise Cancel takes it in a destructive dialog.
  const refusal =
    input.notice === undefined || input.notice.field !== undefined
      ? ""
      : `<div tabindex="-1" autofocus>${feedback(input.notice)}</div>`;
  const cancel = (autofocus: boolean) =>
    linkButton("Cancel", back, { kind: "quiet", autofocus: autofocus && refusal === "" });
  const credentials = (submit: string) => ({
    title: input.form?.title ?? label,
    body: `<p class="prose">${escapeHtml(input.form?.consequence ?? "")}</p>${input.form?.fields ?? ""}${refusal}`,
    foot: `${cancel(false)}${button(input.form?.submit ?? submit, { kind: "primary" })}`
  });
  const affected =
    connection.usedBy.length === 0
      ? `<p class="meta">No live patch declares it now.</p>`
      : `<p>These patches lose access on their next call:</p>${rows(
          connection.usedBy.map((patch) =>
            row({ name: patch, href: `/patches/${encodeURIComponent(patch)}` })
          ),
          true
        )}`;
  const page =
    action === "rotate"
      ? credentials(`Test and ${input.actions.rotate.toLowerCase()}`)
      : action === "retarget"
        ? credentials(`Test and ${(input.actions.retarget ?? "point it elsewhere").toLowerCase()}`)
        : action === "access"
          ? credentials(input.actions.access ?? "Change access")
          : action === "disconnect"
            ? {
                title: `Pause ${label}?`,
                body: `<p class="prose">${escapeHtml(
                  input.consequences?.disconnect ??
                    "Patches that declare it can't read it until an admin resumes it. Its credentials, what patches can read and every declaration are kept; resuming tests the credentials first."
                )}</p>${affected}${refusal}`,
                foot: `${cancel(true)}${button(`Pause ${label}`, { kind: "danger" })}`
              }
            : {
                title: `Disconnect ${label}?`,
                body: `<p class="prose">${escapeHtml(
                  input.consequences?.delete ??
                    "No stored patch version declares it. Patchy forgets its credentials and frees the name; the metadata patches were published against is kept. This can't be undone."
                )}</p>${refusal}`,
                foot: `${cancel(true)}${button(`Disconnect ${label}`, { kind: "danger-solid" })}`
              };
  return dialog({
    id: "connection-dialog",
    title: page.title,
    closeHref: back,
    size: "lg",
    form: { action: connectionPath(connection.id, action) },
    body: page.body,
    foot: page.foot
  });
};
