import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { integrations } from "@patchy/api";
import {
  badge,
  chipMenu,
  emptyState,
  escapeAttribute,
  escapeHtml,
  groupedTable,
  type GroupedRow,
  linkButton,
  person,
  row,
  rows,
  section
} from "@patchy/core";
import type { Patches } from "@patchy/patches";
import { InvocationLog } from "@patchy/runtime";

export type OutcomeFilter = NonNullable<InvocationLog.PageFilter["outcome"]>;
export const outcomeFilters: ReadonlyArray<readonly [OutcomeFilter, string]> = [
  ["succeeded", "Succeeded"],
  ["failed", "Failed"],
  ["unknown", "Unknown"]
];

/** What the page needs to turn stored ids into the words a reader knows. */
export interface LogNames {
  readonly people: ReadonlyMap<string, string>;
  readonly versions: ReadonlyMap<string, number>;
  /** Company connection names (`postgres/warehouse`) by id, for the calls that went to them. */
  readonly connections: ReadonlyMap<string, string>;
}

export const logPath = (patch: Patches.Patch, query: Record<string, string | undefined> = {}) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  const search = params.toString();
  return `/patches/${encodeURIComponent(patch.name)}/log${search ? `?${search}` : ""}`;
};

// Patchy's refusals where nothing ran or nothing committed, so a retry is the caller's call.
const refusalCodes = new Set([
  "write_conflict",
  "busy",
  "limit_exceeded",
  "patch_paused",
  "access_denied"
]);

/** Success is plain; a refusal, a failure, a call still running or one whose end is unknown says so. */
const outcome = (value: InvocationLog.Outcome, code: string | null) => {
  const word =
    value === "success"
      ? '<span class="muted">Succeeded</span>'
      : value === "pending"
        ? badge("Running", "info")
        : value === "unknown_outcome"
          ? badge("Unknown")
          : value === "handler_error" || (code !== null && refusalCodes.has(code))
            ? badge("Refused", "warning")
            : badge("Failed", "danger");
  const shown =
    code !== null && code !== "unknown_outcome" ? ` <code>${escapeHtml(code)}</code>` : "";
  return `${word}${shown}`;
};

const duration = (ms: number | null) =>
  ms === null ? null : ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (value: number) => String(value).padStart(2, "0");
const parts = (date: Date | number) => DateTime.toPartsUtc(DateTime.makeUnsafe(date));
/** "14:02", UTC: a row's time under its day. */
const clock = (date: Date) => {
  const at = parts(date);
  return `${pad(at.hour)}:${pad(at.minute)}`;
};
/** "28 Sep 14:02", with the year only when it is not the current one. Always UTC. */
const when = (date: Date, now: number) => {
  const at = parts(date);
  const year = at.year === parts(now).year ? "" : ` ${at.year}`;
  return `${at.day} ${months[at.month - 1]}${year} ${clock(date)}`;
};
const DAY = 86_400_000;
/** A UTC day's heading: "Today · Saturday 7 Nov", "Yesterday · …", then "Thursday 5 Nov", with the year when it isn't this one. */
const dayLabel = (date: Date, now: number) => {
  const at = parts(date);
  const days = Math.floor(now / DAY) - Math.floor(date.getTime() / DAY);
  const name = `${weekdays[at.weekDay]} ${at.day} ${months[at.month - 1]}${at.year === parts(now).year ? "" : ` ${at.year}`}`;
  return days === 0 ? `Today · ${name}` : days === 1 ? `Yesterday · ${name}` : name;
};

const personName = (names: LogNames, id: string) => names.people.get(id) ?? id;
/** Who made the call: "Jordan Lee", or "Jordan Lee via Claude" with the client name approved at consent. */
const who = (names: LogNames, entry: InvocationLog.Invocation) =>
  `${personName(names, entry.initiatingViewerId)}${entry.agent === null ? "" : ` via ${entry.agent.name}`}`;
const version = (names: LogNames, id: string) => {
  const number = names.versions.get(id);
  return number === undefined ? "an unknown version" : `v${number}`;
};

