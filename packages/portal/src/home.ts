import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { guestReasonText } from "@patchy/api";
import type { EndedAccess, RequireSession } from "@patchy/auth";
import {
  ago,
  attentionRow,
  avatar,
  copyButton,
  copyScriptPath,
  dateLabel,
  emptyState,
  escapeAttribute,
  escapeHtml,
  iconButton,
  indexPage,
  isPage,
  isWelcomePage,
  linkButton,
  mainWithRail,
  menuLink,
  menuNewTab,
  notice,
  patchMark,
  patchTitle,
  productMark,
  region,
  row,
  rowMenu,
  rows,
  table,
  type Template,
  unopenedName,
  usualTiles
} from "@patchy/core";
import type { ConnectionAttention } from "@patchy/integrations";
import type { GuestGrants, Patches } from "@patchy/patches";
import type { InvocationLog } from "@patchy/runtime";
import {
  byTitle as titled,
  cardPath,
  failedBadge,
  failedLog,
  failuresCell,
  failuresColumn,
  firstClause,
  manages,
  openItems,
  patchAddress,
  shareHref,
  unopened
} from "./shared/presentation.js";

const DAY = 86_400_000;
/** How far back an open still makes a patch someone's usual. */
const USUAL_WINDOW = 30 * DAY;
const USUAL = 4;
/** Below this many live patches Home reads whole, so it leaves out Your usual. */
const SHELVES_AT = 8;
/** How long after its served version was published a page stays under Pages beside Tools. */
const PAGES_WINDOW = 14 * DAY;
/** Pages beside Tools: one row per owner, at most this many. */
const PAGE_OWNERS = 5;
/** Pages in the main column, when the company has no live tool. */
const PAGES_ALONE = 12;

type Viewer = RequireSession.Viewer["Service"];
type Row = Patches.ReadPatch;
const epoch = (iso: string) => Date.parse(iso);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const kind = (row: Row) => (isPage(row) ? "Page" : "Tool");
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
/** When a list says something changed: "2 hours ago" for a week, then the date, its year only if another. */
const when = (iso: string, now: number) => {
  const year = ` ${DateTime.toPartsUtc(DateTime.makeUnsafe(now)).year}`;
  const date = dateLabel(iso);
  return now - epoch(iso) < 7 * DAY
    ? ago(iso, now)
    : date.endsWith(year)
      ? date.slice(0, -year.length)
      : date;
};
/** Newest served version first, then A–Z. */
const newest = (byTitle: (a: Row, b: Row) => number) => (a: Row, b: Row) =>
  epoch(b.publishedAt) - epoch(a.publishedAt) || byTitle(a, b);

/**
 * Home's one-line notice after someone's first publication: "<title> is live", or "Your welcome
 * page is live", with Open and Copy link. Home shows it for the day after, and the guide's watch
 * puts it in Home's notices when the publication lands while Home is open. One its owner can't
 * open any more says so, with the way to its card.
 */
export const renderPublishedNote = (row: Row, company: string, publicBaseUrl: string): string => {
  const { patch } = row;
  const title = patchTitle(patch, company);
  if (!row.access.canOpen)
    return notice({
      tone: "info",
      title: `You can’t open ${title}`,
      action: linkButton("View patch", cardPath(patch), { size: "sm", ariaLabel: `View ${title}` })
    });
  const url = `${publicBaseUrl.replace(/\/+$/u, "")}${patchAddress(patch)}`;
  return notice({
    tone: "info",
    title: isWelcomePage({ name: patch.name, tier: row.tier })
      ? "Your welcome page is live"
      : `${title} is live`,
    action: `<div class="btn-group">${linkButton("Open", patchAddress(patch), { size: "sm", ariaLabel: `Open ${title}` })}${copyButton(url, { label: "Copy link", ariaLabel: `Copy link to ${title}`, size: "sm" })}</div>`
  });
};

