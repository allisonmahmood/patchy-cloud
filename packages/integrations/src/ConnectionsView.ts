import { ago, copyLine, copyScriptPath, escapeAttribute, escapeHtml } from "@patchy/core";
import type { RuntimeLog } from "@patchy/runtime";
import type { Usage } from "./ConnectionStore.js";

/**
 * The connections pages, rendered from plain values. One layout serves every integration: an
 * integration supplies only its words, so the index reads the same at one connection or thirty
 * across fifteen integrations.
 */

/** An integration as the pages name it. */
export interface Integration {
  /** The name agents type before the handle: `postgres` in `postgres/warehouse`. */
  readonly key: string;
  readonly label: string;
}

/** An integration Patchy offers, as the catalogue lists it. */
export interface Offer {
  readonly integration: Integration;
  /** What a connection lets patches read. */
  readonly reads: string;
  /** Who it belongs to and what it allows: "Company-wide · read-only". */
  readonly mode: string;
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
  /** A label beside its name wherever it's shown, such as a test connection's. */
  readonly tag?: string;
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
  /** The form field a refusal is about; it then replaces that field's hint instead of heading the page. */
  readonly field?: Field;
}

/** The connection forms' fields a refusal can sit at; an integration names its own credential fields. */
export type Field =
  "handle" | "description" | "credentials" | "region" | "project" | "key" | "address" | "access";

export type View = "all" | "attention" | "unused";
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

export const indexPath = "/company/connections";
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

const name = (connection: { readonly integration: Integration; readonly handle: string }) =>
  `${connection.integration.key}/${connection.handle}`;
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
/** "Ada", "Ada and Ben", "Ada, Ben and Cleo". */
const listed = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const muted = (text: string) => `<span class="supporting-text">${escapeHtml(text)}</span>`;
const hidden = (key: string, value: string) =>
  `<input type="hidden" name="${escapeAttribute(key)}" value="${escapeAttribute(value)}">`;

const noticeDetail = (value: Notice) =>
  `${value.code ? `<br><code>${escapeHtml(value.code)}</code>` : ""}${value.next ? `<br><a href="${escapeAttribute(value.next.href)}">${escapeHtml(value.next.label)}</a>` : ""}`;
/** A titled notice's title and message, or its message alone. */
const noticeText = (value: Notice) =>
  value.title === undefined
    ? escapeHtml(value.message)
    : `<strong class="note-title">${escapeHtml(value.title)}</strong>${escapeHtml(value.message)}`;

/** A refusal is an alert; a completed action is a status. A field's refusal sits with its field. */
export const notice = (value: Notice | undefined) =>
  value === undefined || value.field !== undefined
    ? ""
    : `<div class="note ${value.status ? "note-refused" : "note-ok"}" role="${value.status ? "alert" : "status"}">${noticeText(value)}${noticeDetail(value)}</div>`;

/**
 * A field's hint, or after a refusal at that field the callout that replaces it, with the
 * attributes that mark the field at fault. Forms that use it set `novalidate`.
 */
export const fieldNote = (id: string, field: Field, hint: string, refusal: Notice | undefined) =>
  refusal?.field === field
    ? {
        attributes: ` aria-describedby="${id}-error" aria-invalid="true" autofocus`,
        note: `<div class="note note-refused field-callout" id="${id}-error" role="alert"><strong class="note-title">${escapeHtml(refusal.title ?? refusal.message)}</strong>${refusal.title === undefined ? "" : `<p>${escapeHtml(refusal.message)}</p>`}${noticeDetail(refusal)}</div>`
      }
    : {
        attributes: ` aria-describedby="${id}-hint"`,
        note: `<p id="${id}-hint" class="field-hint">${escapeHtml(hint)}</p>`
      };

export const styles = `
    .connections-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 24px; }
    .connections-head > div { max-width: 640px; }
    .connections-subpage { max-width: 760px; margin-inline: auto; }
    .connections-filters { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 240px) auto; gap: 0 12px; align-items: end; margin-top: 20px; }
    .connections-views { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .connections-table { overflow-x: auto; }
    .connections-index { min-width: 760px; }
    .connections-index td:first-child { width: 36%; }
    .connections-index time { white-space: nowrap; }
    /* Call cells keep words whole, so a narrow page scrolls the table rather than splitting "accounts.get". */
    .connections-calls { min-width: 720px; overflow-wrap: break-word; }
    .connections-calls time { white-space: nowrap; }
    .connections-line { display: block; }
    .connections-offer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: center; }
    .connection-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .connection-split { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 36px; align-items: start; }
    .connection-aside { position: sticky; top: 24px; }
    .connection-actions { display: grid; gap: 8px; }
    .connection-actions > form { display: grid; }
    @media (max-width: 860px) {
      .connection-split, .connections-filters { grid-template-columns: minmax(0, 1fr); }
      .connection-aside { position: static; }
    }
`;

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
  usage.usedBy.length > 0
    ? escapeHtml(plural(usage.usedBy.length, "patch", "patches"))
    : unusedNow(usage);

