/**
 * THROWAWAY (prototype #241): the portal's HTML. Pure functions from rows to
 * strings, escaped at every interpolation. The shell is `htmlPage` through
 * `pageResponse`; only the page-only CSS below rides on top of it, lifted from
 * the two static mocks (portal list C, patch page C and its state cards).
 */
import { escapeAttribute, escapeHtml } from "@patchy/core";
import {
  type BrokenSource,
  DELETE_WINDOW_DAYS,
  type Dependant,
  type Member,
  type PatchRow,
  type State,
  stateOf,
  type VersionRow
} from "./PortalQueries.js";

export interface PortalViewer {
  readonly user: { readonly id: string; readonly name: string };
  readonly company: { readonly id: string; readonly handle: string; readonly name: string };
  /** The role the pages act on; the prototype switch can lower a real admin to member. */
  readonly role: "member" | "admin";
  readonly realRole: "member" | "admin";
}

/** Page-only CSS, under the shell: the app bar, two columns, index, card, forms, amber block. */
export const styles = `
    .auth-card { width: min(1180px, calc(100% - 32px)); margin: 32px auto; padding: 0; overflow: hidden; }
    .auth-card > .brand { display: none; }
    .app-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 28px; padding: 14px 26px; border-bottom: 2px solid var(--ink); background: var(--white); }
    .app-bar .brand { font-size: 1rem; margin: 0; }
    .app-nav { display: flex; gap: 4px; flex-wrap: wrap; }
    .app-nav a { padding: 6px 12px; border-radius: 6px; color: var(--ink); text-decoration: none; font-weight: 750; font-size: .95rem; }
    .app-nav a[aria-current="page"] { background: var(--yellow); border: 2px solid var(--ink); box-shadow: 2px 2px 0 var(--ink); }
    .app-who { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; color: var(--muted); font-size: .88rem; font-weight: 650; }
    .app-who .auth-signout { margin: 0; padding: 0; border: 0; display: inline; }
    .app-who .auth-signout button { min-height: 0; }
    .proto-role { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1.5px dashed var(--line-strong); border-radius: 6px; font-size: .78rem; }
    .proto-role button { border: 0; padding: 0 4px; background: none; font: inherit; font-weight: 750; color: var(--blue-dark); text-decoration: underline; cursor: pointer; }
    .proto-role button[aria-current="true"] { color: var(--ink); text-decoration: none; background: var(--yellow); border-radius: 4px; }
    .c-body { display: grid; grid-template-columns: 320px 1fr; }
    .c-index { padding: 22px 18px 30px; border-right: 2px solid var(--ink); background: var(--white); }
    .c-count { margin: 0 0 1rem; color: var(--muted); font-size: .84rem; font-weight: 650; }
    .c-group { font-size: .74rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 1.2rem 0 .3rem; }
    .c-list { list-style: none; margin: 0; padding: 0; }
    .c-list a { display: block; padding: 7px 10px; border-radius: 6px; text-decoration: none; color: var(--ink); font-weight: 600; }
    .c-list a:hover { background: var(--paper-blue); }
    .c-current a { background: var(--yellow); border: 2px solid var(--ink); box-shadow: 2px 2px 0 var(--ink); }
    .c-n { display: block; font-family: var(--font-mono); font-size: .88rem; font-weight: 750; }
    .c-l { display: block; color: var(--muted); font-size: .8rem; font-weight: 550; line-height: 1.35; }
    .c-l.muted { font-style: italic; }
    .c-tag { display: inline-block; padding: 0 6px; border: 1.5px solid var(--line-strong); border-radius: 999px; font-size: .68rem; text-transform: uppercase; }
    .c-off .c-n { color: var(--muted); }
    .c-emptyidx { color: var(--muted); font-size: .9rem; }
    .c-detail { padding: 30px 34px 36px; min-width: 0; }
    .c-addr { margin: 0 0 .4rem; font-family: var(--font-mono); font-size: .9rem; color: var(--muted); overflow-wrap: anywhere; }
    .c-h1 { max-width: none; font-size: 2.2rem; margin-bottom: .2rem; overflow-wrap: anywhere; }
    .c-title { margin: 0 0 .8rem; color: var(--muted); font-size: 1rem; font-weight: 650; }
    .c-desc { font-size: 1.05rem; max-width: 60ch; margin-bottom: .3rem; white-space: pre-line; }
    .c-desc.muted, .c-facts .muted { color: var(--muted); font-style: italic; }
    .c-actor { margin: 0 0 1rem; color: var(--muted); font-size: .84rem; }
    .c-actline { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; margin: 1.2rem 0 1.6rem; }
    .c-actline code { user-select: all; font-size: .9rem; }
    .c-facts { display: grid; grid-template-columns: 170px 1fr; gap: 8px 16px; margin: 0 0 1.6rem; font-size: .95rem; }
    .c-facts dt { color: var(--muted); font-weight: 750; }
    .c-facts dd { margin: 0; overflow-wrap: anywhere; }
    .c-manage { padding-top: 1.2rem; border-top: 2px solid var(--line-strong); }
    .c-manage h2 { font-size: 1.1rem; margin-bottom: .4rem; }
    .c-managenote { color: var(--muted); font-size: .88rem; margin: 0 0 .4rem; }
    .c-adminline { margin: 0 0 1rem; color: var(--amber-ink); font-size: .88rem; font-weight: 700; }
    .c-offcard { background: rgba(18, 17, 15, .03); }
    .pill-off, .pill-warn, .pill-live { min-height: 22px; padding: 1px 9px; font-size: .68rem; vertical-align: middle; }
    .pill-off { background: rgba(18, 17, 15, .06); color: var(--ink-soft); }
    .pill-warn { background: var(--paper-amber); color: var(--amber-ink); }
    .pill-live { background: var(--paper-green); color: var(--green-ink); }
    .sect { padding: 1.2rem 0; border-top: 1px solid var(--line-strong); }
    .sect h3 { margin: 0 0 .5rem; font-size: 1rem; color: var(--ink); }
    .sect p { font-size: .95rem; }
    .f-label { display: block; margin: 0 0 6px; font-size: .88rem; font-weight: 750; color: var(--ink); }
    .f-hint { margin: 6px 0 0; color: var(--muted); font-size: .82rem; max-width: 60ch; }
    .f-in { display: block; width: 100%; min-height: 44px; padding: 9px 12px; border: 1.5px solid var(--ink); border-radius: 6px; background: white; color: var(--ink); font: inherit; font-size: .95rem; }
    textarea.f-in { min-height: 92px; resize: vertical; }
    .f-in.short { max-width: 340px; }
    .f-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; margin-top: 10px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 6px 18px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); color: var(--ink); font: inherit; font-size: .95rem; font-weight: 750; text-decoration: none; box-shadow: 2px 2px 0 var(--ink); cursor: pointer; }
    .btn-primary { background: var(--blue); color: white; }
    .btn-danger { background: var(--paper-amber); color: #b4220f; }
    .btn-quiet { border-color: var(--line-strong); box-shadow: none; }
    .btn-sm { min-height: 34px; padding: 3px 12px; font-size: .85rem; }
    .chk { display: flex; align-items: flex-start; gap: 10px; margin: 10px 0; font-size: .95rem; }
    .chk input { width: 20px; height: 20px; margin: 3px 0 0; flex: none; }
    .radio { display: flex; align-items: flex-start; gap: 10px; margin: 8px 0; font-size: .95rem; }
    .radio input { width: 20px; height: 20px; margin: 3px 0 0; flex: none; }
    .radio strong { display: block; }
    .radio span { display: block; color: var(--muted); font-size: .86rem; }
    .danger { margin-top: 1.4rem; padding: 18px 20px 14px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--paper-amber); }
    .danger > h3 { margin: 0 0 .4rem; font-size: 1rem; }
    .danger .f-row { margin: .4rem 0 .8rem; }
    .danger .f-row > div { flex: 1 1 220px; }
    .danger .f-row .btn { width: 100%; }
    .deps { margin: .4rem 0 .8rem; padding: 0 0 0 1.1rem; font-size: .92rem; }
    .deps li { margin: 2px 0; }
    .v-table { width: 100%; border-collapse: collapse; font-size: .9rem; line-height: 1.4; margin: .4rem 0 .6rem; }
    .v-table td { padding: 8px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    .v-table td:last-child { text-align: right; white-space: nowrap; }
    .v-table form { margin: 0; }
    .v-cur td { background: rgba(255, 191, 53, .16); }
    .page { max-width: 640px; margin: 0 auto; padding: 34px 30px 40px; }
    .page h1 { max-width: none; font-size: 1.9rem; margin-bottom: .4rem; line-height: 1.1; overflow-wrap: anywhere; }
    .page .back { font-size: .88rem; margin-bottom: 1.2rem; display: block; }
    .page .lede { font-size: 1rem; }
    .breaks { margin: 1rem 0; padding: 14px 16px; border: 1.5px solid var(--line-strong); border-radius: var(--radius); background: var(--white); }
    .breaks h3 { margin: 0 0 .4rem; font-size: 1rem; }
    .members { list-style: none; margin: .6rem 0 1rem; padding: 0; }
    .members li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .members li form { margin-left: auto; }
    .members .who { color: var(--muted); font-size: .88rem; }
    .stale { margin: 0 0 1rem; }
    @media (max-width: 860px) {
      .c-body { grid-template-columns: 1fr; }
      .c-index { border-right: 0; border-bottom: 2px solid var(--ink); }
      .c-facts { grid-template-columns: 1fr; gap: 2px 0; }
      .c-facts dd { margin-bottom: 8px; }
    }
`;

