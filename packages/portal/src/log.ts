import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { escapeAttribute, escapeHtml } from "@patchy/core";
import type { Patches } from "@patchy/patches";
import type { InvocationLog } from "@patchy/runtime";

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
  /** The patch as people know it: its distinct title, else its name. */
  readonly patch: string;
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

const outcome = (value: InvocationLog.Outcome, code: string | null) => {
  const [label, tone] =
    value === "success"
      ? ["Succeeded", " pill-done"]
      : value === "pending"
        ? ["Running", " pill-progress"]
        : value === "unknown_outcome"
          ? ["Unknown", ""]
          : value === "handler_error" || (code !== null && refusalCodes.has(code))
            ? ["Refused", " pill-failed"]
            : ["Failed", " pill-failed"];
  const shown =
    code !== null && code !== "unknown_outcome" ? `<code>${escapeHtml(code)}</code>` : "";
  return `<span class="log-outcome"><span class="pill${tone}">${label}</span>${shown}</span>`;
};

const duration = (ms: number | null) =>
  ms === null ? null : ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "28 Sep 14:02", with the year only when it is not the current one. Always UTC. */
const when = (date: Date, now: number) => {
  const at = DateTime.toPartsUtc(DateTime.makeUnsafe(date));
  const year = at.year === DateTime.toPartsUtc(DateTime.makeUnsafe(now)).year ? "" : ` ${at.year}`;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.day} ${months[at.month - 1]}${year} ${pad(at.hour)}:${pad(at.minute)}`;
};
const time = (date: Date, now: number, suffix = "") =>
  `<time datetime="${escapeAttribute(date.toISOString())}">${escapeHtml(when(date, now))}${suffix}</time>`;

const person = (names: LogNames, id: string) => names.people.get(id) ?? id;
const version = (names: LogNames, id: string) => {
  const number = names.versions.get(id);
  return number === undefined ? "an unknown version" : `v${number}`;
};

/** "Alice · Sales CRM v12 · leads.import (action)": who ran what, in the reader's words. */
const sentence = (entry: InvocationLog.Invocation, names: LogNames) =>
  `${person(names, entry.initiatingViewerId)} · ${names.patch} ${version(names, entry.versionId)} · ${entry.handler} (${entry.kind})`;

/** Timing facts for a top-level entry: duration, retries and a reply its page never got. */
const timing = (entry: InvocationLog.Invocation) =>
  [
    duration(entry.durationMs) ?? (entry.outcome === "pending" ? "running" : "no duration"),
    entry.attempts > 1 ? `${entry.attempts} attempts` : null,
    entry.settledAt !== null && !entry.replyDelivered ? "reply not delivered" : null
  ]
    .filter((part) => part !== null)
    .join(" · ");

const callLabel = (op: string) =>
  op.startsWith("postgres.")
    ? "connection call"
    : op.startsWith("tables.")
      ? "table write"
      : op.startsWith("files.")
        ? "file write"
        : "call";
// Stored relations are quoted identifiers; plain ones read better bare.
const resource = (value: string) => value.replace(/"([a-z_][a-z0-9_]*)"/gu, "$1");

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

/** The steps under one invocation in sentence form, nested handlers carrying their own steps. */
const tree = (
  parentId: string,
  children: ReadonlyMap<string, ReadonlyArray<InvocationLog.TreeItem>>,
  names: LogNames
): string => {
  const items = children.get(parentId) ?? [];
  if (items.length === 0) return "";
  const rows = items.map((item) => {
    const what =
      item.type === "invocation"
        ? `${item.name} (${item.kind})`
        : `${item.name}${item.resource === null ? "" : ` ${resource(item.resource)}`} (${callLabel(item.name)})`;
    const as =
      item.effectivePrincipal === "patch" ? "the patch" : person(names, item.effectivePrincipal);
    const facts = [
      duration(item.durationMs),
      item.rowCount === null ? null : `${item.rowCount} ${item.rowCount === 1 ? "row" : "rows"}`,
      item.attempts > 1 ? `${item.attempts} attempts` : null
    ].filter((part) => part !== null);
    return `<li class="list-row"><p class="log-status"><span>${escapeHtml(`${what} · as ${as}`)}</span>${outcome(item.outcome, item.outcomeCode)}${facts.length === 0 ? "" : `<span class="supporting-text">${escapeHtml(facts.join(" · "))}</span>`}</p>${item.type === "invocation" ? tree(item.id, children, names) + logLines(item.logLines) : ""}</li>`;
  });
  return `<ol class="list list-compact list-tree">${rows.join("")}</ol>`;
};

const expansion = (entry: InvocationLog.Entry, names: LogNames) => {
  const lines = entry.invocation.logLines.length;
  if (entry.treeTotal === 0 && lines === 0) return "";
  const children = new Map<string, InvocationLog.TreeItem[]>();
  for (const item of entry.tree)
    children.set(item.parentId, [...(children.get(item.parentId) ?? []), item]);
  const summary = [
    entry.treeTotal === 0 ? null : `${entry.treeTotal} ${entry.treeTotal === 1 ? "call" : "calls"}`,
    lines === 0 ? null : `${lines} log ${lines === 1 ? "line" : "lines"}`
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const cut =
    entry.tree.length < entry.treeTotal
      ? `<p class="supporting-text">Showing the first ${entry.tree.length} of ${entry.treeTotal} calls.</p>`
      : "";
  const open = entry.invocation.outcome === "success" ? "" : " open";
  return `<tr class="table-expand"><td colspan="7"><details${open}><summary>${escapeHtml(summary)}</summary>${tree(entry.invocation.id, children, names)}${cut}${logLines(entry.invocation.logLines)}</details></td></tr>`;
};

const entryId = (entry: InvocationLog.Invocation) => `entry-${entry.id}`;

export const renderLog = (input: {
  readonly patch: Patches.Patch;
  readonly all: boolean;
  readonly now: number;
  readonly names: LogNames;
  readonly entries: ReadonlyArray<InvocationLog.Entry>;
  readonly more: boolean;
  readonly before: string | undefined;
  readonly filter: InvocationLog.PageFilter;
  readonly choices: {
    readonly handlers: ReadonlyArray<string>;
    readonly viewerIds: ReadonlyArray<string>;
  };
}): string => {
  const { patch, all, filter, names, now } = input;
  const keep = { all: all ? "1" : undefined };
  const filters = {
    ...keep,
    outcome: filter.outcome,
    person: filter.viewerId,
    handler: filter.handler
  };
  const filtered =
    filter.outcome !== undefined || filter.viewerId !== undefined || filter.handler !== undefined;
  const back = `<p><a href="${escapeAttribute(`/patches/${encodeURIComponent(patch.name)}${all ? "?all=1" : ""}`)}">Back to ${escapeHtml(patch.name)}</a></p><h1 class="page-heading">Log of ${escapeHtml(patch.name)}</h1>`;
  if (input.entries.length === 0 && !filtered && input.before === undefined)
    return `<article>${back}<p>Nothing logged yet. Saves and actions appear here as people use ${escapeHtml(patch.name)}; reads appear only when they log or fail.</p></article>`;
  const select = (
    id: string,
    name: string,
    label: string,
    any: string,
    selected: string | undefined,
    options: ReadonlyArray<readonly [string, string]>
  ) => {
    // A filter from an older link still shows, even if it left the recent window.
    const shown =
      selected === undefined || options.some(([value]) => value === selected)
        ? options
        : [...options, [selected, selected] as const];
    return `<div><label class="field-label" for="${id}">${label}</label><select class="field" id="${id}" name="${name}"><option value="">${any}</option>${shown
      .map(
        ([value, text]) =>
          `<option value="${escapeAttribute(value)}"${value === selected ? " selected" : ""}>${escapeHtml(text)}</option>`
      )
      .join("")}</select></div>`;
  };
  const people = input.choices.viewerIds
    .map((id) => [id, person(names, id)] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));
  const form = `<form class="log-filters" method="get" action="${escapeAttribute(logPath(patch))}">${all ? '<input type="hidden" name="all" value="1">' : ""}${select("log-outcome", "outcome", "Outcome", "All", filter.outcome, outcomeFilters)}${select("log-person", "person", "Person", "Anyone", filter.viewerId, people)}${select(
    "log-handler",
    "handler",
    "Handler",
    "Any handler",
    filter.handler,
    input.choices.handlers.map((handler) => [handler, handler] as const)
  )}<div><button class="btn" type="submit">Filter</button></div></form>`;
  const intro = `<p class="supporting-text">Who ran what, as whom. This is an attribution record, not an access audit. Log lines are written by the patch itself.</p>`;
  const newest =
    input.before === undefined
      ? ""
      : `<a class="btn btn-quiet" href="${escapeAttribute(logPath(patch, filters))}">Newest entries</a>`;
  if (input.entries.length === 0) {
    const empty = filtered
      ? `<p>No entries match these filters.</p><p><a href="${escapeAttribute(logPath(patch, keep))}">Clear filters</a></p>`
      : "<p>No older entries.</p>";
    return `<article>${back}${intro}${form}${empty}${newest ? `<div class="actions">${newest}</div>` : ""}</article>`;
  }
  const rows = input.entries.map((entry) => {
    const { invocation } = entry;
    return `<tr id="${escapeAttribute(entryId(invocation))}"><td>${time(invocation.startedAt, now)}</td><td>${escapeHtml(person(names, invocation.initiatingViewerId))}</td><td>${escapeHtml(version(names, invocation.versionId))}</td><td><code>${escapeHtml(invocation.handler)}</code></td><td>${escapeHtml(invocation.kind)}</td><td>${outcome(invocation.outcome, invocation.outcomeCode)}</td><td>${escapeHtml(timing(invocation))}</td></tr>${expansion(entry, names)}`;
  });
  const last = input.entries.at(-1)!.invocation;
  const older = input.more
    ? `<a class="btn" href="${escapeAttribute(logPath(patch, { ...filters, before: last.id }))}">Older entries</a>`
    : "";
  const paging = older || newest ? `<div class="actions">${older}${newest}</div>` : "";
  return `<article>${back}${intro}${form}<p class="supporting-text">Newest first. Mutations and actions always appear; queries appear only when they log or fail.</p><div class="portal-table"><table class="table log-table" aria-label="Log entries"><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Person</th><th scope="col">Version</th><th scope="col">Handler</th><th scope="col">Kind</th><th scope="col">Outcome</th><th scope="col">Duration</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>${paging}</article>`;
};

/** W-2: the card's last three entries for its owner and admins, each linking into the log. */
export const renderRecentActivity = (input: {
  readonly patch: Patches.Patch;
  readonly all: boolean;
  readonly now: number;
  readonly names: LogNames;
  readonly entries: ReadonlyArray<InvocationLog.Entry>;
}): string => {
  const path = logPath(input.patch, { all: input.all ? "1" : undefined });
  const rows = input.entries.map(({ invocation }) => {
    return `<li class="list-row"><p class="log-status"><a href="${escapeAttribute(`${path}#${entryId(invocation)}`)}"><strong>${escapeHtml(sentence(invocation, input.names))}</strong></a>${outcome(invocation.outcome, invocation.outcomeCode)}</p><p class="supporting-text">${time(invocation.startedAt, input.now, " UTC")} · ${escapeHtml(timing(invocation))}</p></li>`;
  });
  return `<section class="section" aria-labelledby="activity-heading"><h2 class="section-heading" id="activity-heading">Recent activity</h2>${rows.length === 0 ? '<p class="supporting-text">Nothing logged yet.</p>' : `<ol class="list list-compact">${rows.join("")}</ol>`}<p><a href="${escapeAttribute(path)}">See the full log</a></p></section>`;
};