const lastCallCell = (lastCalls: LastCalls, id: string, now: number) => {
  if (lastCalls === "unavailable") return muted("Unknown");
  const at = lastCalls.get(id);
  return at === undefined
    ? muted("Never")
    : `<time datetime="${escapeAttribute(at)}">${escapeHtml(ago(at, now))}</time>`;
};

const table = (rows: ReadonlyArray<Row>, lastCalls: LastCalls | undefined, now: number) =>
  `<div class="connections-table"><table class="table connections-index"><thead><tr><th scope="col">Connection</th><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Used by</th>${lastCalls === undefined ? "" : '<th scope="col">Last call</th>'}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr><td><a href="${escapeAttribute(connectionPath(row.id))}"><strong>${escapeHtml(name(row))}</strong></a>${tag(row.tag)}<span class="supporting-text connections-line">${escapeHtml(row.description || "No description")}</span></td><td>${escapeHtml(`${row.integration.label} · ${row.source}`)}</td><td>${row.status === "connected" ? muted("Connected") : '<span class="pill">Disconnected</span>'}</td><td>${usedByCell(row)}</td>${lastCalls === undefined ? "" : `<td>${lastCallCell(lastCalls, row.id, now)}</td>`}</tr>`
    )
    .join("")}</tbody></table></div>`;

/** The catalogue's rows: what each offered integration reads and how it connects. */
const catalogue = (offers: ReadonlyArray<Offer>, rows: ReadonlyArray<Row>, admin: boolean) =>
  `<ul class="list">${offers
    .map((offer) => {
      const count = rows.filter((row) => row.integration.key === offer.integration.key).length;
      return `<li class="list-row connections-offer"><div><p><strong>${escapeHtml(offer.integration.label)}</strong>${count > 0 ? ` ${muted(`· ${plural(count, "connection")}`)}` : ""}</p><p class="supporting-text">${escapeHtml(offer.reads)}</p><p class="supporting-text">${escapeHtml(offer.mode)}</p></div>${admin ? `<a class="btn" href="${escapeAttribute(connectPath(offer.integration.key))}">Connect ${escapeHtml(offer.integration.label)}</a>` : ""}</li>`;
    })
    .join("")}</ul>`;
/** Where a company tells Patchy what it would use; the company's contact for now. */
const contact = "mailto:allison@patchyhq.com";
const onRequest = `<p class="supporting-text"><a href="${contact}">Request an integration</a></p>`;

/** Rows the filters keep; a member's view never narrows to Unused. */
const matches = (row: Row, filters: Filters) =>
  (filters.q === "" ||
    name(row).toLowerCase().includes(filters.q) ||
    row.description.toLowerCase().includes(filters.q)) &&
  (filters.source === undefined || row.integration.key === filters.source) &&
  (filters.view === "all" ||
    (filters.view === "attention" ? row.status !== "connected" : !row.declared));

const controls = (rows: ReadonlyArray<Row>, filters: Filters, admin: boolean) => {
  const sources = [
    ...new Map(rows.map((row) => [row.integration.key, row.integration])).values()
  ].sort((a, b) => a.label.localeCompare(b.label));
  const options = sources
    .map(
      (integration) =>
        `<option value="${escapeAttribute(integration.key)}"${integration.key === filters.source ? " selected" : ""}>${escapeHtml(`${integration.label} (${rows.filter((row) => row.integration.key === integration.key).length})`)}</option>`
    )
    .join("");
  const views: ReadonlyArray<readonly [View, string, number]> = [
    ["all", "All", rows.length],
    ["attention", "Needs attention", rows.filter((row) => row.status !== "connected").length],
    ...(admin ? [["unused", "Unused", rows.filter((row) => !row.declared).length] as const] : [])
  ];
  return `<form class="connections-filters" method="get" action="${indexPath}">${filters.view === "all" ? "" : hidden("view", filters.view)}<div><label class="field-label" for="connections-q">Search</label><input class="field" type="search" id="connections-q" name="q" value="${escapeAttribute(filters.q)}" placeholder="Name or description" maxlength="100"></div><div><label class="field-label" for="connections-source">Integration</label><select class="field" id="connections-source" name="source"><option value="">All integrations</option>${options}</select></div><div><button class="btn" type="submit">Filter</button></div></form><nav class="connections-views" aria-label="Show">${views
    .map(
      ([view, label, count]) =>
        `<a class="btn${view === filters.view ? "" : " btn-quiet"}" href="${escapeAttribute(filterPath({ ...filters, view }))}"${view === filters.view ? ' aria-current="page"' : ""}>${escapeHtml(`${label} ${count}`)}</a>`
    )
    .join("")}</nav>`;
};

/** Disconnected sources, each named, for the admins who can fix them. */
const attention = (rows: ReadonlyArray<Row>) => {
  const off = rows.filter((row) => row.status !== "connected");
  if (off.length === 0) return "";
  return `<div class="note note-warn"><strong class="note-title">${escapeHtml(off.length === 1 ? "1 connection needs attention" : `${off.length} connections need attention`)}</strong><p>${off
    .map(
      (row) =>
        `<a href="${escapeAttribute(connectionPath(row.id))}">${escapeHtml(name(row))}</a> is disconnected; ${escapeHtml(row.usedBy.length === 0 ? "nothing uses it." : `${plural(row.usedBy.length, "patch", "patches")} can't read it.`)}`
    )
    .join(" ")}</p></div>`;
};

/**
 * `/company/connections`: one table across integrations. Its controls appear once it outgrows a
 * screen; filters in a link still apply below that, so a saved view keeps its meaning.
 */
export const renderIndex = (input: {
  readonly admin: boolean;
  readonly company: string;
  /** Active admins' names, for a member with nothing connected. */
  readonly admins: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Row>;
  /** Admins only; members never read the call log. */
  readonly lastCalls?: LastCalls;
  readonly offers: ReadonlyArray<Offer>;
  readonly filters: Filters;
  readonly now: number;
  readonly notice?: Notice;
}): string => {
  const { admin, rows } = input;
  const all = [...rows].sort((a, b) => name(a).localeCompare(name(b)));
  if (all.length === 0) {
    const head = `<h1 class="page-heading">Integrations</h1>${notice(input.notice)}`;
    return admin
      ? `${head}<section class="section"><h2 class="section-heading">Connect an integration</h2>${catalogue(input.offers, all, true)}${onRequest}</section>`
      : `${head}<div class="note"><strong class="note-title">Nothing is connected yet</strong><p>${escapeHtml(`Only admins can connect integrations.${input.admins.length === 0 ? "" : ` At ${input.company} that's ${listed(input.admins)}.`}`)}</p></div><section class="section"><h2 class="section-heading">What Patchy can connect</h2>${catalogue(input.offers, all, false)}</section>`;
  }
  const many = all.length >= CONTROLS_AT;
  // A member's link to Unused shows everything rather than a view they cannot choose.
  const filters =
    input.filters.view === "unused" && !admin
      ? { ...input.filters, view: "all" as const }
      : input.filters;
  const integrations = new Set(all.map((row) => row.integration.key)).size;
  const head = `<div class="connections-head"><div><h1 class="page-heading">Integrations</h1>${many ? `<p class="supporting-text">${escapeHtml(`${plural(all.length, "connection")} from ${plural(integrations, "integration")}`)}</p>` : ""}</div>${admin ? `<a class="btn btn-primary" href="${cataloguePath}">Connect an integration</a>` : ""}</div>`;
  const shown = all.filter((row) => matches(row, filters));
  const filtered = filters.q !== "" || filters.source !== undefined || filters.view !== "all";
  const clear = `<a href="${indexPath}">Clear filters</a>`;
  const count = `<p class="supporting-text">${escapeHtml(`Showing ${shown.length} of ${all.length}.`)} ${clear}</p>`;
  const list =
    shown.length === 0
      ? `<p>No connections match these filters.</p>${count}`
      : `${table(shown, admin ? input.lastCalls : undefined, input.now)}${filtered ? count : ""}`;
  return `${head}${notice(input.notice)}${admin ? attention(all) : ""}${many ? controls(all, filters, admin) : ""}${list}`;
};