export interface HomeInput {
  readonly rows: readonly Row[];
  readonly viewer: Viewer;
  readonly opens: ReadonlyMap<string, Patches.Open>;
  readonly now: number;
  readonly publicBaseUrl: string;
  /** Offer Connect your agent: the viewer has no live machine token and the Final step isn't up. */
  readonly connect: boolean;
  /** `renderPublishedNote`'s notice, while it applies. */
  readonly note?: string;
  /** The call summary of each live tier 2 patch the viewer manages; absent when they manage none. */
  readonly calls?: ReadonlyMap<string, InvocationLog.CallSummary>;
  /** The company's connections that need an admin; empty for anyone else. */
  readonly connections: ReadonlyArray<ConnectionAttention.Attention>;
  /** The viewer's own apps and computers whose access ended on its own lately. */
  readonly ended: ReadonlyArray<EndedAccess>;
  /**
   * How many live pages All patches' Pages lists for the viewer, the ones they manage but can't
   * open included, so All N pages never disagrees with it.
   */
  readonly pageCount: number;
  /** Other companies' patches shared with the viewer. */
  readonly shared: readonly GuestGrants.Shared[];
}

/**
 * Other companies' patches shared with the viewer, each opening the patch, or saying why it can't
 * while its guests can't open it, with Remove… in its menu. Nothing when there are none. One they
 * can open and never have carries the dot; a public one never does, since a guest reads its
 * public page as anyone does and that records no open.
 */
const sharedSection = (
  shared: readonly GuestGrants.Shared[],
  opens: ReadonlyMap<string, Patches.Open>
) => {
  if (shared.length === 0) return "";
  const entry = (item: GuestGrants.Shared) => {
    const title = patchTitle(item, item.company.name);
    const address = `/${encodeURIComponent(item.company.handle)}/${encodeURIComponent(item.name)}`;
    const open = Option.isNone(item.unavailable);
    return row({
      lead: patchMark(item.name, item.tier),
      name: title,
      ...(open ? { href: address } : {}),
      unopened: open && item.scope !== "public" && !opens.has(item.patchId),
      description: `${item.company.name} · shared by ${item.sharedBy}${Option.match(item.unavailable, { onNone: () => "", onSome: (reason) => ` · Can’t open it now. ${guestReasonText(reason)}` })}`,
      end: rowMenu(`shared-${item.patchId}`, title, [
        ...(open ? [menuNewTab(address, title)] : []),
        menuLink(`/shared/${encodeURIComponent(item.patchId)}/remove`, "Remove…", true, title)
      ])
    });
  };
  return region({ id: "shared", title: "Shared with you", body: rows(shared.map(entry), true) });
};

/**
 * Home at `/`, in the order people come for: what needs them, Your usual, then the company's
 * tools with its recent pages beside them, then what other companies shared with them. Needs
 * attention shows only when something is wrong; below eight live patches Home reads whole,
 * without Your usual. Until the viewer connects an agent its notices offer Connect, unless the
 * Final step is up.
 */
