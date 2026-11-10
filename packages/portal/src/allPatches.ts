import { type GuestReason, guestReasonText } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import {
  ago,
  avatar,
  copyScriptPath,
  dateLabel,
  daysLeft,
  escapeAttribute,
  escapeHtml,
  isPage,
  menuLink,
  menuPost,
  patchMark,
  patchTitle,
  rowMenu,
  searchField
} from "@patchy/core";
import type { Patches } from "@patchy/patches";
import type { InvocationLog } from "@patchy/runtime";
import {
  cardPath,
  failedLog,
  firstClause,
  hidden,
  isNew,
  manages,
  matches,
  openItems,
  patchAddress,
  turnedAwayTitle
} from "./shared/presentation.js";

/** All patches' layout; components come from the shell. */
export const listStyles = `
  .portal-list-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 20px; }
  .portal-list-search { width: min(100%, 320px); }
  .portal-list-matches { margin-top: 12px; }
  /* Cells keep words whole, so on a phone the table scrolls in portal-table rather than splitting names. */
  .portal-list .table { min-width: 860px; overflow-wrap: break-word; }
  .portal-list :is(th, td) { vertical-align: middle; }
  .portal-list-patch { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 0 12px; align-items: center; }
  .portal-list-person { display: flex; align-items: center; gap: 10px; }
  .portal-list-actions { text-align: right; white-space: nowrap; }
  .portal-list-actions form { display: inline; }
`;

export const shows = ["all", "tools", "pages", "yours", "attention", "off"] as const;
export type Show = (typeof shows)[number];
const showLabels: Record<Show, string> = {
  all: "All",
  tools: "Tools",
  pages: "Pages",
  yours: "Yours",
  attention: "Needs attention",
  off: "Retired and deleted"
};

const DAY = 86_400_000;
/** How near its reclamation a deletion needs attention. */
const RECENT = 7 * DAY;

type Viewer = RequireSession.Viewer["Service"];
const epoch = (iso: string) => Date.parse(iso);

/** A deletion the owner or an admin can still undo: before its reclamation deadline. */
export const recoverable = (patch: Patches.Patch, now: number) =>
  patch.state !== "deleted" || (patch.purgeAt !== null && now < epoch(patch.purgeAt));

interface Attention {
  readonly title: string;
  readonly detail: string;
  /** The act that resolves it, as HTML. */
  readonly act: string;
}

const restoreForm = (patch: Patches.Patch) =>
  `${hidden("expectedPatchId", patch.id)}${hidden("expectedState", patch.state)}`;

/** Why a patch needs its owner's or an admin's attention, if it does and the viewer may act. */
const attentionOf = (
  row: Patches.ReadPatch,
  viewer: Viewer,
  names: ReadonlyMap<string, string>,
  now: number,
  calls: ReadonlyMap<string, InvocationLog.CallSummary> | undefined,
  turnedAway: ReadonlyMap<string, GuestReason> | undefined
): Attention | undefined => {
  const { patch } = row;
  if (!manages(row, viewer)) return undefined;
  // A deletion about to be reclaimed is the more urgent of the two.
  if (patch.state === "deleted" && patch.purgeAt !== null) {
    const deadline = epoch(patch.purgeAt);
    if (now < deadline && deadline <= now + RECENT)
      return {
        title: `Gone for good in ${daysLeft(deadline, now)} days`,
        detail: `Deleted${actor(patch.deletedBy, names)}${patch.deletedAt === null ? "" : ` on ${dateLabel(patch.deletedAt)}`}`,
        act: `<form method="post" action="${escapeAttribute(cardPath(patch, "restore"))}">${restoreForm(patch)}<button class="btn" type="submit">Restore</button></form>`
      };
  }
  if (row.owner.deactivated && viewer.role === "admin")
    return {
      title: "Its owner is deactivated",
      detail: "Nobody can publish to it until someone else owns it.",
      act: `<a class="btn" href="${escapeAttribute(cardPath(patch, "reassign"))}">Reassign…</a>`
    };
  const failed = calls?.get(patch.id)?.failures ?? 0;
  if (patch.state === "live" && failed > 0)
    return {
      title: `${plural(failed, "call", "calls")} failed in the last day`,
      detail: "Its log says which, and why.",
      act: `<a class="btn" href="${escapeAttribute(failedLog(patch))}">See the log</a>`
    };
  const reason = turnedAway?.get(patch.id);
  if (patch.state === "live" && reason !== undefined)
    return {
      title: turnedAwayTitle,
      detail: guestReasonText(reason),
      act: `<a class="btn" href="${escapeAttribute(cardPath(patch))}">View patch</a>`
    };
  return undefined;
};

const actor = (id: string | null, names: ReadonlyMap<string, string>) => {
  const name = id === null ? undefined : names.get(id);
  return name === undefined ? "" : ` by ${name}`;
};

