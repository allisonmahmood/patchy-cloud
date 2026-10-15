import type { RequireSession } from "@patchy/auth";
import {
  ago,
  avatar,
  copyScriptPath,
  dateLabel,
  daysLeft,
  escapeAttribute,
  escapeHtml,
  menuCopy,
  menuLink,
  menuPost,
  patchMark,
  rowMenu,
  searchField
} from "@patchy/core";
import type { Patches } from "@patchy/patches";
import { firstClause, hidden } from "./render.js";

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
/** How long a patch counts as new to someone who hasn't opened it, and how near reclamation needs attention. */
const RECENT = 7 * DAY;

type Viewer = RequireSession.Viewer["Service"];
const epoch = (iso: string) => Date.parse(iso);

/** A `?q=` as searched: trimmed and cut to 200 code points, never mid-character. */
export const searchQuery = (raw: string | null) =>
  Array.from((raw ?? "").trim())
    .slice(0, 200)
    .join("");

/** A search over live or off patches: case-insensitive, across name, title, description and owner name. */
export const matches = (row: Patches.ReadPatch, query: string): boolean => {
  const needle = query.toLowerCase();
  return [row.patch.name, row.patch.title, row.patch.description, row.owner.name].some((field) =>
    field.toLowerCase().includes(needle)
  );
};

/** Whether the viewer may manage this patch: its owner, or any admin. */
export const manages = (row: Patches.ReadPatch, viewer: Viewer) =>
  viewer.role === "admin" || row.owner.id === viewer.user.id;

/** A deletion the owner or an admin can still undo: before its reclamation deadline. */
export const recoverable = (patch: Patches.Patch, now: number) =>
  patch.state !== "deleted" || (patch.purgeAt !== null && now < epoch(patch.purgeAt));

/** Created in the last week by someone else, and not yet opened by the viewer. */
export const isNew = (
  row: Patches.ReadPatch,
  viewer: Viewer,
  opens: ReadonlyMap<string, Patches.Open>,
  now: number
) =>
  row.owner.id !== viewer.user.id &&
  now - epoch(row.patch.createdAt) < RECENT &&
  !opens.has(row.patch.id);

interface Attention {
  readonly title: string;
  readonly detail: string;
  /** The act that resolves it, as HTML. */
  readonly act: string;
}

const cardPath = (patch: Patches.Patch, action = "") =>
  `/patches/${encodeURIComponent(patch.name)}${action ? `/${action}` : ""}`;
const restoreForm = (patch: Patches.Patch) =>
  `${hidden("expectedPatchId", patch.id)}${hidden("expectedState", patch.state)}`;

/** Why a patch needs its owner's or an admin's attention, if it does and the viewer may act. */
const attentionOf = (
  row: Patches.ReadPatch,
  viewer: Viewer,
  names: ReadonlyMap<string, string>,
  now: number
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
  return undefined;
};

const actor = (id: string | null, names: ReadonlyMap<string, string>) => {
  const name = id === null ? undefined : names.get(id);
  return name === undefined ? "" : ` by ${name}`;
};