/** Timing facts for a top-level entry: duration, retries and a reply its page never got. */
const timing = (entry: InvocationLog.Invocation) =>
  [
    duration(entry.durationMs) ?? (entry.outcome === "pending" ? "running" : "no duration"),
    entry.attempts > 1 ? `${entry.attempts} attempts` : null,
    entry.settledAt !== null && !entry.replyDelivered ? "reply not delivered" : null
  ]
    .filter((part) => part !== null)
    .join(" · ");

/** An integration's operations are named `<integration>.<method>`. */
const isConnectionCall = (op: string) =>
  integrations.some((integration) => op.startsWith(`${integration}.`));
const callLabel = (op: string) =>
  isConnectionCall(op)
    ? "connection call"
    : op.startsWith("tables.")
      ? "table write"
      : op.startsWith("files.")
        ? "file write"
        : "call";
// Stored relations are quoted identifiers; plain ones read better bare.
const resource = (value: string) => value.replace(/"([a-z_][a-z0-9_]*)"/gu, "$1");
/**
 * "postgres/warehouse.customers.list": the connection by name (its id once deleted), relation,
 * method. A PostHog query's resource is its name, shown as written: "posthog/product.query daily".
 * A Pidgeon call's resource names its operation: "pidgeon/support.threads.get thr_1". An Attio
 * call's names its object or list, as a relation: "attio/crm.deals.listRecords". An IMAP call
 * names no folder or message, only its operation: "imap/invoices.scanMessages".
 */
const connectionCall = (item: InvocationLog.TreeItem, names: LogNames) => {
  const name =
    item.connectionId === null
      ? "connection"
      : (names.connections.get(item.connectionId) ?? item.connectionId);
  const method = item.name.slice(item.name.indexOf(".") + 1);
  if (item.name.startsWith("pidgeon.")) return `${name}.${item.resource ?? method}`;
  if (item.name.startsWith("posthog."))
    return `${name}.${method}${item.resource === null ? "" : ` ${item.resource}`}`;
  const relation =
    item.resource === null ? "" : `.${resource(item.resource).replace(/^public\./u, "")}`;
  return `${name}${relation}.${method}`;
};

type LogLine = typeof Schema.Json.Type;
// `ctx.log(message, details?)` stores this shape; anything else prints as JSON.
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const isMessage = Schema.is(
  Schema.Struct({ message: Schema.String, details: Schema.optionalKey(Schema.Json) })
);
const lineText = (line: LogLine) =>
  isMessage(line)
    ? `${line.message}${line.details === undefined ? "" : ` ${encodeJson(line.details)}`}`
    : encodeJson(line);
const logLines = (lines: ReadonlyArray<LogLine>) =>
  lines.length === 0
    ? ""
    : `<pre class="code-panel"><code>${escapeHtml(lines.map(lineText).join("\n"))}</code></pre>`;

/**
 * The steps under one invocation in sentence form, nested handlers carrying their own steps. A step
 * that acted as the entry's person names them as the entry does, via their agent.
 */
const tree = (
  parentId: string,
  children: ReadonlyMap<string, ReadonlyArray<InvocationLog.TreeItem>>,
  names: LogNames,
  entry: InvocationLog.Invocation
): string => {
  const items = children.get(parentId) ?? [];
  if (items.length === 0) return "";
  const rows = items.map((item) => {
    const what =
      item.type === "invocation"
        ? `${item.name} (${item.kind})`
        : isConnectionCall(item.name)
          ? `${connectionCall(item, names)} (${callLabel(item.name)})`
          : `${item.name}${item.resource === null ? "" : ` ${resource(item.resource)}`} (${callLabel(item.name)})`;
    const as =
      item.effectivePrincipal === "patch"
        ? "the patch"
        : item.effectivePrincipal === entry.initiatingViewerId
          ? who(names, entry)
          : personName(names, item.effectivePrincipal);
    const facts = [
      duration(item.durationMs),
      item.rowCount === null ? null : `${item.rowCount} ${item.rowCount === 1 ? "row" : "rows"}`,
      item.attempts > 1 ? `${item.attempts} attempts` : null
    ].filter((part) => part !== null);
    return `<li class="list-row"><p>${escapeHtml(`${what} · as ${as}`)} ${outcome(item.outcome, item.outcomeCode)}${facts.length === 0 ? "" : ` <span class="meta">${escapeHtml(facts.join(" · "))}</span>`}</p>${item.type === "invocation" ? tree(item.id, children, names, entry) + logLines(item.logLines) : ""}</li>`;
  });
  return `<ol class="list list-compact list-tree">${rows.join("")}</ol>`;
};