export const renderHome = (input: HomeInput): Template => {
  const { viewer, opens, now, calls } = input;
  const company = viewer.company.name;
  const title = (entry: Row) => patchTitle(entry.patch, company);
  const byTitle = titled(company);
  const live = input.rows.filter((entry) => entry.patch.state === "live");
  const mine = (entry: Row) => entry.owner.id === viewer.user.id;
  const owner = (entry: Row) => (mine(entry) ? "You" : firstName(entry.owner.name));
  const dotted = (entry: Row) => unopened(entry, viewer, opens);
  const menu = (entry: Row, list: string) =>
    rowMenu(`${list}-${entry.patch.id}`, title(entry), [
      ...openItems(entry, viewer, input.publicBaseUrl, "/"),
      ...(manages(entry)
        ? [menuLink(cardPath(entry.patch, "settings"), "Settings", false, title(entry))]
        : [])
    ]);
  const failed = (entry: Row) => calls?.get(entry.patch.id)?.failures ?? 0;

  // Needs attention: the viewer's own tools that failed in the last 24 hours, for admins the
  // company's connections that need one, then the viewer's own apps and computers whose access
  // ended. Each says what broke and has the one action that fixes it.
  const failing = live.filter((entry) => mine(entry) && failed(entry) > 0).sort(byTitle);
  const attention = [
    ...failing.map((entry) =>
      attentionRow({
        lead: patchMark(entry.patch.name, entry.tier),
        name: title(entry),
        href: patchAddress(entry.patch),
        problem: `${plural(failed(entry), "call", "calls")} failed in the last 24 hours`,
        fix: linkButton("View log", failedLog(entry.patch), {
          size: "sm",
          ariaLabel: `View the failed calls of ${title(entry)}`
        })
      })
    ),
    ...input.connections.map((connection) =>
      attentionRow({
        lead: productMark(connection.mark),
        name: connection.name,
        href: connection.fix.href,
        problem: connection.problem,
        detail: connection.detail,
        fix: linkButton(connection.fix.label, connection.fix.href, {
          size: "sm",
          ariaLabel: `${connection.fix.label.replace(/…$/u, "")} ${connection.name}`
        })
      })
    ),
    ...input.ended.map((access) =>
      attentionRow({
        lead: access.mark,
        name: access.name,
        href: "/agents",
        problem: `Access ended ${dateLabel(access.endedAt)}`,
        fix: linkButton("Reconnect", access.reconnect, {
          size: "sm",
          ariaLabel: `Reconnect ${access.name}`
        })
      })
    )
  ];
  const needs = attention.length
    ? region({ id: "attention", title: "Needs attention", body: rows(attention, true) })
    : "";
  // At most two one-line notices: Connect, and the first publication's.
  const notes = `<div data-home-notes>${
    input.connect
      ? notice({
          tone: "info",
          title: "Connect your agent to build patches",
          action: linkButton("Connect", "/guide", { size: "sm" })
        })
      : ""
  }${input.note ?? ""}</div>`;
  const page = (content: string) =>
    indexPage({
      title: "Home",
      content: `${notes}${needs}${content}${sharedSection(input.shared, opens)}<script defer src="${copyScriptPath}"></script>`
    });

  if (live.length === 0)
    return page(
      region({
        id: "patches",
        title: "Patches",
        body: rows(
          [
            input.rows.length === 0
              ? emptyState({
                  title: "No patches yet",
                  body: `What ${company} builds shows up here.`,
                  ...(viewer.role !== "member"
                    ? { action: linkButton("Invite people", "/settings/people", { size: "sm" }) }
                    : {})
                })
              : emptyState({
                  title: "Nothing is live",
                  body: `None of ${company}’s patches is live right now.`,
                  action: linkButton("See retired and deleted", "/patches?show=off", { size: "sm" })
                })
          ],
          true
        )
      })
    );

  // Your usual: what the viewer opened in the last 30 days, by how much. Until they open
  // anything, it is what the company visits most.
  const score = (entry: Row) => opens.get(entry.patch.id)?.score ?? 0;
  const opened = live
    .filter((entry) => {
      const open = opens.get(entry.patch.id);
      return open !== undefined && now - epoch(open.lastOpenedAt) <= USUAL_WINDOW;
    })
    .sort((a, b) => score(b) - score(a) || byTitle(a, b));
  const usual = (
    opened.length > 0 ? opened : [...live].sort((a, b) => b.visits - a.visits || byTitle(a, b))
  ).slice(0, USUAL);
  const usualSection =
    live.length >= SHELVES_AT
      ? region({
          id: "usual",
          title: opened.length > 0 ? "Your usual" : `Popular at ${company}`,
          body: usualTiles(
            usual.map((entry) => ({
              mark: patchMark(entry.patch.name, entry.tier),
              name: title(entry),
              meta: `${kind(entry)} · ${owner(entry)}`,
              href: patchAddress(entry.patch)
            }))
          )
        })
      : "";

  // Tools: every live tier 2 patch, A–Z and never re-sorted. Below 1280px, where Pages beside it
  // leaves the table narrow, its Failures column gives way and a failing tool's count shows under
  // its title instead; Share on the viewer's own turns to its icon, and on a phone to the menu's.
  const tools = live.filter((entry) => !isPage(entry)).sort(byTitle);
  const failures = tools.some(manages);
  const share = (entry: Row) => {
    const href = shareHref("/", entry.patch.name);
    const label = `Share ${title(entry)}`;
    return `<span class="hide-below-wide">${linkButton("Share", href, { kind: "quiet", size: "sm", icon: "share", ariaLabel: label })}</span><span class="show-below-wide">${iconButton(label, "share", { href })}</span>`;
  };
  const toolCell = (entry: Row) => {
    const count = manages(entry) ? failedBadge(entry.patch, calls?.get(entry.patch.id)) : "";
    return `<div class="cell-name">${patchMark(entry.patch.name, entry.tier)}<div class="row-main"><span class="row-name"><a class="row-link" href="${escapeAttribute(patchAddress(entry.patch))}">${dotted(entry) ? unopenedName(title(entry)) : escapeHtml(title(entry))}</a></span><span class="row-desc">${escapeHtml(firstClause(entry.patch.description) || "No description")}</span>${count === "" ? "" : `<span class="show-below-wide">${count}</span>`}</div></div>`;
  };
  const toolsSection = region({
    id: "tools",
    title: "Tools",
    body: table({
      label: "Tools",
      columns: [
        { label: "Patch", grow: true },
        { label: "Owner", hideOnPhone: true, nowrap: true },
        ...(failures ? [{ ...failuresColumn, hideBelowWide: true }] : []),
        { label: "Share", hidden: true, hideOnPhone: true, align: "end" as const, nowrap: true },
        { label: "Actions", hidden: true, align: "end" as const, nowrap: true }
      ],
      rows: tools.map((entry) => [
        toolCell(entry),
        `<div class="cell-name">${avatar(entry.owner.id, entry.owner.name, entry.owner.deactivated ? "off" : undefined)}<span>${escapeHtml(owner(entry))}</span></div>`,
        ...(failures
          ? [manages(entry) ? failuresCell(entry.patch, calls?.get(entry.patch.id)) : ""]
          : []),
        mine(entry) ? share(entry) : "",
        menu(entry, "tools")
      ])
    })
  });

  // Pages: beside Tools, the ones published in the last two weeks, each owner's newest once,
  // with "+N more" for that owner's others; with no live tool, every page in the main column.
  // Either way it ends at All patches' Pages, counted as that lists them.
  const pages = live.filter(isPage).sort(newest(byTitle));
  const pageRow = (entry: Row, others = 0) =>
    row({
      lead: patchMark(entry.patch.name, entry.tier),
      name: title(entry),
      href: patchAddress(entry.patch),
      unopened: dotted(entry),
      description: `${owner(entry)} · ${when(entry.publishedAt, now)}`,
      ...(others > 0
        ? {
            descriptionLink: {
              label: `+${others} more`,
              href: `/patches?${new URLSearchParams({ show: "pages", owner: entry.owner.id })}`,
              ariaLabel: mine(entry)
                ? `${others} more of your pages`
                : `${plural(others, "more page", "more pages")} by ${entry.owner.name}`
            }
          }
        : {}),
      end: menu(entry, "pages")
    });
  const allPages = `<div class="meta"><a href="/patches?show=pages">All ${plural(input.pageCount, "page", "pages")}</a></div>`;
  const pagesSection = (items: readonly string[]) =>
    region({
      id: "pages",
      title: "Pages",
      body: items.length ? `<div class="stack">${rows(items, true)}${allPages}</div>` : allPages
    });
  const recent = new Map<string, { entry: Row; others: number }>();
  for (const entry of pages.filter((entry) => now - epoch(entry.publishedAt) < PAGES_WINDOW)) {
    const seen = recent.get(entry.owner.id);
    if (seen === undefined) recent.set(entry.owner.id, { entry, others: 0 });
    else seen.others++;
  }

  const shelves =
    tools.length === 0
      ? pagesSection(pages.slice(0, PAGES_ALONE).map((entry) => pageRow(entry)))
      : pages.length === 0
        ? toolsSection
        : mainWithRail({
            main: toolsSection,
            rail: pagesSection(
              [...recent.values()]
                .slice(0, PAGE_OWNERS)
                .map(({ entry, others }) => pageRow(entry, others))
            )
          });

  return page(`${usualSection}${shelves}`);
};