// --- small formatters -------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Sep 2026", from a decoded row date; no locale, no `Date` construction. */
export const dateLabel = (date: Date): string =>
  `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

/** "just now", "2 minutes ago", "3 days ago". */
export const ago = (then: Date, nowMs: number): string => {
  const seconds = Math.max(0, Math.round((nowMs - then.getTime()) / 1000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return unit(Math.max(1, Math.round(seconds / 60)), "minute");
  if (seconds < 86_400) return unit(Math.round(seconds / 3600), "hour");
  return unit(Math.round(seconds / 86_400), "day");
};

export const daysLeft = (deletedAt: Date, nowMs: number): number =>
  Math.max(0, DELETE_WINDOW_DAYS - Math.floor((nowMs - deletedAt.getTime()) / 86_400_000));

/** The index line: up to the first `.`, `;` or ` – `, at most ~80 characters. */
export const firstClause = (description: string): string => {
  const text = description.trim();
  const cut = [text.indexOf(". "), text.indexOf(";"), text.indexOf(" – "), text.indexOf(" - ")]
    .filter((index) => index > 0)
    .reduce(
      (min, index) => Math.min(min, index),
      text.endsWith(".") ? text.length - 1 : text.length
    );
  const clause = text.slice(0, cut).trim();
  return clause.length > 80 ? `${clause.slice(0, 79).trimEnd()}…` : clause;
};

const cardPath = (row: PatchRow) => `/patches/${encodeURIComponent(row.name)}`;
const withAll = (path: string, all: boolean) => (all ? `${path}?all=1` : path);
const address = (publicBaseUrl: string, row: PatchRow) =>
  `${publicBaseUrl.replace(/\/+$/, "")}/${row.companyHandle}/${row.name}`;

const ownerLabel = (row: PatchRow, viewer: PortalViewer) =>
  row.ownerId === viewer.user.id
    ? "you"
    : `${escapeHtml(row.ownerName)}${row.ownerDeactivatedAt === null ? "" : " · deactivated"}`;

const revisionField = (row: PatchRow) =>
  `<input type="hidden" name="revision" value="${escapeAttribute(String(row.revision))}">`;

export const canManage = (row: PatchRow, viewer: PortalViewer) =>
  viewer.role === "admin" || row.ownerId === viewer.user.id;

// --- chrome ------------------------------------------------------------------

/** The shared header: brand, the four links, the viewer, sign-out, and the prototype role switch. */
export const header = (viewer: PortalViewer, current: "patches" | null): string => {
  const link = (href: string, label: string, key: "patches" | null) =>
    `<a href="${href}"${key !== null && key === current ? ' aria-current="page"' : ""}>${label}</a>`;
  const roleButton = (role: "admin" | "member") =>
    `<button type="submit" name="role" value="${role}"${viewer.role === role ? ' aria-current="true"' : ""}>${role}</button>`;
  const protoSwitch =
    viewer.realRole === "admin"
      ? `<form class="proto-role" method="post" action="/proto/role"><span>prototype only · Viewing as:</span>${roleButton("admin")}<span>|</span>${roleButton("member")}</form>`
      : `<span class="proto-role">prototype only · Viewing as: member</span>`;
  return `<header class="app-bar"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div><nav class="app-nav" aria-label="Primary">${link("/", "Patches", "patches")}${link("/company", "Company", null)}${link("/company/connections", "Connections", null)}${link("/machines", "Your machines", null)}</nav><div class="app-who"><span>${escapeHtml(viewer.user.name)} · ${escapeHtml(viewer.company.name)}</span><form class="auth-signout" method="post" action="/logout"><button type="submit">Sign out</button></form>${protoSwitch}</div></header>`;
};

/** The 409 line for a stale action, or a 422 refusal, at the top of the re-rendered page. */
export const notice = (message: string, kind: "stale" | "refused" | "plain" = "plain") =>
  `<div class="note${kind === "plain" ? "" : " note-warn"} stale" role="alert">${escapeHtml(message)}</div>`;

// --- the index ---------------------------------------------------------------

const indexLine = (row: PatchRow, nowMs: number): string => {
  const state = stateOf(row);
  if (state === "retired")
    return `<span class="c-l">Retired by ${escapeHtml(row.retiredByName ?? "someone")}, ${dateLabel(row.retiredAt!)}</span>`;
  if (state === "deleted")
    return `<span class="c-l">Deleted by ${escapeHtml(row.deletedByName ?? "someone")}, ${daysLeft(row.deletedAt!, nowMs)} days left</span>`;
  const clause = firstClause(row.description);
  const tag =
    row.ownerDeactivatedAt === null ? "" : ` <span class="c-tag">owner deactivated</span>`;
  return clause === ""
    ? `<span class="c-l muted">No description${tag}</span>`
    : `<span class="c-l">${escapeHtml(clause)}${tag}</span>`;
};

const indexGroup = (
  title: string,
  rows: ReadonlyArray<PatchRow>,
  selected: PatchRow | null,
  all: boolean,
  nowMs: number
): string => {
  if (rows.length === 0) return "";
  const items = rows
    .map((row) => {
      const classes = [
        ...(selected?.id === row.id ? ["c-current"] : []),
        ...(stateOf(row) === "live" ? [] : ["c-off"])
      ];
      return `<li${classes.length ? ` class="${classes.join(" ")}"` : ""}><a href="${escapeAttribute(withAll(cardPath(row), all))}"><span class="c-n">${escapeHtml(row.name)}</span>${indexLine(row, nowMs)}</a></li>`;
    })
    .join("");
  return `<h2 class="c-group">${escapeHtml(title)}</h2><ul class="c-list">${items}</ul>`;
};

export const index = (
  rows: ReadonlyArray<PatchRow>,
  viewer: PortalViewer,
  selected: PatchRow | null,
  all: boolean,
  currentPath: string,
  nowMs: number
): string => {
  const live = rows.filter((row) => stateOf(row) === "live");
  const yours = live.filter((row) => row.ownerId === viewer.user.id);
  const company = live.filter((row) => row.ownerId !== viewer.user.id);
  const off = rows.filter((row) => stateOf(row) !== "live");
  const toggle =
    off.length === 0
      ? ""
      : all
        ? ` · <a href="${escapeAttribute(currentPath)}">Hide retired and deleted</a>`
        : ` · <a href="${escapeAttribute(withAll(currentPath, true))}">Show retired and deleted</a>`;
  const count = all ? rows.length : live.length;
  return `<aside class="c-index"><p class="c-count">${count} ${count === 1 ? "patch" : "patches"}${toggle}</p>${
    count === 0 ? '<p class="c-emptyidx">Nothing to list yet.</p>' : ""
  }${indexGroup("Yours", yours, selected, all, nowMs)}${indexGroup("Company", company, selected, all, nowMs)}${
    all ? indexGroup("Retired and deleted", off, selected, all, nowMs) : ""
  }</aside>`;
};

export const emptyState = (viewer: PortalViewer): string =>
  `<article class="c-detail"><h1 class="c-h1">No patches yet</h1><p class="c-desc">The first one published lists on the left for everyone at ${escapeHtml(viewer.company.name)}.</p><div class="note"><span class="note-title">Publish the first one</span>Ask your agent to publish a page with Patchy, or run <code>patchy publish page.html</code> from a terminal that has done <code>patchy login</code>.</div></article>`;

// --- the card ----------------------------------------------------------------

export interface CardData {
  readonly row: PatchRow;
  readonly dependants: ReadonlyArray<Dependant>;
  readonly brokenSources: ReadonlyArray<BrokenSource>;
  readonly versions: ReadonlyArray<VersionRow>;
}

const dependantsFact = (dependants: ReadonlyArray<Dependant>): string => {
  if (dependants.length === 0) return "Nothing else reads this patch.";
  const shown = dependants
    .slice(0, 3)
    .map(
      (dependant) =>
        `<code>${escapeHtml(dependant.table)}</code> read by <code>${escapeHtml(dependant.name)}</code> (${escapeHtml(dependant.ownerName)})`
    )
    .join(", ");
  const more = dependants.length > 3 ? `, and ${dependants.length - 3} more` : "";
  return `${dependants.length} ${dependants.length === 1 ? "patch" : "patches"}: ${shown}${more}`;
};

const statePill = (state: State) =>
  state === "retired"
    ? '<span class="pill pill-off">retired</span>'
    : '<span class="pill pill-warn">deleted</span>';

const versionsTable = (
  row: PatchRow,
  versions: ReadonlyArray<VersionRow>,
  manage: boolean
): string => {
  const rows = versions
    .map((version) => {
      const action = version.current
        ? '<span class="pill pill-live">current</span>'
        : manage
          ? `<form method="post" action="${escapeAttribute(`${cardPath(row)}/rollback`)}">${revisionField(row)}<input type="hidden" name="versionId" value="${escapeAttribute(version.id)}"><button class="btn btn-sm" type="submit">Show this version at the address</button></form>`
          : "";
      return `<tr${version.current ? ' class="v-cur"' : ""}><td>v${version.versionNumber}</td><td>${dateLabel(version.createdAt)}</td><td>${escapeHtml(version.publisherName)}</td><td>${action}</td></tr>`;
    })
    .join("");
  return `<table class="v-table"><tbody>${rows}</tbody></table>`;
};

const manageBlock = (data: CardData, viewer: PortalViewer): string => {
  const { row, dependants, versions } = data;
  const path = cardPath(row);
  const isOwner = row.ownerId === viewer.user.id;
  const adminLine =
    viewer.role === "admin" && !isOwner
      ? '<p class="c-adminline">You can do everything an owner can from here, except publish.</p>'
      : "";
  const ownerSection =
    viewer.role === "admin"
      ? `<div class="sect"><h3>Owner</h3><p>${escapeHtml(row.ownerName)}${row.ownerDeactivatedAt === null ? "" : " (deactivated)"} · <a href="${escapeAttribute(`${path}/reassign`)}">Reassign…</a></p></div>`
      : "";
  const description = `<div class="sect"><h3>Description</h3><form method="post" action="${escapeAttribute(`${path}/description`)}">${revisionField(row)}<textarea class="f-in" name="description" maxlength="500" rows="4" aria-label="Description">${escapeHtml(row.description)}</textarea><div class="f-row"><button class="btn btn-sm" type="submit">Save</button></div><p class="f-hint">The repo pulls this change in the next time it runs <code>patchy dev</code> or publishes.</p></form></div>`;
  const radio = (scope: "company" | "public", label: string, hint: string) =>
    `<label class="radio"><input type="radio" name="scope" value="${scope}"${row.scope === scope ? " checked" : ""}><span><strong>${label}</strong><span>${hint}</span></span></label>`;
  const scope = `<div class="sect"><h3>Who can open it</h3><form method="post" action="${escapeAttribute(`${path}/scope`)}">${revisionField(row)}${radio("company", `People at ${escapeHtml(viewer.company.name)}`, "Anyone who signs in to the company.")}${radio("public", "Anyone on the internet", "No sign-in needed.")}<div class="f-row"><button class="btn btn-sm" type="submit">Save</button></div><p class="f-hint">This governs opening the page only. Which tables other patches may read is declared in code and changes at publish.</p></form></div>`;
  const shownVersions = versions.slice(0, 4);
  const versionsSection = `<div class="sect"><h3>Versions</h3>${versionsTable(row, shownVersions, true)}<p class="f-hint">The address changes for everyone now. Tables and the description do not move.</p>${versions.length > shownVersions.length ? `<p><a href="${escapeAttribute(`${path}/versions`)}">All ${versions.length} versions</a></p>` : ""}</div>`;
  const dependantLine =
    dependants.length === 0
      ? "Nothing else reads this patch."
      : `${dependants.length} ${dependants.length === 1 ? "patch reads" : "patches read"} this patch's tables and will break until it is restored. You will be asked to confirm.`;
  const danger = `<div class="danger"><h3>Stop serving</h3><p class="c-managenote">${dependantLine}</p><div class="f-row"><div><a class="btn btn-danger" href="${escapeAttribute(`${path}/retire`)}">Retire…</a><p class="f-hint">Keeps everything indefinitely. Nobody can open it until it is restored.</p></div><div><a class="btn btn-danger" href="${escapeAttribute(`${path}/delete`)}">Delete…</a><p class="f-hint">Keeps it 30 days, then it is gone for good.</p></div></div></div>`;
  return `<div class="c-manage"><h2>Manage</h2>${adminLine}${ownerSection}${description}${scope}${versionsSection}${danger}</div>`;
};