/** Every act on a patch the viewer may perform, each going to the route that already does it. */
const actions = (row: Patches.ReadPatch, viewer: Viewer, url: string, now: number) => {
  const { patch } = row;
  const items = [
    ...(patch.state === "live" ? [menuLink(url, "Open"), menuCopy(url, "Copy link")] : []),
    menuLink(cardPath(patch), "About this patch")
  ];
  if (!manages(row, viewer)) return rowMenu(patch.id, patch.name, items);
  const manage = [
    menuLink(cardPath(patch, "settings"), "Settings"),
    ...(viewer.role === "admin" ? [menuLink(cardPath(patch, "reassign"), "Reassign…")] : []),
    ...(patch.state === "live" ? [menuLink(cardPath(patch, "retire"), "Retire…", true)] : []),
    ...(patch.state !== "live" && recoverable(patch, now)
      ? [menuPost(cardPath(patch, "restore"), "Restore", restoreForm(patch))]
      : []),
    ...(patch.state !== "deleted" ? [menuLink(cardPath(patch, "delete"), "Delete…", true)] : [])
  ];
  return rowMenu(patch.id, patch.name, [...items, '<hr class="menu-rule">', ...manage]);
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
}): string => {
  const { viewer, now, show, query, names } = input;
  const base = input.publicBaseUrl.replace(/\/+$/u, "");
  const byVisits = (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
    b.visits - a.visits || a.patch.name.localeCompare(b.patch.name);
  const newest =
    (at: (row: Patches.ReadPatch) => string | null) =>
    (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
      epoch(at(b) ?? "") - epoch(at(a) ?? "") || a.patch.name.localeCompare(b.patch.name);
  const live = input.rows.filter((row) => row.patch.state === "live");
  const attention = new Map(
    input.rows.flatMap((row) => {
      const found = attentionOf(row, viewer, names, now);
      return found === undefined ? [] : [[row.patch.id, found] as const];
    })
  );
  const lists: Record<Show, readonly Patches.ReadPatch[]> = {
    all: [...live].sort(byVisits),
    tools: live.filter((row) => row.tier >= 1).sort(byVisits),
    pages: live.filter((row) => row.tier === 0).sort(newest((row) => row.publishedAt)),
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

  const patchCell = (row: Patches.ReadPatch) => {
    const { patch } = row;
    const tags = `${row.owner.id === viewer.user.id ? '<span class="tag">You</span>' : ""}${isNew(row, viewer, input.opens, now) ? '<span class="tag">New</span>' : ""}`;
    return `<td><div class="portal-list-patch">${patchMark(patch.name, row.tier)}<div><a href="${escapeAttribute(cardPath(patch))}"><strong>${escapeHtml(patch.name)}</strong></a>${tags}<br><span class="supporting-text">${escapeHtml(firstClause(patch.description) || "No description")}</span></div></div></td>`;
  };
  const ownerCell = (row: Patches.ReadPatch) =>
    `<td><div class="portal-list-person">${avatar(row.owner.id, row.owner.name, row.owner.deactivated ? "off" : undefined)}<span>${escapeHtml(row.owner.name)}${row.owner.deactivated ? '<span class="tag">Deactivated</span>' : ""}</span></div></td>`;
  const menuCell = (row: Patches.ReadPatch, extra = "") =>
    `<td class="portal-list-actions">${extra}${actions(row, viewer, `${base}/${encodeURIComponent(row.patch.companyHandle)}/${encodeURIComponent(row.patch.name)}`, now)}</td>`;
  const time = (iso: string) =>
    `<time datetime="${escapeAttribute(iso)}">${escapeHtml(ago(iso, now))}</time>`;

  const columns =
    show === "attention"
      ? ["Patch", "Owner", "Why it’s here"]
      : show === "off"
        ? ["Patch", "Owner", "State"]
        : ["Patch", "Owner", "Updated", "Visits", "Who can open"];
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
    return `<tr>${patchCell(entry)}${ownerCell(entry)}<td>v${escapeHtml(entry.currentVersion)} · ${time(entry.publishedAt)}</td><td>${escapeHtml(entry.visits)}</td><td>${patch.scope === "public" ? "<strong>Public</strong>" : "Company"}</td>${menuCell(entry)}</tr>`;
  };
  const empty: Record<Show, string> = {
    all: "No live patches.",
    tools: "No tools yet. A tool is a patch with code: tier 1 or 2.",
    pages: "No pages yet. A page is a static patch: tier 0.",
    yours: "You own no live patches.",
    attention: "Nothing needs your attention.",
    off: "Nothing is retired or deleted."
  };
  const table = entries.length
    ? `<div class="portal-table portal-list"><table class="table"><thead><tr>${columns.map((column) => `<th scope="col">${column}</th>`).join("")}<th scope="col" class="portal-list-actions"><span class="supporting-text">Actions</span></th></tr></thead><tbody>${entries.map(row).join("")}</tbody></table></div>`
    : `<p>${query ? `No patches match “${escapeHtml(query)}”.` : empty[show]}</p>`;
  return `<h1 class="page-heading">All patches</h1><div class="portal-list-tools"><nav class="tabs" aria-label="Show">${tabs}</nav>${search}</div>${found}${table}<script defer src="${copyScriptPath}"></script>`;
};
