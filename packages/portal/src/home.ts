import type { RequireSession } from "@patchy/auth";
import {
  ago,
  copyLine,
  copyScriptPath,
  escapeAttribute,
  escapeHtml,
  menuCopy,
  menuLink,
  patchMark,
  rowMenu,
  searchField
} from "@patchy/core";
import type { Patches } from "@patchy/patches";
import { isNew, matches } from "./allPatches.js";
import { firstClause } from "./render.js";

/** Home's layout; components come from the shell. */
export const homeStyles = `
  .home-top { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .home-search { flex: 1; min-width: min(100%, 280px); }
  .home { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 330px); gap: 36px; align-items: start; margin-top: 28px; }
  .home-solo { grid-template-columns: minmax(0, 1fr); }
  .home-shelf + .home-shelf { margin-top: 32px; }
  .home-shelf-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; margin-bottom: 12px; }
  .home-shelf-head > * { margin: 0; }
  .home-usual { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
  .home-tools { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .home-pages { padding: 18px 18px 8px; border: 2px solid var(--ink); border-radius: var(--radius); }
  .home-pages ul { display: grid; gap: 2px; margin: 0 -8px 8px; padding: 0; list-style: none; }
  .home-group { margin: 14px 0 4px; font-size: .78rem; letter-spacing: .06em; text-transform: uppercase; }
  .home-foot { margin: 28px 0 0; }
  .home-matches { margin: 12px 0 0; }
  .home-solo > .note .copy-line { margin: 12px 0; }
  @media (max-width: 960px) {
    .home { grid-template-columns: minmax(0, 1fr); }
    .home-usual { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .home-tools { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 520px) {
    .home-usual, .home-tools { grid-template-columns: minmax(0, 1fr); }
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

export interface HomeInput {
  readonly rows: readonly Patches.ReadPatch[];
  readonly viewer: Viewer;
  readonly opens: ReadonlyMap<string, Patches.Open>;
  readonly now: number;
  readonly publicBaseUrl: string;
  readonly query: string;
  /** "Your first patch is live", while it applies. */
  readonly note?: string;
}

/**
 * Home at `/`: search, the viewer's usual patches, the company's tools and its pages. The caller
 * renders the guide instead when nothing is live and the viewer owns nothing.
 */
export const renderHome = (input: HomeInput): string => {
  const { viewer, opens, now, query } = input;
  const company = viewer.company.name;
  const base = input.publicBaseUrl.replace(/\/+$/u, "");
  const address = (patch: Patches.Patch) =>
    `/${encodeURIComponent(patch.companyHandle)}/${encodeURIComponent(patch.name)}`;
  const live = input.rows.filter((row) => row.patch.state === "live");
  const off = input.rows.length - live.length;
  const ownsAny = input.rows.some((row) => row.owner.id === viewer.user.id);
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

  const tags = (row: Patches.ReadPatch) =>
    `${row.owner.id === viewer.user.id ? '<span class="tag">You</span>' : ""}${isNew(row, viewer, opens, now) ? '<span class="tag">New</span>' : ""}`;
  const clause = (row: Patches.ReadPatch) => firstClause(row.patch.description) || "No description";
  const toolRow = (row: Patches.ReadPatch) =>
    `<a class="tile-row" href="${escapeAttribute(address(row.patch))}">${patchMark(row.patch.name, row.tier)}<span class="tile-body"><span class="tile-name">${highlight(row.patch.name, query)}${tags(row)}</span><span class="tile-text">${highlight(clause(row), query)}</span></span></a>`;
  const pageRow = (row: Patches.ReadPatch, unread: boolean) =>
    `<li><a class="tile-row tile-row-plain home-page" href="${escapeAttribute(address(row.patch))}">${patchMark(row.patch.name, 0)}<span class="tile-body"><span class="tile-name">${highlight(row.patch.name, query)}${row.owner.id === viewer.user.id ? '<span class="tag">You</span>' : ""}</span><span class="tile-text">${highlight(clause(row), query)}</span><span class="tile-meta">${escapeHtml(row.owner.name)} · ${escapeHtml(ago(row.publishedAt, now))}</span></span>${unread ? '<span class="whats-new-dot" role="img" aria-label="New to you"></span>' : ""}</a></li>`;
  const tile = (row: Patches.ReadPatch, meta: string) => {
    const { patch } = row;
    const url = `${base}${address(patch)}`;
    const menu = rowMenu(patch.id, patch.name, [
      menuLink(`/patches/${encodeURIComponent(patch.name)}`, "About this patch"),
      `<a class="menu-item" href="${escapeAttribute(address(patch))}" target="_blank" rel="noopener">Open in a new tab</a>`,
      menuCopy(url, "Copy link")
    ]);
    return `<div class="tile"><a class="tile-link" href="${escapeAttribute(address(patch))}">${patchMark(patch.name, row.tier)}<span class="tile-name">${escapeHtml(patch.name)}${tags(row)}</span><span class="tile-text">${escapeHtml(clause(row))}</span><span class="tile-meta">${escapeHtml(meta)}</span></a>${menu}</div>`;
  };
  const shelfHead = (title: string, count: number | null, aside: string) =>
    `<div class="home-shelf-head"><h2 class="section-heading">${escapeHtml(title)}${count === null ? "" : ` <span class="count">${count}</span>`}</h2>${aside}</div>`;
  const more = (count: number, shown: number, href: string, label: string) =>
    count > shown ? `<p><a href="${escapeAttribute(href)}">${escapeHtml(label)}</a></p>` : "";
  const placeholder = ownsAny
    ? ""
    : '<a class="tile-row tile-row-placeholder" href="/guide"><span class="mono mono-placeholder" aria-hidden="true">+</span><span class="tile-body"><span class="tile-name">Make your own</span><span class="tile-text">Ask your agent; the guide shows you how</span></span></a>';

  const search = `<div class="home-top">${searchField({
    action: "/",
    id: "home-search",
    query,
    placeholder: `Search ${company}’s ${plural(live.length, "patch", "patches")} by name, purpose or owner`,
    label: "Search patches",
    className: "home-search"
  })}<a class="btn" href="/patches">All patches</a></div>`;
  const foot = `<p class="supporting-text home-foot"><a href="/patches">All patches</a>${off > 0 ? ` · ${plural(off, "patch is", "patches are")} retired or deleted · <a href="/patches?show=off">See them</a>` : ""}</p>`;
  const page = (body: string) =>
    `${input.note ?? ""}${search}${body}${foot}<script defer src="${copyScriptPath}"></script>`;

  if (live.length === 0)
    return page(
      `<section class="home-shelf"><h1 class="page-heading">Nothing is live</h1><p>None of ${escapeHtml(company)}’s patches is live right now.${off > 0 ? " Retired and deleted patches can be restored from All patches." : ""}</p></section>`
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
        `${summary}<div class="home home-solo"><section class="note note-warn" aria-labelledby="miss-title"><span class="note-title" id="miss-title">Nothing at ${escapeHtml(company)} matches “${escapeHtml(query)}”</span><p>Hand this to your agent and it can build one:</p>${copyLine(`Build us a Patchy tool for ${query}`, "Request for your agent, select to copy")}<p class="supporting-text">${ownsAny ? "" : 'No agent set up yet? <a href="/guide">Make your first patch</a> · '}<a href="${escapeAttribute(`/patches?show=off&q=${encoded}`)}">Search retired and deleted</a></p></section></div>`
      );
    const toolShelf = foundTools.length
      ? `<section class="home-shelf">${shelfHead("Tools", foundTools.length, "")}<div class="home-tools">${foundTools.slice(0, TOOLS).map(toolRow).join("")}</div>${more(foundTools.length, TOOLS, `/patches?show=tools&q=${encoded}`, `All ${foundTools.length} matching tools`)}</section>`
      : "";
    const pageShelf = foundPages.length
      ? `<aside class="home-pages" aria-label="Pages">${shelfHead("Pages", foundPages.length, "")}<ul>${foundPages
          .slice(0, PAGES * 2)
          .map((row) => pageRow(row, false))
          .join(
            ""
          )}</ul>${more(foundPages.length, PAGES * 2, `/patches?show=pages&q=${encoded}`, `All ${foundPages.length} matching pages`)}</aside>`
      : "";
    return page(
      `${summary}<div class="home${toolShelf && pageShelf ? "" : " home-solo"}">${toolShelf ? `<div>${toolShelf}</div>` : ""}${pageShelf}</div>`
    );
  }

  // Your usual: what the viewer opened in the last 30 days, padded from what the company visits most.
  const usual = live
    .filter((row) => {
      const open = opens.get(row.patch.id);
      return open !== undefined && now - epoch(open.lastOpenedAt) <= USUAL_WINDOW;
    })
    .sort((a, b) => score(b) - score(a) || byName(a, b))
    .slice(0, USUAL);
  const chosen = new Set(usual.map((row) => row.patch.id));
  const padding = [...live]
    .filter((row) => !chosen.has(row.patch.id))
    .sort(byVisits)
    .slice(0, USUAL - usual.length);
  const popular = `Popular at ${company}`;
  const usualTiles = [
    ...usual.map((row) =>
      tile(
        row,
        `${row.tier === 0 ? "Page · opened" : "Opened"} ${ago(opens.get(row.patch.id)!.lastOpenedAt, now)}`
      )
    ),
    ...padding.map((row) =>
      tile(row, usual.length === 0 ? plural(row.visits, "visit", "visits") : popular)
    )
  ];
  const usualShelf = `<section class="home-shelf">${shelfHead(
    usual.length === 0 ? popular : "Your usual",
    null,
    `<p class="supporting-text">${usual.length === 0 ? "Your usual takes over as you open things" : "What you open most"}</p>`
  )}<div class="home-usual">${usualTiles.join("")}</div></section>`;

  const toolShelf = `<section class="home-shelf">${shelfHead(
    "Tools",
    tools.length,
    `<p class="supporting-text">${ownsAny ? "Yours first, then the most opened" : "The most opened first"}</p>`
  )}${
    tools.length || placeholder
      ? `<div class="home-tools">${[...tools]
          .sort(toolOrder)
          .slice(0, TOOLS)
          .map(toolRow)
          .join("")}${placeholder}</div>`
      : ""
  }${more(tools.length, TOOLS, "/patches?show=tools", `All ${tools.length} tools`)}</section>`;

  const unread = (row: Patches.ReadPatch) => {
    if (row.patch.scope !== "company" || row.owner.id === viewer.user.id) return false;
    if (now - epoch(row.publishedAt) >= NEW_WINDOW) return false;
    const open = opens.get(row.patch.id);
    return open === undefined || epoch(open.lastOpenedAt) < epoch(row.publishedAt);
  };
  const fresh = pages.filter(unread).sort(newest).slice(0, PAGES);
  const freshIds = new Set(fresh.map((row) => row.patch.id));
  const latest = pages
    .filter((row) => !freshIds.has(row.patch.id))
    .sort(newest)
    .slice(0, PAGES);
  const group = (title: string, list: readonly Patches.ReadPatch[], dot: boolean) =>
    list.length
      ? `<h3 class="home-group supporting-text">${title}</h3><ul>${list.map((row) => pageRow(row, dot)).join("")}</ul>`
      : "";
  const pageShelf = pages.length
    ? `<aside class="home-pages" aria-label="Pages">${shelfHead(
        "Pages",
        pages.length,
        `<a href="/patches?show=pages">All ${plural(pages.length, "page", "pages")}</a>`
      )}${group("New to you", fresh, true)}${group("Latest", latest, false)}</aside>`
    : "";

  return page(
    `<div class="home${pageShelf ? "" : " home-solo"}"><div>${usualShelf}${toolShelf}</div>${pageShelf}</div>`
  );
};