/** `/company/connections/connect`: every integration Patchy offers, behind one "Connect an integration". */
export const renderCatalogue = (input: {
  readonly admin: boolean;
  readonly rows: ReadonlyArray<Row>;
  readonly offers: ReadonlyArray<Offer>;
}): string =>
  `<article class="connections-subpage"><p><a href="${indexPath}">Integrations</a></p><h1 class="page-heading">Connect an integration</h1>${input.admin ? "" : '<p class="supporting-text">Only admins can connect integrations.</p>'}${catalogue(input.offers, input.rows, input.admin)}${onRequest}</article>`;

/** One step of a connect walkthrough that happens outside the form. */
export interface Step {
  readonly title: string;
  readonly text: string;
}
/** The steps around a connect form: what to do first, the form's own step, and what comes next. */
export interface Walkthrough {
  readonly before: ReadonlyArray<Step>;
  readonly current: string;
  readonly after: ReadonlyArray<Step>;
}

const step = (
  state: "done" | "current" | "upcoming",
  marker: string,
  title: string,
  body: string
) =>
  `<li class="step${state === "upcoming" ? "" : ` step-${state}`}"${state === "current" ? ' aria-current="step"' : ""}><span class="step-marker" aria-hidden="true">${marker}</span><div><h2 class="step-title">${escapeHtml(title)}</h2>${body}</div></li>`;

