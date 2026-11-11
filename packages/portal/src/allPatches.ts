import { type GuestReason, guestReasonText } from "@patchy/api";
import type { RequireSession } from "@patchy/auth";
import {
  ago,
  avatar,
  badge,
  button,
  chip,
  type Column,
  copyLine,
  copyScriptPath,
  dateLabel,
  daysLeft,
  emptyState,
  escapeAttribute,
  escapeHtml,
  indexPage,
  isPage,
  linkButton,
  menuLink,
  menuPost,
  menuRule,
  patchMark,
  patchTitle,
  rowMenu,
  segmented,
  row,
  rows,
  section,
  table,
  unopenedName
} from "@patchy/core";
import type { Patches } from "@patchy/patches";
import type { InvocationLog } from "@patchy/runtime";
import {
  byTitle,
  cardPath,
  failedBadge,
  failedLog,
  failuresCell,
  failuresColumn,
  firstClause,
  hidden,
  manages,
  matches,
  openItems,
  patchAddress,
  shareHref,
  turnedAwayTitle,
  unopened
} from "./shared/presentation.js";

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

/** How many patches a page of the table holds. */
export const PAGE_SIZE = 50;

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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

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
  const title = patchTitle(patch, viewer.company.name);
  // A deletion about to be reclaimed is the more urgent of the two.
  if (patch.state === "deleted" && patch.purgeAt !== null) {
    const deadline = epoch(patch.purgeAt);
    if (now < deadline && deadline <= now + RECENT)
      return {
        title: `Gone for good in ${daysLeft(deadline, now)} days`,
        detail: `Deleted${actor(patch.deletedBy, names)}${patch.deletedAt === null ? "" : ` on ${dateLabel(patch.deletedAt)}`}`,
        act: `<form method="post" action="${escapeAttribute(cardPath(patch, "restore"))}">${restoreForm(patch)}${button("Restore", { size: "sm", ariaLabel: `Restore ${title}` })}</form>`
      };
  }
  if (row.owner.deactivated && viewer.role === "admin")
    return {
      title: "Its owner is deactivated",
      detail: "Nobody can publish to it until someone else owns it.",
      act: linkButton("Reassign…", cardPath(patch, "reassign"), {
        size: "sm",
        ariaLabel: `Reassign ${title}`
      })
    };
  const failed = calls?.get(patch.id)?.failures ?? 0;
  if (patch.state === "live" && failed > 0)
    return {
      title: `${plural(failed, "call", "calls")} failed in the last day`,
      detail: "Its log says which, and why.",
      act: linkButton("View log", failedLog(patch), { size: "sm", ariaLabel: `View log, ${title}` })
    };
  const reason = turnedAway?.get(patch.id);
  if (patch.state === "live" && reason !== undefined)
    return {
      title: turnedAwayTitle,
      detail: guestReasonText(reason),
      act: linkButton("View patch", cardPath(patch), { size: "sm", ariaLabel: `View ${title}` })
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
  const title = patchTitle(patch, viewer.company.name);
  const items = openItems(row, viewer, input.publicBaseUrl, input.here);
  if (!manages(row, viewer)) return rowMenu(patch.id, title, items);
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
  return rowMenu(patch.id, title, [...items, menuRule, ...manage]);
};

/** What All patches lists: a filter, the sidebar's search, and one person's patches. */
export interface Listing {
  readonly show: Show;
  readonly query: string;
  /** Only the patches this person owns, by user id; `""` for everyone's. */
  readonly owner: string;
}

/**
 * All patches at a listing and page; All, no search, everyone's and the first page leave their
 * parameter out.
 */
export const listPath = ({ show, query, owner }: Listing, page = 1) => {
  const params = new URLSearchParams();
  if (show !== "all") params.set("show", show);
  if (owner) params.set("owner", owner);
  if (query) params.set("q", query);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return search ? `/patches?${search}` : "/patches";
};