const offCard = (data: CardData, viewer: PortalViewer, nowMs: number): string => {
  const { row, brokenSources, dependants } = data;
  const state = stateOf(row);
  const path = cardPath(row);
  const manage = canManage(row, viewer);
  const stateFact =
    state === "retired"
      ? `${statePill(state)} by ${escapeHtml(row.retiredByName ?? "someone")} on ${dateLabel(row.retiredAt!)}`
      : `${statePill(state)} by ${escapeHtml(row.deletedByName ?? "someone")} on ${dateLabel(row.deletedAt!)} · <strong>${daysLeft(row.deletedAt!, nowMs)} days left</strong>`;
  const versionFact =
    row.currentVersionNumber === null
      ? "none"
      : `v${row.currentVersionNumber}, published ${dateLabel(row.publishedAt!)} by ${escapeHtml(row.publisherName ?? "")}`;
  const note =
    state === "retired"
      ? `<div class="note"><span class="note-title">Off the shelf, kept as it was</span>Its tables, files and all its versions are kept, for as long as you like. Nobody can open <code>${escapeHtml(row.name)}</code> until it is restored.</div>`
      : `<div class="note note-warn"><span class="note-title">Gone for good in ${daysLeft(row.deletedAt!, nowMs)} days</span>Until then the owner or an admin can restore it. After that the page, its versions, tables, files and the name <code>${escapeHtml(row.name)}</code> are all reclaimed.</div>`;
  const restore = !manage
    ? ""
    : brokenSources.length === 0
      ? `<form method="post" action="${escapeAttribute(`${path}/restore`)}">${revisionField(row)}<div class="f-row"><button class="btn btn-primary" type="submit">Restore ${escapeHtml(row.name)}</button>${state === "retired" ? `<a class="btn btn-quiet" href="${escapeAttribute(`${path}/delete`)}">Delete…</a>` : ""}</div></form><p class="f-hint">Restore brings it back live${row.currentVersionNumber === null ? "" : ` at v${row.currentVersionNumber}`} with the same address.${state === "retired" ? " Delete starts the 30-day clock." : ""}</p>`
      : `<div class="f-row"><a class="btn btn-primary" href="${escapeAttribute(`${path}/restore`)}">Restore ${escapeHtml(row.name)}…</a>${state === "retired" ? `<a class="btn btn-quiet" href="${escapeAttribute(`${path}/delete`)}">Delete…</a>` : ""}</div><p class="f-hint">It reads ${brokenSources.length === 1 ? "a table" : "tables"} from ${brokenSources.length === 1 ? "a patch that is" : "patches that are"} off; restoring asks you to acknowledge that.</p>`;
  return `<article class="c-detail c-offcard"><p class="c-addr">${escapeHtml(row.companyHandle)} / ${escapeHtml(row.name)}</p><h1 class="c-h1">${escapeHtml(row.name)}</h1>${titleLine(row)}${descriptionBlock(row)}<dl class="c-facts"><dt>State</dt><dd>${stateFact}</dd><dt>Owner</dt><dd>${ownerLabel(row, viewer)}</dd><dt>Last version</dt><dd>${versionFact}</dd><dt>Used by other patches</dt><dd>${dependantsFact(dependants)}</dd></dl>${note}${restore}</article>`;
};