/** Every act on a patch the viewer may perform, each going to the route that already does it. */
const actions = (
  row: Patches.ReadPatch,
  viewer: Viewer,
  input: { readonly publicBaseUrl: string; readonly now: number; readonly here: string }
) => {
  const { patch } = row;
  const { now } = input;
  const items = openItems(row, viewer, input.publicBaseUrl, input.here);
  if (!manages(row, viewer)) return rowMenu(patch.id, patchTitle(patch), items);
  const title = patchTitle(patch);
  const manage = [
    menuLink(cardPath(patch, "settings"), "Settings", false, title),
    ...(viewer.role === "admin"
      ? [menuLink(cardPath(patch, "reassign"), "Reassign…", false, title)]
      : []),
    ...(patch.state === "live"
      ? [menuLink(cardPath(patch, "retire"), "Retire…", true, title)]
      : []),
    ...(patch.state !== "live" && recoverable(patch, now)
      ? [menuPost(cardPath(patch, "restore"), "Restore", restoreForm(patch), false, title)]
      : []),
    ...(patch.state !== "deleted"
      ? [menuLink(cardPath(patch, "delete"), "Delete…", true, title)]
      : [])
  ];
  return rowMenu(patch.id, patchTitle(patch), [...items, '<hr class="menu-rule">', ...manage]);
};