/** What an entry opens to: the calls it made as a tree, and its own log lines. None without either. */
const expansion = (entry: InvocationLog.Entry, names: LogNames): GroupedRow["expand"] => {
  const lines = entry.invocation.logLines.length;
  const steps = entry.tree.length;
  if (steps === 0 && lines === 0) return undefined;
  const children = new Map<string, InvocationLog.TreeItem[]>();
  for (const item of entry.tree)
    children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  const summary = [
    steps === 0
      ? null
      : `${steps}${entry.truncated ? "+" : ""} ${steps === 1 && !entry.truncated ? "call" : "calls"}`,
    lines === 0 ? null : `${lines} log ${lines === 1 ? "line" : "lines"}`
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const cut = entry.truncated
    ? `<p class="meta">Showing ${steps} calls, outermost first. This entry made more.</p>`
    : "";
  return {
    summary,
    body: `${tree(entry.invocation.id, children, names, entry.invocation)}${cut}${logLines(entry.invocation.logLines)}`,
    open: entry.invocation.outcome !== "success"
  };
};

/** An entry's id in the log, which Recent activity links to and which opens its calls. */
const entryId = (entry: InvocationLog.Invocation) => `entry-${entry.id}`;

/**
 * The log's filters as chips over menus of links, so each filter is a URL and works without
 * script. Choosing one starts again from the newest entries.
 */
const filterChips = (input: {
  readonly patch: Patches.Patch;
  readonly filters: Record<"outcome" | "person" | "handler", string | undefined>;
  readonly people: ReadonlyArray<readonly [string, string]>;
  readonly handlers: ReadonlyArray<string>;
}) => {
  const { patch, filters } = input;
  const chip = (
    key: "outcome" | "person" | "handler",
    label: string,
    any: string,
    options: ReadonlyArray<readonly [string, string]>
  ) => {
    const selected = filters[key];
    // A filter from an older link still shows, even if it left the recent window.
    const shown =
      selected === undefined || options.some(([value]) => value === selected)
        ? options
        : [...options, [selected, selected] as const];
    return chipMenu({
      id: `log-${key}`,
      key: label,
      value: shown.find(([value]) => value === selected)?.[1] ?? any,
      on: selected !== undefined,
      choices: [
        {
          label: any,
          href: logPath(patch, { ...filters, [key]: undefined }),
          current: selected === undefined
        },
        ...shown.map(([value, text]) => ({
          label: text,
          href: logPath(patch, { ...filters, [key]: value }),
          current: value === selected
        }))
      ]
    });
  };
  const filtered = Object.values(filters).some((value) => value !== undefined);
  return `<div class="toolbar">${chip("outcome", "Outcome", "Any", outcomeFilters)}${chip("person", "Person", "Anyone", input.people)}${chip(
    "handler",
    "Handler",
    "Any",
    input.handlers.map((handler) => [handler, handler] as const)
  )}${filtered ? linkButton("Clear filters", logPath(patch), { kind: "quiet", size: "sm" }) : ""}</div>`;
};

/**
 * The log for its owner and admins: filter chips, then the page's entries grouped by UTC day,
 * newest first, each opening in place to its calls and log lines, then the way to older ones.
 */
export const renderLog = (input: {
  readonly patch: Patches.Patch;
  /** What its page calls the patch. */
  readonly title: string;
  readonly now: number;
  readonly names: LogNames;
  readonly entries: ReadonlyArray<InvocationLog.Entry>;
  /** The cursor for Older entries, or null at the start of the log. */
  readonly next: string | null;
  /** A filtered page stopped at the edge of the entries it searched. */
  readonly windowEnded: boolean;
  readonly before: string | undefined;
  readonly filter: InvocationLog.PageFilter;
  readonly choices: {
    readonly handlers: ReadonlyArray<string>;
    readonly viewerIds: ReadonlyArray<string>;
  };
}): string => {
  const { patch, filter, names, now } = input;
  const filters = {
    outcome: filter.outcome,
    person: filter.viewerId,
    handler: filter.handler
  };
  const filtered =
    filter.outcome !== undefined || filter.viewerId !== undefined || filter.handler !== undefined;
  if (input.entries.length === 0 && !filtered && input.before === undefined)
    return emptyState({
      title: "Nothing logged yet",
      body: `Saves and actions appear here as people use ${input.title}; reads appear only when they log or fail.`
    });
  const people = input.choices.viewerIds
    .map((id) => [id, personName(names, id)] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));
  const toolbar = filterChips({ patch, filters, people, handlers: input.choices.handlers });
  const newest =
    input.before === undefined
      ? ""
      : linkButton("Newest entries", logPath(patch, filters), { kind: "quiet" });
  const older =
    input.next === null
      ? ""
      : linkButton("Older entries", logPath(patch, { ...filters, before: input.next }));
  const paging = older || newest ? `<div class="btn-group">${older}${newest}</div>` : "";
  const searched = `${InvocationLog.FILTER_WINDOW.toLocaleString("en-US")} entries`;
  // Filters search a bounded run of entries; say so when older ones were left unsearched.
  const window = input.windowEnded
    ? `<p class="meta">Filters search ${searched} at a time. Choose Older entries to search further back.</p>`
    : "";
  if (input.entries.length === 0)
    return `${toolbar}${
      filtered
        ? emptyState({
            title: "No entries match these filters",
            ...(input.windowEnded ? { body: `In the ${searched} searched.` } : {}),
            action: linkButton("Clear filters", logPath(patch), { size: "sm" })
          })
        : emptyState({ title: "No older entries" })
    }${window}${paging}`;
  const groups: Array<{ label: string; rows: GroupedRow[] }> = [];
  for (const entry of input.entries) {
    const { invocation } = entry;
    const label = dayLabel(invocation.startedAt, now);
    const expand = expansion(entry, names);
    const row: GroupedRow = {
      id: entryId(invocation),
      cells: [
        `<time datetime="${escapeAttribute(invocation.startedAt.toISOString())}">${clock(invocation.startedAt)}</time>`,
        `${person(invocation.initiatingViewerId, personName(names, invocation.initiatingViewerId))}${invocation.agent === null ? "" : ` <span class="muted">via ${escapeHtml(invocation.agent.name)}</span>`}`,
        `<code>${escapeHtml(invocation.handler)}</code> <span class="muted">${escapeHtml(invocation.kind)}</span>`,
        escapeHtml(version(names, invocation.versionId)),
        outcome(invocation.outcome, invocation.outcomeCode),
        escapeHtml(timing(invocation))
      ],
      ...(expand === undefined ? {} : { expand })
    };
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return `${toolbar}${groupedTable({
    label: "Log entries",
    compact: true,
    columns: [
      { label: "Time (UTC)" },
      { label: "Person" },
      { label: "Handler" },
      { label: "Version", hideOnPhone: true },
      { label: "Outcome" },
      { label: "Duration", align: "end", hideOnPhone: true }
    ],
    groups
  })}<p class="meta">Newest first. Mutations and actions always appear; queries appear only when they log or fail.</p>${window}${paging}`;
};

/** Overview's last three entries for the owner and admins, each opening its place in the log. */
export const renderRecentActivity = (input: {
  readonly patch: Patches.Patch;
  readonly now: number;
  readonly names: LogNames;
  readonly entries: ReadonlyArray<InvocationLog.Entry>;
}): string => {
  const path = logPath(input.patch);
  return section({
    id: "recent-activity",
    title: "Recent activity",
    action: linkButton("View log", path, { kind: "quiet", size: "sm" }),
    body:
      input.entries.length === 0
        ? rows([emptyState({ title: "Nothing logged yet" })], true)
        : rows(
            input.entries.map(({ invocation }) =>
              row({
                name: `${who(input.names, invocation)} · ${invocation.handler}`,
                href: `${path}#${entryId(invocation)}`,
                description: `${when(invocation.startedAt, input.now)} UTC · ${version(input.names, invocation.versionId)} ${invocation.kind} · ${timing(invocation)}`,
                end: outcome(invocation.outcome, invocation.outcomeCode)
              })
            ),
            true
          )
  });
};