const titleLine = (row: PatchRow) =>
  row.title.trim() !== "" && row.title.trim().toLowerCase() !== row.name.toLowerCase()
    ? `<p class="c-title">${escapeHtml(row.title)}</p>`
    : "";

const descriptionBlock = (row: PatchRow) => {
  const text =
    row.description.trim() === ""
      ? '<p class="c-desc muted">No description</p>'
      : `<p class="c-desc">${escapeHtml(row.description)}</p>`;
  const edited =
    row.descriptionUpdatedByName === null || row.descriptionUpdatedAt === null
      ? ""
      : `<p class="c-actor">Description edited by ${escapeHtml(row.descriptionUpdatedByName)} on ${dateLabel(row.descriptionUpdatedAt)}</p>`;
  return `${text}${edited}`;
};

export const card = (
  data: CardData,
  viewer: PortalViewer,
  publicBaseUrl: string,
  nowMs: number
): string => {
  const { row, dependants } = data;
  if (stateOf(row) !== "live") return offCard(data, viewer, nowMs);
  const url = address(publicBaseUrl, row);
  const versionFact =
    row.currentVersionNumber === null
      ? "none yet"
      : `v${row.currentVersionNumber}, published ${dateLabel(row.publishedAt!)} by ${escapeHtml(row.publisherName ?? "")}`;
  const audience =
    row.scope === "company"
      ? `Anyone at ${escapeHtml(viewer.company.name)} who signs in. Not the public.`
      : "Anyone on the internet. No sign-in.";
  const deactivatedNotice =
    viewer.role === "admin" && row.ownerDeactivatedAt !== null
      ? '<div class="note note-warn"><span class="note-title">Nobody can publish to this patch</span>Its owner is deactivated. Reassign it or retire it.</div>'
      : "";
  return `<article class="c-detail"><p class="c-addr">${escapeHtml(row.companyHandle)} / ${escapeHtml(row.name)}</p><h1 class="c-h1">${escapeHtml(row.name)}</h1>${titleLine(row)}${descriptionBlock(row)}<p class="c-actline"><a class="auth-action" href="${escapeAttribute(url)}">Open</a><code>${escapeHtml(url)}</code></p><dl class="c-facts"><dt>Owner</dt><dd>${ownerLabel(row, viewer)}</dd><dt>Current version</dt><dd>${versionFact}</dd><dt>Who can open it</dt><dd>${audience}</dd><dt>Used by other patches</dt><dd>${dependantsFact(dependants)}</dd></dl>${deactivatedNotice}${
    canManage(row, viewer) ? manageBlock(data, viewer) : ""
  }</article>`;
};

