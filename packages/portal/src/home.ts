import { guestShareable, sharePath } from "./share.js";
import type { RequireSession } from "@patchy/auth";
import {
  copyLine,
  copyScriptPath,
  escapeAttribute,
  escapeHtml,
  isWelcomePage,
  menuLink,
  patchMark,
  rowMenu,
  searchField
} from "@patchy/core";
import type { Patches } from "@patchy/patches";
import { failedLog, isNew, manages, matches, openItems, patchAddress } from "./allPatches.js";
import { firstClause, patchTitle } from "./render.js";

/** Home's layout; components come from the shell. */
export const homeStyles = `
  .home-search { margin-top: 20px; }
  /* From 900px the sidebar holds the search; below it the sidebar folds into Menu, so Home keeps its own. */
  @media (min-width: 900px) {
    .home-search { display: none; }
  }
  .home { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 330px); gap: 36px; align-items: start; margin-top: 28px; }
  .home-solo { grid-template-columns: minmax(0, 1fr); }
  /* The shelves fit the column they get, which the Pages panel narrows, rather than the window. */
  .home-main { container-type: inline-size; }
  .home + .home-shelf, .home-shelf + .home-shelf { margin-top: 32px; }
  .home-usual { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  /* Rows sit flush with their heading; a plain row's padding is its hover frame. */
  .home-rows { display: grid; gap: 2px; margin: 0 -8px 8px; }
  /* home-row: a patch's row with its menu beside it rather than over its text. */
  .home-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2px; min-width: 0; }
  .home-foot { margin: 28px 0 0; }
  .home-matches { margin: 12px 0 0; }
  .home-solo > .note .copy-line { margin: 12px 0; }
  @media (max-width: 960px) {
    .home { grid-template-columns: minmax(0, 1fr); }
  }
  @container (max-width: 620px) {
    .home-usual { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @container (max-width: 280px) {
    .home-usual { grid-template-columns: minmax(0, 1fr); }
  }
`;

const DAY = 86_400_000;
/** How far back an open still makes a patch someone's usual. */
const USUAL_WINDOW = 30 * DAY;
/** How long a newly published page stays new to someone who hasn't opened it. */
const NEW_WINDOW = 7 * DAY;
const USUAL = 4;
const TOOLS = 12;
const PAGES = 3;

type Viewer = RequireSession.Viewer["Service"];
const epoch = (iso: string) => Date.parse(iso);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** `text` escaped, with each case-insensitive occurrence of `query` marked. */
const highlight = (text: string, query: string) => {
  if (query === "") return escapeHtml(text);
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let out = "";
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    out += `${escapeHtml(text.slice(from, at))}<mark>${escapeHtml(text.slice(at, at + needle.length))}</mark>`;
    from = at + needle.length;
  }
  return out + escapeHtml(text.slice(from));
};

/**
 * Home's one-line note after someone's first publication: "<title> is live", or "Your welcome
 * page is live", with Open and Copy link. Home shows it for the day after, and its watch script
 * puts it at the top when the publication lands while Home is open.
 */
export const renderPublishedNote = (row: Patches.ReadPatch, publicBaseUrl: string): string => {
  const { patch } = row;
  const title = patchTitle(patch);
  const url = `${publicBaseUrl.replace(/\/+$/u, "")}${patchAddress(patch)}`;
  const named = escapeAttribute(title);
  return `<section class="note note-ok note-inline" role="status"><span class="note-title">${isWelcomePage({ name: patch.name, tier: row.tier }) ? "Your welcome page is live" : `${escapeHtml(title)} is live`}</span><div class="actions"><a class="btn btn-primary" href="${escapeAttribute(patchAddress(patch))}" aria-label="Open ${named}">Open</a><button type="button" class="btn" data-copy="${escapeAttribute(url)}" aria-label="Copy link to ${named}" aria-live="polite" hidden>Copy link</button></div></section>`;
};

/** Named shares use normal addresses; opening still goes through the serving door. */
export const renderSharedWithYou = (shares: readonly Patches.GuestSharedPatch[]): string =>
  shares.length === 0
    ? ""
    : `<section class="home-shelf" aria-labelledby="shared-with-you"><h2 class="section-heading" id="shared-with-you">Shared with you</h2><ul class="list home-rows">${shares
        .map(
          (share) =>
            `<li><a class="tile-row tile-row-plain" href="${escapeAttribute(share.address)}">${patchMark(share.name, 0)}<span class="tile-body"><span class="tile-name">${escapeHtml(patchTitle(share))}</span><span class="tile-meta">${escapeHtml(share.companyName)}</span></span></a></li>`
        )
        .join("")}</ul></section>`;

