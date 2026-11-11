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
  indexPage,
  isPage,
  isWelcomePage,
  linkButton,
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
  unopened
} from "./shared/presentation.js";

const DAY = 86_400_000;
/** How far back an open still makes a patch someone's usual. */
const USUAL_WINDOW = 30 * DAY;
const USUAL = 4;
const NEW = 3;
/** How long a colleague's patch the viewer hasn't opened stays in New. */
const NEW_WINDOW = 7 * DAY;
const COLLEAGUES = 12;
/** Below this many live patches Home reads whole, so it leaves out Your usual and New. */
const SHELVES_AT = 8;

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
  return `<time datetime="${escapeAttribute(iso)}">${escapeHtml(now - epoch(iso) < 7 * DAY ? ago(iso, now) : date.endsWith(year) ? date.slice(0, -year.length) : date)}</time>`;
};

/**
 * Home's one-line notice after someone's first publication: "<title> is live", or "Your welcome
 * page is live", with Open and Copy link. Home shows it for the day after, and the guide's watch
 * puts it in Home's notices when the publication lands while Home is open.
 */
export const renderPublishedNote = (row: Row, company: string, publicBaseUrl: string): string => {
  const { patch } = row;
  const title = patchTitle(patch, company);
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
  /** How many guests each of the viewer's own patches has, by name. */
  readonly guests: ReadonlyMap<string, number>;
  /** The viewer's patches whose guests can't open them now, by id, so Yours never claims they can. */
  readonly turnedAway: ReadonlySet<string>;
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
 * Home at `/`, in the order people come for: what needs them, Your usual, New, Yours, From
 * colleagues, then what other companies shared with them. Needs attention shows only when
 * something is wrong; below eight live patches Home reads whole, without Your usual and New.
 * Until the viewer connects an agent its notices offer Connect, unless the Final step is up.
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
  // New: made in the last week and not opened yet. A public page read signed out records no open,
  // so New leaves public pages out.
  const fresh = (entry: Row) =>
    dotted(entry) &&
    entry.patch.scope !== "public" &&
    now - epoch(entry.patch.createdAt) < NEW_WINDOW;
  const menu = (entry: Row, list: string) =>
    rowMenu(`${list}-${entry.patch.id}`, title(entry), [
      ...openItems(entry, viewer, input.publicBaseUrl, "/"),
      ...(manages(entry, viewer)
        ? [menuLink(cardPath(entry.patch, "settings"), "Settings", false, title(entry))]
        : [])
    ]);
  const failed = (entry: Row) => calls?.get(entry.patch.id)?.failures ?? 0;
  // A table row's patch: its mark, its title opening it, the dot until the viewer opens a
  // colleague's, the description's first clause, and, on a phone, what the hidden columns would
  // warn about.
  const patchCell = (entry: Row) => {
    const failures = mine(entry) ? failedBadge(entry.patch, calls?.get(entry.patch.id)) : "";
    return `<div class="cell-name">${patchMark(entry.patch.name, entry.tier)}<div class="row-main"><span class="row-name"><a class="row-link" href="${escapeAttribute(patchAddress(entry.patch))}">${dotted(entry) ? unopenedName(title(entry)) : escapeHtml(title(entry))}</a></span><span class="row-desc">${escapeHtml(firstClause(entry.patch.description) || "No description")}</span>${failures === "" ? "" : `<span class="show-sm">${failures}</span>`}</div></div>`;
  };

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

  const shelves = live.length >= SHELVES_AT;
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
  const usualSection = shelves
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

  // New: colleagues' patches from the last week the viewer hasn't opened, newest first.
  const newest = live
    .filter(fresh)
    .sort((a, b) => epoch(b.patch.createdAt) - epoch(a.patch.createdAt) || byTitle(a, b))
    .slice(0, NEW);
  const newSection =
    shelves && newest.length > 0
      ? region({
          id: "new",
          title: "New",
          body: rows(
            newest.map((entry) =>
              row({
                lead: patchMark(entry.patch.name, entry.tier),
                name: title(entry),
                href: patchAddress(entry.patch),
                unopened: true,
                description: `${kind(entry)} · ${entry.owner.name} · ${ago(entry.patch.createdAt, now)}`,
                end: linkButton("Open", patchAddress(entry.patch), {
                  size: "sm",
                  icon: "external",
                  newTab: true,
                  ariaLabel: `Open ${title(entry)} in a new tab`
                })
              })
            ),
            true
          )
        })
      : "";

  // Yours: A–Z, never re-sorted, with who can open each, its failures and the action menu.
  const yours = live.filter(mine).sort(byTitle);
  const tools = yours.some((entry) => !isPage(entry));
  const access = (entry: Row) => {
    if (entry.patch.scope === "public") return "Public";
    const guests = input.guests.get(entry.patch.name) ?? 0;
    return guests === 0
      ? "Company"
      : input.turnedAway.has(entry.patch.id)
        ? `Company · ${plural(guests, "guest can’t", "guests can’t")} open it`
        : `Company + ${plural(guests, "guest", "guests")}`;
  };
  const yoursSection = yours.length
    ? region({
        id: "yours",
        title: "Yours",
        body: table({
          label: "Your patches",
          columns: [
            { label: "Patch" },
            { label: "Access", hideOnPhone: true },
            ...(tools ? [failuresColumn] : []),
            { label: "Actions", hidden: true, align: "end" as const }
          ],
          rows: yours.map((entry) => [
            patchCell(entry),
            escapeHtml(access(entry)),
            ...(tools ? [failuresCell(entry.patch, calls?.get(entry.patch.id))] : []),
            menu(entry, "yours")
          ])
        })
      })
    : "";

  // From colleagues: everyone else's, A–Z, the first twelve, and the rest on All patches.
  const theirs = live.filter((entry) => !mine(entry)).sort(byTitle);
  const colleaguesSection = theirs.length
    ? region({
        id: "colleagues",
        title: "From colleagues",
        ...(theirs.length > COLLEAGUES
          ? { action: `<a href="/patches">See all ${theirs.length}</a>` }
          : {}),
        body: table({
          label: "Colleagues’ patches",
          columns: [
            { label: "Patch" },
            { label: "Owner", hideOnPhone: true },
            { label: "Updated", hideOnPhone: true },
            { label: "Actions", hidden: true, align: "end" }
          ],
          rows: theirs
            .slice(0, COLLEAGUES)
            .map((entry) => [
              patchCell(entry),
              `<div class="cluster">${avatar(entry.owner.id, entry.owner.name, entry.owner.deactivated ? "off" : undefined)}<span>${escapeHtml(firstName(entry.owner.name))}</span></div>`,
              when(entry.publishedAt, now),
              menu(entry, "colleagues")
            ])
        })
      })
    : "";

  return page(`${usualSection}${newSection}${yoursSection}${colleaguesSection}`);
};