// --- the two-column page -----------------------------------------------------

export const portal = (input: {
  readonly viewer: PortalViewer;
  readonly rows: ReadonlyArray<PatchRow>;
  readonly selected: CardData | null;
  readonly all: boolean;
  readonly currentPath: string;
  readonly publicBaseUrl: string;
  readonly nowMs: number;
  readonly notice?: string;
}): string =>
  `${header(input.viewer, "patches")}${input.notice ?? ""}<div class="c-body">${index(
    input.rows,
    input.viewer,
    input.selected?.row ?? null,
    input.all,
    input.currentPath,
    input.nowMs
  )}${input.selected === null ? emptyState(input.viewer) : card(input.selected, input.viewer, input.publicBaseUrl, input.nowMs)}</div>`;

// --- the pages under the card ------------------------------------------------

const back = (row: PatchRow) =>
  `<a class="back" href="${escapeAttribute(cardPath(row))}">← Back to ${escapeHtml(row.name)}</a>`;

const dependantsList = (dependants: ReadonlyArray<Dependant>) =>
  `<ul class="deps">${dependants
    .map(
      (dependant) =>
        `<li><code>${escapeHtml(dependant.table)}</code> read by <code>${escapeHtml(dependant.name)}</code>, owned by ${escapeHtml(dependant.ownerName)}</li>`
    )
    .join("")}</ul>`;