export interface HomeInput {
  readonly rows: readonly Patches.ReadPatch[];
  readonly shared?: readonly Patches.GuestSharedPatch[];
  readonly viewer: Viewer;
  readonly opens: ReadonlyMap<string, Patches.Open>;
  readonly now: number;
  readonly publicBaseUrl: string;
  readonly query: string;
  /** `renderPublishedNote`'s note, while it applies. */
  readonly note?: string;
  /** Whether the viewer has a live machine token; without one Home offers Connect your agent. */
  readonly connected: boolean;
  /** The last day's failed calls for each live tier 2 patch the viewer manages; absent with none. */
  readonly failures?: ReadonlyMap<string, number>;
}

/**
 * Home at `/`: the viewer's usual patches, the company's tools and its pages, each opening the
 * patch, with About this patch in its menu. Below 900px it keeps its own search, which the
 * sidebar holds wider. Until the viewer connects an agent it offers Connect your agent, and the
 * caller may lay the Final step panel over it.
 */
export const renderHome = (input: HomeInput): string => {
  const { viewer, opens, now, query } = input;
  const company = viewer.company.name;
  const live = input.rows.filter((row) => row.patch.state === "live");
  const off = input.rows.length - live.length;
  const score = (row: Patches.ReadPatch) => opens.get(row.patch.id)?.score ?? 0;
  const byName = (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
    a.patch.name.localeCompare(b.patch.name);
  const byVisits = (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
    b.visits - a.visits || byName(a, b);
  const toolOrder = (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
    Number(b.owner.id === viewer.user.id) - Number(a.owner.id === viewer.user.id) ||
    score(b) - score(a) ||
    byVisits(a, b);
  const newest = (a: Patches.ReadPatch, b: Patches.ReadPatch) =>
    epoch(b.publishedAt) - epoch(a.publishedAt) || byName(a, b);

  const fresh = (row: Patches.ReadPatch) =>
    isNew(row, viewer, opens, now) ? '<span class="tag tag-new">New</span>' : "";
  const clause = (row: Patches.ReadPatch) => firstClause(row.patch.description) || "No description";
  // While searching, a row's line shows where it matched: the first clause, else the description
  // around the match. A title match shows in the row's name, so the clause stands.
  const line = (row: Patches.ReadPatch) => {
    if (query === "") return escapeHtml(clause(row));
    const needle = query.toLowerCase();
    const { description } = row.patch;
    const at = description.toLowerCase().indexOf(needle);
    if (at === -1 || clause(row).toLowerCase().includes(needle))
      return highlight(clause(row), query);
    const from = Math.max(0, at - 30);
    const to = Math.min(description.length, at + needle.length + 50);
    return `${from > 0 ? "…" : ""}${highlight(description.slice(from, to), query)}${to < description.length ? "…" : ""}`;
  };
  // A match the row doesn't show otherwise: the name behind a title, or the owner.
  const meta = (row: Patches.ReadPatch) => {
    if (query === "") return "";
    const needle = query.toLowerCase();
    const title = patchTitle(row.patch);
    const parts = [
      ...(title !== row.patch.name &&
      row.patch.name.includes(needle) &&
      !title.toLowerCase().includes(needle)
        ? [highlight(row.patch.name, query)]
        : []),
      ...(row.owner.name.toLowerCase().includes(needle) ? [highlight(row.owner.name, query)] : [])
    ];
    return parts.length ? `<span class="tile-meta">${parts.join(" · ")}</span>` : "";
  };
  // Shelves can hold the same patch twice, so each menu's id names its shelf.
  const menu = (row: Patches.ReadPatch, shelf: string) =>
    rowMenu(`${shelf}-${row.patch.id}`, patchTitle(row.patch), [
      ...openItems(row.patch, input.publicBaseUrl),
      ...(manages(row, viewer)
        ? [
            ...(guestShareable(row) ? [menuLink(sharePath(row.patch), "Share")] : []),
            menuLink(`/patches/${encodeURIComponent(row.patch.name)}/settings`, "Settings")
          ]
        : [])
    ]);
  const toolRow = (row: Patches.ReadPatch) =>
    `<li class="home-row"><a class="tile-row tile-row-plain home-tool" href="${escapeAttribute(patchAddress(row.patch))}">${patchMark(row.patch.name, row.tier)}<span class="tile-body"><span class="tile-name">${highlight(patchTitle(row.patch), query)}${fresh(row)}</span><span class="tile-text">${line(row)}</span>${meta(row)}</span></a>${menu(row, "tools")}</li>`;
  const pageRow = (row: Patches.ReadPatch, unread: boolean) =>
    `<li class="home-row"><a class="tile-row tile-row-plain home-page" href="${escapeAttribute(patchAddress(row.patch))}">${patchMark(row.patch.name, 0)}<span class="tile-body"><span class="tile-name">${highlight(patchTitle(row.patch), query)}</span><span class="tile-text">${line(row)}</span>${meta(row)}</span>${unread ? '<span class="whats-new-dot" role="img" aria-label="New to you"></span>' : ""}</a>${menu(row, "pages")}</li>`;
  // A usual tile is something the viewer already knows, so it has only its mark and title.
  const tile = (row: Patches.ReadPatch) =>
    `<div class="tile"><a class="tile-link" href="${escapeAttribute(patchAddress(row.patch))}">${patchMark(row.patch.name, row.tier)}<span class="tile-name">${escapeHtml(patchTitle(row.patch))}${fresh(row)}</span></a>${menu(row, "usual")}</div>`;
  // A shelf's heading leads to the same list on All patches, when it has one.
  const shelfHead = (title: string, count?: number, href?: string) => {
    const label = `${escapeHtml(title)}${count === undefined ? "" : ` <span class="count">${count}</span>`}`;
    return `<h2 class="section-heading">${href === undefined ? label : `<a href="${escapeAttribute(href)}">${label}</a>`}</h2>`;
  };
  const more = (count: number, shown: number, href: string, label: string) =>
    count > shown ? `<p><a href="${escapeAttribute(href)}">${escapeHtml(label)}</a></p>` : "";
  const placeholder = input.connected
    ? ""
    : '<li><a class="tile-row tile-row-placeholder" href="/guide"><span class="mono mono-placeholder" aria-hidden="true">+</span><span class="tile-body"><span class="tile-name">Connect your agent</span><span class="tile-text">One line to paste into your AI agent</span></span></a></li>';

  const search = searchField({
    action: "/",
    id: "home-search",
    query,
    placeholder: "Search patches",
    label: "Search patches",
    className: "home-search"
  });
  const foot =
    off > 0
      ? `<p class="supporting-text home-foot">${plural(off, "patch is", "patches are")} retired or deleted · <a href="/patches?show=off">See them</a></p>`
      : "";
  // An owner hears about their own tools' failures here; admins see everyone's in All patches.
  const failing = live.flatMap((row) => {
    const failed = input.failures?.get(row.patch.id) ?? 0;
    return row.owner.id === viewer.user.id && failed > 0 ? [{ row, failed }] : [];
  });
  const warning = failing.length
    ? `<section class="note note-warn" role="status"><span class="note-title">${failing.length === 1 ? "One of your tools is failing" : "Some of your tools are failing"}</span><ul class="list list-compact">${failing
        .map(
          ({ row, failed }) =>
            `<li class="list-row"><a href="${escapeAttribute(patchAddress(row.patch))}">${escapeHtml(patchTitle(row.patch))}</a>: <a href="${escapeAttribute(failedLog(row.patch))}">${plural(failed, "call", "calls")} failed in the last day</a></li>`
        )
        .join("")}</ul></section>`
    : "";
  const page = (body: string, heading = '<h1 class="page-heading">Home</h1>') =>
    `${heading}${input.note ?? ""}${warning}${search}${body}${renderSharedWithYou(input.shared ?? [])}${foot}<script defer src="${copyScriptPath}"></script>`;

  if (live.length === 0 && query === "")
    return page(
      `<section class="home-shelf">${
        input.rows.length === 0
          ? `<h1 class="page-heading">Nothing here yet</h1><p>${escapeHtml(company)}’s tools and pages show up here as people publish them.</p>`
          : `<h1 class="page-heading">Nothing is live</h1><p>None of ${escapeHtml(company)}’s patches is live right now.${off > 0 ? " Retired and deleted patches can be restored from All patches." : ""}</p>`
      }${placeholder ? `<ul class="list home-rows">${placeholder}</ul>` : ""}</section>`,
      ""
    );

  const tools = live.filter((row) => row.tier >= 1);
  const pages = live.filter((row) => row.tier === 0);

  if (query !== "") {
    const foundTools = tools.filter((row) => matches(row, query)).sort(toolOrder);
    const foundPages = pages.filter((row) => matches(row, query)).sort(newest);
    const total = foundTools.length + foundPages.length;
    const encoded = encodeURIComponent(query);
    const summary = `<p class="supporting-text home-matches">${plural(total, "match", "matches")} for “${escapeHtml(query)}” · <a href="/">Clear search</a></p>`;
    if (total === 0)
      return page(
        `${summary}<div class="home home-solo"><section class="note note-warn" aria-labelledby="miss-title"><span class="note-title" id="miss-title">Nothing at ${escapeHtml(company)} matches “${escapeHtml(query)}”</span><p>Hand this to your agent and it can build one:</p>${copyLine(`Build us a Patchy tool for ${query}`, "Request for your agent, select to copy", "the request for your agent")}<p class="supporting-text">${input.connected ? "" : 'No agent connected yet? <a href="/guide">Connect your agent</a> · '}<a href="${escapeAttribute(`/patches?show=off&q=${encoded}`)}">Search retired and deleted</a></p></section></div>`
      );
    const toolShelf = foundTools.length
      ? `<section class="home-shelf">${shelfHead("Tools", foundTools.length, `/patches?show=tools&q=${encoded}`)}<ul class="list home-rows">${foundTools.slice(0, TOOLS).map(toolRow).join("")}</ul>${more(foundTools.length, TOOLS, `/patches?show=tools&q=${encoded}`, `All ${foundTools.length} matching tools`)}</section>`
      : "";
    const pageShelf = foundPages.length
      ? `<aside class="side-panel home-pages" aria-label="Pages">${shelfHead("Pages", foundPages.length, `/patches?show=pages&q=${encoded}`)}<ul class="list home-rows">${foundPages
          .slice(0, PAGES * 2)
          .map((row) => pageRow(row, false))
          .join(
            ""
          )}</ul>${more(foundPages.length, PAGES * 2, `/patches?show=pages&q=${encoded}`, `All ${foundPages.length} matching pages`)}</aside>`
      : "";
    return page(
      `${summary}<div class="home${toolShelf && pageShelf ? "" : " home-solo"}">${toolShelf ? `<div class="home-main">${toolShelf}</div>` : ""}${pageShelf}</div>`
    );
  }

  // Your usual: what the viewer opened in the last 30 days. Until they open anything, it is what
  // the company visits most.
  const usual = live
    .filter((row) => {
      const open = opens.get(row.patch.id);
      return open !== undefined && now - epoch(open.lastOpenedAt) <= USUAL_WINDOW;
    })
    .sort((a, b) => score(b) - score(a) || byName(a, b))
    .slice(0, USUAL);
  const usualShelf = `<section class="home-shelf">${shelfHead(
    usual.length === 0 ? `Popular at ${company}` : "Your usual"
  )}<div class="home-usual">${(usual.length === 0
    ? [...live].sort(byVisits).slice(0, USUAL)
    : usual
  )
    .map(tile)
    .join("")}</div></section>`;

  const toolShelf = `<section class="home-shelf">${shelfHead("Tools", tools.length, "/patches?show=tools")}${
    tools.length || placeholder
      ? `<ul class="list home-rows">${[...tools]
          .sort(toolOrder)
          .slice(0, TOOLS)
          .map(toolRow)
          .join("")}${placeholder}</ul>`
      : ""
  }${more(tools.length, TOOLS, "/patches?show=tools", `All ${tools.length} tools`)}</section>`;

  // Pages new to the viewer lead, marked, then the latest of the rest.
  const unread = (row: Patches.ReadPatch) => {
    if (row.patch.scope !== "company" || row.owner.id === viewer.user.id) return false;
    if (now - epoch(row.publishedAt) >= NEW_WINDOW) return false;
    const open = opens.get(row.patch.id);
    return open === undefined || epoch(open.lastOpenedAt) < epoch(row.publishedAt);
  };
  const unreadPages = pages.filter(unread).sort(newest).slice(0, PAGES);
  const unreadIds = new Set(unreadPages.map((row) => row.patch.id));
  const latest = pages
    .filter((row) => !unreadIds.has(row.patch.id))
    .sort(newest)
    .slice(0, PAGES);
  const pageShelf = pages.length
    ? `<aside class="side-panel home-pages" aria-label="Pages">${shelfHead("Pages", pages.length, "/patches?show=pages")}<ul class="list home-rows">${[
        ...unreadPages.map((row) => pageRow(row, true)),
        ...latest.map((row) => pageRow(row, false))
      ].join("")}</ul></aside>`
    : "";

  return page(
    `<div class="home${pageShelf ? "" : " home-solo"}"><div class="home-main">${usualShelf}${toolShelf}</div>${pageShelf}</div>`
  );
};