/**
 * An integration's connect form inside the shared frame; the integration supplies the fields. With
 * a walkthrough, the form is the open step between what to do first and what comes after. Cancel
 * goes `back` to where the person chose the integration.
 */
export const renderConnect = (input: {
  readonly integration: Integration;
  readonly intro: string;
  readonly fields: string;
  readonly walkthrough?: Walkthrough;
  readonly notice?: Notice;
  readonly back: string;
}): string => {
  const form = `<form method="post" action="${escapeAttribute(connectPath(input.integration.key))}" novalidate>${input.fields}<div class="actions"><button class="btn btn-primary" type="submit">Test and connect</button><a class="btn btn-quiet" href="${escapeAttribute(input.back)}">Cancel</a></div></form>`;
  const walkthrough = input.walkthrough;
  const body =
    walkthrough === undefined
      ? form
      : `<ol class="steps">${[
          ...walkthrough.before.map((item) =>
            step("done", "✓", item.title, `<p>${escapeHtml(item.text)}</p>`)
          ),
          step(
            "current",
            String(walkthrough.before.length + 1),
            walkthrough.current,
            `<div class="step-card">${form}</div>`
          ),
          ...walkthrough.after.map((item, index) =>
            step(
              "upcoming",
              String(walkthrough.before.length + 2 + index),
              item.title,
              `<p>${escapeHtml(item.text)}</p>`
            )
          )
        ].join("")}</ol>`;
  return `<article class="connections-subpage"><p><a href="${indexPath}">Integrations</a> / <a href="${cataloguePath}">Connect an integration</a></p><h1 class="page-heading">Connect ${escapeHtml(input.integration.label)}</h1><p>${escapeHtml(input.intro)}</p>${notice(input.notice)}${body}</article>`;
};

// ---------- one connection ----------

/** A connection as its own page shows it. */
export interface Connection extends Usage {
  readonly id: string;
  readonly integration: Integration;
  readonly handle: string;
  readonly description: string;
  readonly status: "connected" | "disconnected";
  readonly mode: string;
  readonly testedAt: string | null;
  readonly addedBy: string;
  /** The integration's facts about where it reads from, as label and value. */
  readonly facts: ReadonlyArray<readonly [string, string]>;
  /** What the page says about the connection's state until it changes, such as a key left over. */
  readonly standing?: ReadonlyArray<Standing>;
  /** A label beside its name, as the index shows it. */
  readonly tag?: string;
}

/** A notice that stays on a connection's page while what it says holds. */
export interface Standing {
  readonly tone: "ok" | "warn" | "refused";
  readonly title: string;
  readonly text: string;
  /** An action that settles it, such as Replace key. */
  readonly action?: { readonly href: string; readonly label: string; readonly primary?: boolean };
}

/** What the connection's current metadata lets patches read, in the integration's words. */
export interface Reads {
  /** The section's heading, where an integration's connections also act: "What patches can read and do". */
  readonly heading?: string;
  readonly summary: string;
  readonly items: ReadonlyArray<string>;
  readonly more: number;
  readonly revision: number;
  readonly foundAt: string | null;
}