const ackBox = (label: string) =>
  `<label class="chk"><input type="checkbox" name="ack" value="1" required><span>${escapeHtml(label)}</span></label>`;

const versionsCount = (versions: ReadonlyArray<VersionRow>) =>
  `${versions.length} ${versions.length === 1 ? "version" : "versions"}`;

export const retirePage = (data: CardData, viewer: PortalViewer, noticeHtml = ""): string => {
  const { row, dependants, versions } = data;
  const breaks =
    dependants.length === 0
      ? '<div class="breaks"><h3>Nothing else reads this patch.</h3></div>'
      : `<div class="breaks"><h3>${dependants.length} ${dependants.length === 1 ? "patch" : "patches"} will break</h3><p>They read this patch's shared tables and will get an error the next time they do, until this one is restored.</p>${dependantsList(dependants)}</div>${ackBox(`I understand ${dependants.length === 1 ? "that patch" : `those ${dependants.length} patches`} will break until ${row.name} is restored.`)}`;
  return `${header(viewer, "patches")}<div class="page">${back(row)}${noticeHtml}<h1>Retire ${escapeHtml(row.name)}?</h1><p class="lede">It goes off the shelf and stops serving now. Its tables, files and all ${versionsCount(versions)} are kept. You or an admin can restore it any time, and it comes back${row.currentVersionNumber === null ? "" : ` at v${row.currentVersionNumber}`} with the same address.</p><form method="post" action="${escapeAttribute(`${cardPath(row)}/retire`)}">${revisionField(row)}${breaks}<div class="f-row"><button class="btn btn-danger" type="submit">Retire ${escapeHtml(row.name)}</button><a class="btn btn-quiet" href="${escapeAttribute(cardPath(row))}">Cancel</a></div></form></div>`;
};