/**
 * All patches at `/patches`: every patch the viewer can open, A–Z, filtered by `?show=`, searched
 * by the sidebar's `?q=` and narrowed to one person's by `?owner=` (People's See their patches),
 * each of those two shown as a chip that clears it, and paged by `?page=`. Its title opens a live
 * patch; Share sits on the rows the viewer owns, and each row's other acts in its menu.
 */
export const renderAllPatches = (input: {
  readonly rows: readonly Patches.ReadPatch[];
  readonly management?: readonly Patches.ManagementView[];
  readonly viewer: Viewer;
  readonly show: Show;
  readonly query: string;
  /** Only this member's patches, from `?owner=`; absent for everyone's. */
  readonly owner?: { readonly id: string; readonly name: string };
  /** The page asked for, from 1; past the last it is the last. */
  readonly page: number;
  readonly now: number;
  readonly publicBaseUrl: string;
  /** What the viewer has opened, for the dot after a colleague's patch they never have. */
  readonly opens: ReadonlyMap<string, Patches.Open>;
  /** Company members' names by id, for who retired or deleted a patch. */
  readonly names: ReadonlyMap<string, string>;
  /** How many guests each patch with any has, by name. */
  readonly guests: ReadonlyMap<string, number>;
  /** Whether the viewer has connected an agent, for what a search that finds nothing offers. */
  readonly connected: boolean;
  /** The call summary of each live tier 2 patch the viewer manages; absent when they manage none. */
  readonly calls?: ReadonlyMap<string, InvocationLog.CallSummary>;
  /** Why guests can't open each patch with guests that turns them away; absent for a member. */
  readonly turnedAway?: ReadonlyMap<string, GuestReason>;
}) => {
  const { viewer, now, show, query, names, owner } = input;
  const listing: Listing = { show, query, owner: owner?.id ?? "" };
  const live = input.rows.filter((row) => row.patch.state === "live");
  const attention = new Map(
    input.rows.flatMap((row) => {
      const found = attentionOf(row, viewer, names, now, input.calls, input.turnedAway);
      return found === undefined ? [] : [[row.patch.id, found] as const];
    })
  );
  const lists: Record<Show, readonly Patches.ReadPatch[]> = {
    all: live,
    tools: live.filter((row) => !isPage(row)),
    pages: live.filter(isPage),
    yours: live.filter((row) => row.owner.id === viewer.user.id),
    attention: input.rows.filter((row) => attention.has(row.patch.id)),
    off: input.rows.filter((row) => row.patch.state !== "live")
  };
  const found = (tab: Show) =>
    lists[tab]
      .filter(
        (row) =>
          (query === "" || matches(row, query)) &&
          (owner === undefined || row.owner.id === owner.id)
      )
      .sort(byTitle(viewer.company.name));
  const entries = found(show);

  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, input.page), pages);
  const shown = entries.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const here = listPath(listing, current);

  // Needs attention and Retired and deleted show only when they hold something, or are open.
  const filter = segmented({
    label: "Show",
    current: showLabels[show],
    items: shows
      .filter(
        (tab) => (tab !== "attention" && tab !== "off") || lists[tab].length > 0 || tab === show
      )
      .map((tab) => ({
        label: showLabels[tab],
        href: listPath({ ...listing, show: tab }),
        count: found(tab).length
      }))
  });
  const chips = [
    ...(owner === undefined
      ? []
      : [
          chip({
            key: "Owner",
            value: owner.name,
            href: listPath({ ...listing, owner: "" }),
            on: true
          })
        ]),
    ...(query
      ? [
          chip({
            key: "Matching",
            value: query,
            href: listPath({ ...listing, query: "" }),
            on: true
          })
        ]
      : [])
  ];
  const searched = chips.length > 0 ? `<span class="grow cluster">${chips.join("")}</span>` : "";

  // On a phone, where Failures is gone, a failing tool says so under its name.
  const failed = (patch: Patches.Patch) => failedBadge(patch, input.calls?.get(patch.id));
  const patchCell = (row: Patches.ReadPatch, phone = "") => {
    const { patch } = row;
    // A live patch's title opens it, as on Home; an off one's leads to its card. The dot marks a
    // colleague's the viewer has never opened, under every filter and search, as on Home.
    const href = patch.state === "live" ? patchAddress(patch) : cardPath(patch);
    const title = patchTitle(patch, viewer.company.name);
    const line = firstClause(patch.description);
    return `<div class="cell-name">${patchMark(patch.name, row.tier)}<div class="row-main"><span class="row-name"><a class="row-link" href="${escapeAttribute(href)}">${unopened(row, viewer, input.opens) ? unopenedName(title) : escapeHtml(title)}</a></span>${line ? `<span class="row-desc">${escapeHtml(line)}</span>` : ""}${phone ? `<span class="show-sm">${phone}</span>` : ""}</div></div>`;
  };
  // The owner by first name, as the avatar beside it narrows them down, or You; a deactivated one
  // says so under it.
  const ownerCell = ({ owner }: Patches.ReadPatch) => {
    const name = owner.id === viewer.user.id ? "You" : (owner.name.trim().split(/\s+/u)[0] ?? "");
    return `<div class="cell-name">${avatar(owner.id, owner.name, owner.deactivated ? "off" : undefined)}<span title="${escapeAttribute(owner.name)}">${escapeHtml(name)}${owner.deactivated ? '<br><span class="meta">Deactivated</span>' : ""}</span></div>`;
  };
  const menuCell = (row: Patches.ReadPatch) =>
    actions(row, viewer, { publicBaseUrl: input.publicBaseUrl, now, here });
  const actionsColumn: Column = { label: "Actions", hidden: true, align: "end", nowrap: true };
  const ownerColumn: Column = { label: "Owner", hideOnPhone: true, nowrap: true };
  const patchColumn: Column = { label: "Patch", grow: true };

  const content = (() => {
    if (show === "attention")
      return table({
        label: "Patches that need attention",
        columns: [
          patchColumn,
          ownerColumn,
          { label: "Why it’s here", readable: true },
          { label: "Fix", hidden: true, align: "end", nowrap: true },
          actionsColumn
        ],
        rows: shown.map((row) => {
          const why = attention.get(row.patch.id)!;
          return [
            patchCell(row),
            ownerCell(row),
            `<div class="row-main"><span class="row-name">${escapeHtml(why.title)}</span><span class="row-desc">${escapeHtml(why.detail)}</span></div>`,
            why.act,
            menuCell(row)
          ];
        })
      });
    if (show === "off")
      return table({
        label: "Retired and deleted patches",
        columns: [patchColumn, ownerColumn, { label: "State", readable: true }, actionsColumn],
        rows: shown.map((row) => {
          const { patch } = row;
          const retired = patch.state === "retired";
          const at = retired ? patch.retiredAt : patch.deletedAt;
          const detail = retired
            ? `${actor(patch.retiredBy, names).trimStart()}${at === null ? "" : ` · ${dateLabel(at)}`}`
            : recoverable(patch, now)
              ? `Gone for good in ${daysLeft(epoch(patch.purgeAt!), now)} days`
              : "Recovery ended";
          return [
            patchCell(row),
            ownerCell(row),
            `<div class="row-main"><span>${retired ? badge("Retired") : badge("Deleted", "danger")}</span>${detail ? `<span class="row-desc">${escapeHtml(detail)}</span>` : ""}</div>`,
            menuCell(row)
          ];
        })
      });
    // Failures show beside the tier 2 patches the viewer manages, never on Pages.
    const failures = input.calls !== undefined && show !== "pages";
    const shares = shown.some(
      (row) => row.patch.state === "live" && row.owner.id === viewer.user.id
    );
    const access = ({ patch }: Patches.ReadPatch) => {
      if (patch.scope === "public") return "Public";
      const count = input.guests.get(patch.name) ?? 0;
      return count === 0 ? "Company" : `Company + ${plural(count, "guest", "guests")}`;
    };
    const shareCell = (row: Patches.ReadPatch) =>
      row.owner.id === viewer.user.id
        ? linkButton("Share", shareHref(here, row.patch.name), {
            kind: "quiet",
            size: "sm",
            icon: "share",
            ariaLabel: `Share ${patchTitle(row.patch, viewer.company.name)}`
          })
        : "";
    return table({
      label: "Patches",
      columns: [
        patchColumn,
        ownerColumn,
        { label: "Updated", hideOnPhone: true, nowrap: true },
        { label: "Visits", align: "end", hideOnPhone: true, nowrap: true },
        { label: "Access", hideOnPhone: true, nowrap: true },
        ...(failures ? [failuresColumn] : []),
        ...(shares
          ? [
              {
                label: "Share",
                hidden: true,
                hideOnPhone: true,
                align: "end",
                nowrap: true
              } as const
            ]
          : []),
        actionsColumn
      ],
      rows: shown.map((row) => [
        patchCell(row, failures ? failed(row.patch) : ""),
        ownerCell(row),
        `<time class="muted" datetime="${escapeAttribute(row.publishedAt)}">${escapeHtml(ago(row.publishedAt, now))}</time>`,
        escapeHtml(row.visits),
        access(row),
        ...(failures ? [failuresCell(row.patch, input.calls?.get(row.patch.id))] : []),
        ...(shares ? [shareCell(row)] : []),
        menuCell(row)
      ])
    });
  })();

  const newPatch = linkButton("New patch", "/?new", { kind: "primary", icon: "plus" });
  const empty: Record<Show, Parameters<typeof emptyState>[0]> = {
    all: lists.off.length
      ? { title: "No live patches" }
      : { title: "No patches yet", action: newPatch },
    tools: { title: "No tools yet" },
    pages: { title: "No pages yet" },
    yours: { title: "You have no live patches", action: newPatch },
    attention: { title: "Nothing needs your attention" },
    off: { title: "Nothing is retired or deleted" }
  };
  // A search that finds no live patch at all offers the line that has an agent build one.
  const missing = emptyState(
    query && owner === undefined && found("all").length === 0
      ? {
          title: `No patches match “${query}”`,
          body: "Hand this to your agent and it can build one.",
          action: `<div class="stack">${copyLine(`Build us a Patchy tool for ${query}`, "Request for your agent, select to copy", "the request for your agent")}${input.connected ? "" : '<p class="meta">No agent connected yet? <a href="/guide">Connect your agent</a></p>'}</div>`
        }
      : query
        ? { title: `No patches match “${query}”` }
        : owner !== undefined
          ? { title: `${owner.name} has no patches here` }
          : empty[show]
  );

  const managed = (input.management ?? []).filter(
    ({ card }) =>
      (query === "" ||
        `${card.patch.name} ${card.owner.name}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase())) &&
      (owner === undefined || card.owner.id === owner.id) &&
      (show !== "yours" || card.owner.id === viewer.user.id) &&
      (show !== "tools" || card.tier >= 2) &&
      (show !== "pages" || card.tier === 1) &&
      (show !== "off" || card.patch.state !== "live")
  );
  const management = managed.length
    ? section({
        title: "Access recovery",
        body: rows(
          managed.map(({ card, canManage }) =>
            row({
              lead: patchMark(card.patch.name, card.tier),
              name: card.patch.name,
              description: `${card.owner.name} · ${card.patch.state}`,
              href: cardPath(card.patch),
              end: linkButton(canManage ? "Manage" : "View", cardPath(card.patch), {
                size: "sm",
                ariaLabel: `${canManage ? "Manage" : "View"} ${card.patch.name}`
              })
            })
          ),
          true
        )
      })
    : "";
  const from = (current - 1) * PAGE_SIZE + 1;
  return indexPage({
    title: "All patches",
    toolbar: `${filter}${searched}`,
    content: `${entries.length ? content : managed.length ? "" : `<div class="box">${missing}</div>`}${management}<script defer src="${copyScriptPath}"></script>`,
    ...(pages > 1
      ? {
          pagination: `<span>${from}–${from + shown.length - 1} of ${entries.length}</span><span class="cluster">${current > 1 ? linkButton("Previous", listPath(listing, current - 1), { size: "sm" }) : ""}${current < pages ? linkButton("Next", listPath(listing, current + 1), { size: "sm" }) : ""}</span>`
        }
      : {})
  });
};