const filterHref = (show: Show, query: string) => {
  const params = new URLSearchParams();
  if (show !== "all") params.set("show", show);
  if (query) params.set("q", query);
  const search = params.toString();
  return search ? `/patches?${search}` : "/patches";
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** All patches at `/patches`: every patch the viewer can open, in tabs, with search and each row's acts. */
export const renderAllPatches = (input: {
  readonly rows: readonly Patches.ReadPatch[];
  readonly viewer: Viewer;
  readonly show: Show;
  readonly query: string;
  readonly now: number;
  readonly publicBaseUrl: string;
  readonly opens: ReadonlyMap<string, Patches.Open>;
  /** Company members' names by id, for who retired or deleted a patch. */
  readonly names: ReadonlyMap<string, string>;
  /** The call summary of each live tier 2 patch the viewer manages; absent when they manage none. */
  readonly calls?: ReadonlyMap<string, InvocationLog.CallSummary>;
  /** Why guests can't open each patch with guests that turns them away; absent for a member. */
  readonly turnedAway?: ReadonlyMap<string, GuestReason>;
}): string => {
  const { viewer, now, show, query, names } = input;
  const byVisits = (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
    b.visits - a.visits || a.patch.name.localeCompare(b.patch.name);
  const newest =
    (at: (row: Patches.ReadPatch) => string | null) =>
    (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
      epoch(at(b) ?? "") - epoch(at(a) ?? "") || a.patch.name.localeCompare(b.patch.name);
  const live = input.rows.filter((row) => row.patch.state === "live");
  const attention = new Map(
    input.rows.flatMap((row) => {
      const found = attentionOf(row, viewer, names, now, input.calls, input.turnedAway);
      return found === undefined ? [] : [[row.patch.id, found] as const];
    })
  );
  const lists: Record<Show, readonly Patches.ReadPatch[]> = {
    all: [...live].sort(byVisits),
    tools: live.filter((row) => !isPage(row)).sort(byVisits),
    pages: live.filter(isPage).sort(newest((row) => row.publishedAt)),
    yours: live.filter((row) => row.owner.id === viewer.user.id).sort(byVisits),
    attention: input.rows.filter((row) => attention.has(row.patch.id)).sort(byVisits),
    off: input.rows
      .filter((row) => row.patch.state !== "live")
      .sort(newest((row) => row.patch.deletedAt ?? row.patch.retiredAt))
  };
  const entries = query ? lists[show].filter((row) => matches(row, query)) : lists[show];

  const tabs = shows
    .filter(
      (tab) => (tab !== "attention" && tab !== "off") || lists[tab].length > 0 || tab === show
    )
    .map(
      (tab) =>
        `<a href="${escapeAttribute(filterHref(tab, query))}"${tab === show ? ' aria-current="page"' : ""}>${showLabels[tab]} <span class="count">${lists[tab].length}</span></a>`
    )
    .join("");
  const search = searchField({
    action: "/patches",
    id: "patches-search",
    query,
    placeholder: "Search by name, purpose or owner",
    label: "Search patches",
    keep: show === "all" ? {} : { show },
    className: "portal-list-search"
  });
  const found = query
    ? `<p class="supporting-text portal-list-matches">${plural(entries.length, "match", "matches")} for “${escapeHtml(query)}” · <a href="${escapeAttribute(filterHref(show, ""))}">Clear search</a></p>`
    : "";

  // A live patch's name opens it, as on Home; an off one's goes to its card.
  const patchCell = (row: Patches.ReadPatch) => {
    const { patch } = row;
    const href = patch.state === "live" ? patchAddress(patch) : cardPath(patch);
    const fresh = isNew(row, viewer, input.opens, now)
      ? '<span class="tag tag-new">New</span>'
      : "";
    return `<td><div class="portal-list-patch">${patchMark(patch.name, row.tier)}<div><a href="${escapeAttribute(href)}"><strong>${escapeHtml(patchTitle(patch))}</strong></a>${fresh}<br><span class="supporting-text">${escapeHtml(firstClause(patch.description) || "No description")}</span></div></div></td>`;
  };
  const ownerCell = (row: Patches.ReadPatch) =>
    `<td><div class="portal-list-person">${avatar(row.owner.id, row.owner.name, row.owner.deactivated ? "off" : undefined)}<span>${row.owner.id === viewer.user.id ? "You" : escapeHtml(row.owner.name)}${row.owner.deactivated ? '<span class="tag">Deactivated</span>' : ""}</span></div></td>`;
  const here = filterHref(show, query);
  const menuCell = (row: Patches.ReadPatch, extra = "") =>
    `<td class="portal-list-actions">${extra}${actions(row, viewer, { publicBaseUrl: input.publicBaseUrl, now, here })}</td>`;
  const time = (iso: string) =>
    `<time datetime="${escapeAttribute(iso)}">${escapeHtml(ago(iso, now))}</time>`;

  // Health names failures only. A tier 2 patch with none recorded is blank; a row with no calls
  // to count (not tier 2, or not the viewer's to manage) shows a dash.
  const healthy = input.calls !== undefined && show !== "pages";
  const health = (row: Patches.ReadPatch) => {
    const failed = input.calls?.get(row.patch.id)?.failures;
    if (failed === undefined) return '<td><span class="supporting-text">—</span></td>';
    return failed === 0
      ? "<td></td>"
      : `<td><a href="${escapeAttribute(failedLog(row.patch))}">${escapeHtml(failed)} failed in the last day</a></td>`;
  };
  const columns =
    show === "attention"
      ? ["Patch", "Owner", "Why it’s here"]
      : show === "off"
        ? ["Patch", "Owner", "State"]
        : ["Patch", "Owner", "Updated", "Visits", "Who can open", ...(healthy ? ["Health"] : [])];
  const row = (entry: Patches.ReadPatch) => {
    const { patch } = entry;
    if (show === "attention") {
      const why = attention.get(patch.id)!;
      return `<tr>${patchCell(entry)}${ownerCell(entry)}<td><strong>${escapeHtml(why.title)}</strong><br><span class="supporting-text">${escapeHtml(why.detail)}</span></td>${menuCell(entry, why.act)}</tr>`;
    }
    if (show === "off") {
      const retired = patch.state === "retired";
      const at = retired ? patch.retiredAt : patch.deletedAt;
      const state = retired
        ? `Retired${actor(patch.retiredBy, names)}`
        : recoverable(patch, now)
          ? `Deleted · gone in ${daysLeft(epoch(patch.purgeAt!), now)} days`
          : "Recovery ended";
      return `<tr>${patchCell(entry)}${ownerCell(entry)}<td><span class="pill${retired ? "" : " pill-failed"}">${escapeHtml(state)}</span>${at === null ? "" : `<br><span class="supporting-text">${escapeHtml(dateLabel(at))}</span>`}</td>${menuCell(entry)}</tr>`;
    }
    return `<tr>${patchCell(entry)}${ownerCell(entry)}<td>v${escapeHtml(entry.currentVersion)} · ${time(entry.publishedAt)}</td><td>${escapeHtml(entry.visits)}</td><td>${patch.scope === "public" ? "<strong>Public</strong>" : "Company"}</td>${healthy ? health(entry) : ""}${menuCell(entry)}</tr>`;
  };
  const empty: Record<Show, string> = {
    all: "No live patches.",
    tools: "No tools yet. A tool is a patch with server code: tier 2.",
    pages: "No pages yet. A page is a patch that runs in the browser: tier 1.",
    yours: "You own no live patches.",
    attention: "Nothing needs your attention.",
    off: "Nothing is retired or deleted."
  };
  const table = entries.length
    ? `<div class="portal-table portal-list"><table class="table"><thead><tr>${columns.map((column) => `<th scope="col">${column}</th>`).join("")}<th scope="col" class="portal-list-actions"><span class="supporting-text">Actions</span></th></tr></thead><tbody>${entries.map(row).join("")}</tbody></table></div>`
    : `<p>${query ? `No patches match “${escapeHtml(query)}”.` : empty[show]}</p>`;
  return `<h1 class="page-heading">All patches</h1><div class="portal-list-tools"><nav class="tabs" aria-label="Show">${tabs}</nav>${search}</div>${found}${table}<script defer src="${copyScriptPath}"></script>`;
};