/** The labels of an integration's own actions. */
export interface Actions {
  readonly refresh: string;
  /** The form that replaces the credentials, keeping where they point. */
  readonly rotate: string;
  /** The form that points the connection elsewhere; absent where it can't move. */
  readonly retarget?: string;
  /** The form that changes what the stored credentials may do. */
  readonly access?: string;
}

/** Stored ids in the reader's words, for the recent calls. */
export interface CallNames {
  readonly people: ReadonlyMap<string, string>;
  readonly versions: ReadonlyMap<string, { readonly patch: string; readonly number: number }>;
}

export const RECENT_CALLS = 10;

const outcome = (call: RuntimeLog.Call) => {
  const [label, tone] =
    call.outcome === "success"
      ? ["Succeeded", " pill-done"]
      : call.outcome === "pending"
        ? ["Running", " pill-progress"]
        : call.outcome === "unknown"
          ? ["Unknown", ""]
          : ["Failed", " pill-failed"];
  return `<span class="connection-status"><span class="pill${tone}">${label}</span>${call.outcomeCode === null ? "" : `<code>${escapeHtml(call.outcomeCode)}</code>`}</span>`;
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
 * resource names its own operation: "messages.send “Order 1043” to sam@example.com".
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
    return `<span class="pill">Dev</span> ${escapeHtml(`patchy dev on ${call.machine.name}`)}`;
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
    ? `The machine key ${call.machine.name}, reading the real connection while building a patch`
    : call.agent !== null
      ? `A person's agent, ${call.agent.name}, using a patch's agent tool`
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
    call.rowCount === null ? null : plural(call.rowCount, "row")
  ]
    .filter((part) => part !== null)
    .join(" · ") || "—";