export const deletePage = (data: CardData, viewer: PortalViewer, noticeHtml = ""): string => {
  const { row, dependants, versions } = data;
  const fromRetired = stateOf(row) === "retired";
  const lede = fromRetired
    ? `It is already off the shelf: anything that read its tables stopped working when it was retired. This starts the 30-day clock. After that the page, all ${versionsCount(versions)}, its tables and files, and the name <code>${escapeHtml(row.name)}</code> are gone for good. Until then it can still be restored.`
    : `It stops serving now. In 30 days everything is gone for good: the page, all ${versionsCount(versions)}, its tables and files, and the name <code>${escapeHtml(row.name)}</code>. Until then it shows under Retired and deleted and can be restored.`;
  const breaks = fromRetired
    ? dependants.length === 0
      ? ""
      : `<div class="breaks"><h3>${dependants.length} ${dependants.length === 1 ? "patch" : "patches"} already stopped working at retire</h3>${dependantsList(dependants)}</div>`
    : dependants.length === 0
      ? '<div class="breaks"><h3>Nothing else reads this patch.</h3></div>'
      : `<div class="breaks"><h3>${dependants.length} ${dependants.length === 1 ? "patch" : "patches"} will break</h3>${dependantsList(dependants)}</div>${ackBox(`I understand ${dependants.length === 1 ? "that patch" : `those ${dependants.length} patches`} will break.`)}`;
  return `${header(viewer, "patches")}<div class="page">${back(row)}${noticeHtml}<h1>Delete ${escapeHtml(row.name)}?</h1><p class="lede">${lede}</p><form method="post" action="${escapeAttribute(`${cardPath(row)}/delete`)}">${revisionField(row)}${breaks}<label class="f-label" for="confirm-name">Type <code>${escapeHtml(row.name)}</code> to confirm</label><input class="f-in short" id="confirm-name" name="confirm" autocomplete="off" required placeholder="${escapeAttribute(row.name)}"><div class="f-row"><button class="btn btn-danger" type="submit">Delete ${escapeHtml(row.name)}</button><a class="btn btn-quiet" href="${escapeAttribute(cardPath(row))}">Cancel</a></div></form></div>`;
};

export const restorePage = (data: CardData, viewer: PortalViewer, noticeHtml = ""): string => {
  const { row, brokenSources } = data;
  const sources = brokenSources
    .map((source) => {
      const name =
        source.sourceName === null
          ? `<code>${escapeHtml(source.sourceId)}</code> (no longer exists)`
          : `<code>${escapeHtml(source.sourceName)}</code>`;
      return `<li>${name} as <code>${escapeHtml(source.alias)}</code>, which is <strong>${source.state}</strong></li>`;
    })
    .join("");
  return `${header(viewer, "patches")}<div class="page">${back(row)}${noticeHtml}<h1>Restore ${escapeHtml(row.name)}?</h1><p class="lede">It comes back live${row.currentVersionNumber === null ? "" : ` at v${row.currentVersionNumber}`} with the same address. It reads tables from ${brokenSources.length === 1 ? "a patch that is" : "patches that are"} off:</p><form method="post" action="${escapeAttribute(`${cardPath(row)}/restore`)}">${revisionField(row)}<div class="breaks"><h3>It will come back broken</h3><ul class="deps">${sources}</ul><p>Restored, it serves again but gets an error whenever it reads ${brokenSources.length === 1 ? "that table" : "those tables"}, until ${brokenSources.length === 1 ? "that patch is" : "those patches are"} restored too.</p></div>${ackBox("I understand it comes back broken.")}<div class="f-row"><button class="btn btn-primary" type="submit">Restore ${escapeHtml(row.name)}</button><a class="btn btn-quiet" href="${escapeAttribute(cardPath(row))}">Cancel</a></div></form></div>`;
};

export const reassignPage = (
  row: PatchRow,
  members: ReadonlyArray<Member>,
  q: string,
  viewer: PortalViewer,
  noticeHtml = ""
): string => {
  const path = `${cardPath(row)}/reassign`;
  const items = members
    .map((member) => {
      const you = member.id === viewer.user.id ? " · you" : "";
      const action =
        member.id === row.ownerId
          ? '<span class="who">current owner</span>'
          : `<form method="post" action="${escapeAttribute(path)}">${revisionField(row)}<input type="hidden" name="user" value="${escapeAttribute(member.id)}"><button class="btn btn-sm" type="submit">Reassign to ${escapeHtml(member.name)}</button></form>`;
      return `<li><strong>${escapeHtml(member.name)}</strong><span class="who">${escapeHtml(member.email)} · ${member.role}${you}</span>${action}</li>`;
    })
    .join("");
  return `${header(viewer, "patches")}<div class="page">${back(row)}${noticeHtml}<h1>Reassign ${escapeHtml(row.name)}</h1><p class="lede">Owned by ${escapeHtml(row.ownerName)}${row.ownerDeactivatedAt === null ? "" : " (deactivated)"}. Any active member can take it, yourself included; deactivated members are not offered. The new owner publishes from their own copy of the repo.</p><form method="get" action="${escapeAttribute(path)}" class="f-row"><input class="f-in short" type="search" name="q" value="${escapeAttribute(q)}" placeholder="Filter by name or email" aria-label="Filter by name or email"><button class="btn btn-sm" type="submit">Filter</button></form>${
    members.length === 0
      ? '<p class="c-managenote">No active members match.</p>'
      : `<ul class="members">${items}</ul>`
  }<p><a class="btn btn-quiet" href="${escapeAttribute(cardPath(row))}">Cancel</a></p></div>`;
};

export const versionsPage = (data: CardData, viewer: PortalViewer, noticeHtml = ""): string => {
  const { row, versions } = data;
  const manage = canManage(row, viewer) && stateOf(row) === "live";
  return `${header(viewer, "patches")}<div class="page">${back(row)}${noticeHtml}<h1>All ${versions.length} versions of ${escapeHtml(row.name)}</h1>${versionsTable(row, versions, manage)}${manage ? '<p class="f-hint">The address changes for everyone now. Tables and the description do not move.</p>' : ""}</div>`;
};