const recentCalls = (calls: ReadonlyArray<RuntimeLog.Call> | "unavailable", names: CallNames) => {
  const latest =
    calls !== "unavailable" && calls.length >= RECENT_CALLS
      ? `The latest ${RECENT_CALLS} calls`
      : "Calls";
  const intro = `<p class="supporting-text">${latest}, newest first. Only admins see this. Query text keeps its first 8 KiB; parameters and returned rows are never logged.</p>`;
  const body =
    calls === "unavailable"
      ? '<div class="note note-warn" role="alert">Recent calls could not be loaded. Reload the page to try again.</div>'
      : calls.length === 0
        ? "<p>No calls yet.</p>"
        : `<div class="connections-table"><table class="table connections-calls"><thead><tr><th scope="col">When (UTC)</th><th scope="col">From</th><th scope="col">Call</th><th scope="col">As</th><th scope="col">Took</th><th scope="col">Outcome</th></tr></thead><tbody>${calls
            .map(
              (call) =>
                `<tr><td>${minute(call.at)}</td><td>${from(call, names)}</td><td><code>${escapeHtml(callName(call))}</code></td><td>${escapeHtml(as(call, names))}</td><td>${escapeHtml(took(call))}</td><td>${outcome(call)}</td></tr><tr class="table-expand"><td colspan="6"><details><summary>Details</summary><dl class="facts">${call.patchId === null ? "" : `<dt>Patch / version</dt><dd><code>${escapeHtml(call.patchId)}</code> / <code>${escapeHtml(call.versionId ?? "unknown")}</code></dd>`}<dt>Correlation ID</dt><dd><code>${escapeHtml(call.correlationId)}</code></dd><dt>Credential</dt><dd>${escapeHtml(credential(call))}</dd></dl>${call.sql === null ? "" : `<pre class="code-panel"><code>${escapeHtml(call.sql)}</code></pre>`}</details></td></tr>`
            )
            .join("")}</tbody></table></div>`;
  return `<section class="section" aria-labelledby="connection-calls"><h2 class="section-heading" id="connection-calls">Recent calls</h2>${intro}${body}</section>`;
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

const postButton = (path: string, label: string) =>
  `<form method="post" action="${escapeAttribute(path)}"><button class="btn" type="submit">${escapeHtml(label)}</button></form>`;
const linkButton = (path: string, label: string, tone = "") =>
  `<a class="btn${tone}" href="${escapeAttribute(path)}">${escapeHtml(label)}</a>`;

const adminActions = (connection: Connection, actions: Actions) => {
  const path = (action: string) => connectionPath(connection.id, action);
  const connected = connection.status === "connected";
  return `<div class="connection-actions">${postButton(path("test"), "Test connection")}${connected ? postButton(path("refresh"), actions.refresh) : ""}${actions.access === undefined ? "" : linkButton(path("access"), `${actions.access}…`)}${linkButton(path("rotate"), `${actions.rotate}…`)}${actions.retarget === undefined ? "" : linkButton(path("retarget"), `${actions.retarget}…`)}${linkButton(path("description"), "Edit description…")}${connected ? linkButton(path("disconnect"), "Disconnect…", " btn-danger") : postButton(path("reconnect"), "Reconnect")}${connection.declared ? "" : linkButton(path("delete"), "Delete…", " btn-quiet")}</div>${connection.declared ? '<p class="supporting-text">Delete is offered once no stored patch version declares this connection.</p>' : ""}${connected ? "" : '<p class="supporting-text">Reconnecting tests the stored credentials before restoring access.</p>'}`;
};

/** The label after a connection's name, such as a test connection's. */
const tag = (value: string | undefined) =>
  value === undefined ? "" : `<span class="tag">${escapeHtml(value)}</span>`;

const standing = (item: Standing) =>
  `<div class="note note-${item.tone}" role="${item.tone === "ok" ? "status" : "alert"}"><strong class="note-title">${escapeHtml(item.title)}</strong><p>${escapeHtml(item.text)}</p>${item.action === undefined ? "" : `<div class="actions">${linkButton(item.action.href, item.action.label, item.action.primary === true ? " btn-primary" : "")}</div>`}</div>`;

/** `/company/connections/:id`: the same layout for every integration. */
export const renderConnection = (input: {
  readonly connection: Connection;
  readonly reads: Reads | null;
  readonly actions: Actions;
  /** Admins only; members never read the call log. */
  readonly calls?: {
    readonly list: ReadonlyArray<RuntimeLog.Call> | "unavailable";
    readonly names: CallNames;
  };
  readonly admin: boolean;
  readonly now: number;
  readonly notice?: Notice;
}): string => {
  const { connection, reads, now } = input;
  const connected = connection.status === "connected";
  const tested =
    connection.testedAt === null ? "never tested" : `tested ${ago(connection.testedAt, now)}`;
  const status = `<p class="connection-status"><span class="pill${connected ? " pill-done" : ""}">${connected ? "Connected" : "Disconnected"}</span>${muted(`${connection.integration.label} · ${connection.mode} · ${tested}`)}</p>`;
  const add = connected
    ? `${copyLine(`patchy add ${name(connection)}`, "Command that adds this connection to a patch, select to copy")}<script defer src="${copyScriptPath}"></script>`
    : "";
  const readsSection = `<section class="section" aria-labelledby="connection-reads"><h2 class="section-heading" id="connection-reads">${escapeHtml(reads?.heading ?? "What patches can read")}</h2>${
    reads === null
      ? "<p>Its current metadata is unavailable. Refresh it to see what patches can read.</p>"
      : `<p>${escapeHtml(`${reads.summary} Found ${reads.foundAt === null ? "at an unknown time" : ago(reads.foundAt, now)} (revision ${reads.revision}).`)}</p>${reads.items.length === 0 ? "" : `<ul class="list list-compact">${reads.items.map((item) => `<li class="list-row"><code>${escapeHtml(item)}</code></li>`).join("")}</ul>`}<p class="supporting-text">${escapeHtml(`${reads.more > 0 ? `And ${reads.more} more. ` : ""}Agents get the full discovered metadata when they add the connection.`)}</p>`
  }</section>`;
  const facts = `<dl class="facts">${connection.facts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}<dt>Added by</dt><dd>${escapeHtml(connection.addedBy)}</dd><dt>Used by</dt><dd>${usedByFact(connection)}</dd></dl>`;
  return `<p><a href="${indexPath}">Integrations</a> / ${escapeHtml(connection.integration.label)}</p><h1 class="page-heading">${escapeHtml(name(connection))}${tag(connection.tag)}</h1>${status}<p>${escapeHtml(connection.description || "No description.")}</p>${notice(input.notice)}${(connection.standing ?? []).map(standing).join("")}${add}<div class="connection-split"><div>${readsSection}${input.calls === undefined ? "" : recentCalls(input.calls.list, input.calls.names)}</div><aside class="connection-aside" aria-label="About this connection">${facts}${input.admin ? adminActions(connection, input.actions) : '<p class="supporting-text">Only admins can change this connection.</p>'}</aside></div>`;
};

// ---------- confirmations ----------

export type Confirmation =
  "rotate" | "retarget" | "access" | "description" | "disconnect" | "delete";

/**
 * A risky or form-backed action on its own page, as the portal confirms retire and delete. The
 * integration supplies credential fields; disconnect names the live patches that lose access.
 */
export const renderConfirmation = (input: {
  readonly connection: Connection;
  readonly action: Confirmation;
  readonly actions: Actions;
  /** The integration's own page for rotate, retarget and access: its title, meaning and fields. */
  readonly form?: {
    readonly title: string;
    readonly consequence: string;
    readonly fields: string;
    /** The submit button's label, where testing first isn't what it does. */
    readonly submit?: string;
  };
  /** The integration's own words for what deleting or disconnecting does, where they differ. */
  readonly consequences?: Partial<Record<"delete" | "disconnect", string>>;
  readonly description?: string;
  readonly notice?: Notice;
}): string => {
  const { connection, action } = input;
  const label = name(connection);
  const back = connectionPath(connection.id);
  const affected =
    connection.usedBy.length === 0
      ? '<p class="supporting-text">No live patch declares it now.</p>'
      : `<p>These patches lose access on their next call:</p><ul class="confirmation-list">${connection.usedBy.map((patch) => `<li>${patchLink(patch)}</li>`).join("")}</ul>`;
  const page = {
    rotate: {
      title: input.form?.title ?? label,
      consequence: input.form?.consequence ?? "",
      fields: input.form?.fields ?? "",
      submit: [
        "btn-primary",
        input.form?.submit ?? `Test and ${input.actions.rotate.toLowerCase()}`
      ]
    },
    retarget: {
      title: input.form?.title ?? label,
      consequence: input.form?.consequence ?? "",
      fields: input.form?.fields ?? "",
      submit: [
        "btn-primary",
        input.form?.submit ??
          `Test and ${(input.actions.retarget ?? "point it elsewhere").toLowerCase()}`
      ]
    },
    access: {
      title: input.form?.title ?? label,
      consequence: input.form?.consequence ?? "",
      fields: input.form?.fields ?? "",
      submit: ["btn-primary", input.form?.submit ?? input.actions.access ?? "Change access"]
    },
    description: {
      title: `Edit the description of ${label}`,
      consequence:
        "One line telling builders what this is. With many connections, it's how people find the right one. It neither grants nor restricts access.",
      fields: (() => {
        const note = fieldNote(
          "connection-description",
          "description",
          "One line, at most 500 characters.",
          input.notice
        );
        return `<label class="field-label" for="connection-description">Description</label><input class="field" id="connection-description" name="description" maxlength="500" value="${escapeAttribute(input.description ?? connection.description)}"${note.attributes}>${note.note}`;
      })(),
      submit: ["btn-primary", "Save description"]
    },
    disconnect: {
      title: `Disconnect ${label}?`,
      consequence:
        input.consequences?.disconnect ??
        `Patches that declare it can't read it until an admin reconnects it. Its credentials, what patches can read and every declaration are kept; reconnecting tests the credentials and restores access.`,
      fields: affected,
      submit: ["btn-danger", `Disconnect ${label}`]
    },
    delete: {
      title: `Delete ${label}?`,
      consequence:
        input.consequences?.delete ??
        `No stored patch version declares it. Deleting removes its credentials and frees the name; the metadata patches were published against is kept. This can't be undone.`,
      fields: "",
      submit: ["btn-danger", `Delete ${label}`]
    }
  }[action];
  return `<article class="connections-subpage"><p><a href="${escapeAttribute(back)}">Back to ${escapeHtml(label)}</a></p><h1 class="page-heading">${escapeHtml(page.title)}</h1>${notice(input.notice)}<form class="confirmation-form" method="post" action="${escapeAttribute(connectionPath(connection.id, action))}" novalidate><p class="confirmation-consequence">${escapeHtml(page.consequence)}</p>${page.fields}<div class="confirmation-actions"><button class="btn ${page.submit[0]}" type="submit">${escapeHtml(page.submit[1])}</button><a class="btn btn-quiet" href="${escapeAttribute(back)}">Cancel</a></div></form></article>`;
};
