import { avatar, searchField } from "./components.js";
import { changesSince, type ChangeKind, latestRelease, tally } from "./whatsNew.js";

/** Shared component subset for first-party pages and the served document's state notices. */
export const shellStyles = `
    :root {
      --paper: #fffdf4;
      --paper-blue: #eaf5ff;
      --paper-green: #eff9e8;
      --paper-amber: #fff7e4;
      /* Mark tints: stronger than the papers, so a patch's mark reads at a glance beside its name. */
      --tint-green: #cdeebb;
      --tint-blue: #cfe4ff;
      --tint-amber: #ffe2a8;
      --tint-pink: #f6d3e4;
      --white: #fffefa;
      --ink: #12110f;
      --ink-soft: #36332d;
      --muted: #69645a;
      --line: rgba(18, 17, 15, .14);
      --line-strong: rgba(18, 17, 15, .30);
      --blue: #1263e6;
      --blue-dark: #093b92;
      --green: #64c83f;
      --green-ink: #2f6a17;
      --yellow: #ffbf35;
      --amber-ink: #8a5a00;
      --danger: #963c22;
      --field-radius: 6px;
      --shadow-hard: 4px 4px 0 var(--ink);
      --shadow-soft: 0 18px 50px rgba(18, 17, 15, .08);
      --radius: 8px;
      --radius-pill: 999px;
      --font-sans: system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", sans-serif;
      --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }
    :focus-visible {
      outline: 3px solid var(--blue);
      outline-offset: 3px;
      border-radius: 6px;
    }
    .glyph {
      position: relative;
      width: 30px;
      height: 30px;
      flex: none;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: var(--green);
      box-shadow: 3px 3px 0 var(--ink);
      transform: rotate(-5deg);
    }

    .glyph::after {
      content: "";
      position: absolute;
      top: 6px;
      right: 5px;
      width: 10px;
      height: 10px;
      border-top: 2px solid var(--ink);
      border-right: 2px solid var(--ink);
    }
    .note {
      margin: 1.25rem 0;
      padding: 14px 16px 14px 18px;
      border: 1.5px solid var(--line-strong);
      border-left-width: 6px;
      border-radius: var(--radius);
      background: var(--white);
    }

    .note-title {
      display: block;
      margin-bottom: .25rem;
      color: var(--ink);
      font-weight: 800;
    }

    .note-warn {
      border-left-color: var(--yellow);
      background: var(--paper-amber);
    }

    .note-refused { border-left-color: var(--danger); background: var(--paper-amber); }
    .note-ok { border-left-color: var(--green-ink); background: var(--paper-green); }
    .supporting-text { color: var(--muted); font-size: .9rem; }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 8px 14px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: var(--white);
      color: var(--ink);
      font: inherit;
      font-size: .9rem;
      font-weight: 750;
      line-height: 1.3;
      text-decoration: none;
      cursor: pointer;
    }
    .btn-primary { background: var(--blue); color: var(--white); }
    .btn-quiet { border-color: transparent; background: transparent; text-decoration: underline; }
    .btn-danger { background: var(--paper-amber); color: var(--danger); }
    .btn:hover:not(:disabled) { box-shadow: 2px 2px 0 var(--ink); }
    /* A quiet button has no frame to lift, so it hovers with a light blue tint, translucent so it still shows on tinted notes. */
    .btn-quiet:hover:not(:disabled) { box-shadow: none; background: color-mix(in srgb, var(--blue) 10%, transparent); }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    code {
      padding: .12em .4em;
      border-radius: 5px;
      background: rgba(18, 17, 15, .06);
      font-family: var(--font-mono);
      font-size: .9em;
    }
    /* glyph-sm: the Patchy glyph at a floating element's title size, so the viewer knows Patchy is speaking. Use with glyph. */
    .glyph-sm { width: 18px; height: 18px; border-radius: 5px; box-shadow: 2px 2px 0 var(--ink); }
    .glyph-sm::after { top: 3px; right: 3px; width: 5px; height: 5px; }
    /* note-float: a note floating over the served frame; the ink border and hard shadow mark it first-party. */
    .note-float {
      margin: 0;
      padding: 12px 14px;
      border-width: 2px 2px 2px 6px;
      border-top-color: var(--ink);
      border-right-color: var(--ink);
      border-bottom-color: var(--ink);
      box-shadow: var(--shadow-hard);
      font-size: .9rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .note-float .note-title { display: flex; align-items: center; gap: 8px; }
    .note-float p { margin: 0; }
    .note-float p + p { margin-top: 6px; }
    /* note-info: Patchy offers something, such as a new version. */
    .note-info { border-left-color: var(--blue); background: var(--paper-blue); }
    /* status-chip: one line over the frame. Passive (reconnecting) it has no action; a folded note keeps one action and its paper. */
    .status-chip {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
      max-width: 100%;
      min-height: 36px;
      padding: 5px 14px 5px 8px;
      border: 2px solid var(--ink);
      border-radius: var(--radius-pill);
      background: var(--white);
      box-shadow: var(--shadow-hard);
      color: var(--ink);
      font-size: .85rem;
      font-weight: 750;
      line-height: 1.2;
    }
    .status-chip-detail { color: var(--muted); font-weight: 500; }
    .status-chip:has(.btn) { padding: 3px 3px 3px 10px; border-radius: var(--radius); }
    .status-chip .btn { margin-left: 6px; }
    .status-chip-warn { background: var(--paper-amber); }
    .status-chip-info { background: var(--paper-blue); }
    /* note-collapse: the quiet Hide that folds a note-float into a status-chip without dismissing it. Negative margins keep the
       44px target without growing the row; in a note-inline bar it takes the top-right cell, level with the title. */
    .note-float .note-collapse { flex: none; margin: -12px -10px -12px auto; padding-inline: 10px; white-space: nowrap; }
    .note-inline > .note-collapse { grid-area: 1 / -2; align-self: start; }
    /* shell-bottom: bottom-centre stack for the served page's state. It grows upward, so the bar at the edge stays put. */
    .shell-bottom {
      position: fixed;
      right: 16px;
      bottom: 16px;
      left: 16px;
      z-index: 2;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      pointer-events: none;
      color: var(--ink-soft);
      font-family: var(--font-sans);
    }
    .shell-bottom, .shell-bottom * { box-sizing: border-box; }
    .shell-bottom > * { pointer-events: auto; }
    .shell-bottom [hidden] { display: none; }
    /* shell-corner: D-1 downloads, bottom right, apart from the bottom-centre page state. Newest card on top; the stack grows
       upward, so cards already up stay put. The end padding keeps the hard shadow inside the scroll box. */
    .shell-corner {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 3;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
      width: min(340px, calc(100% - 32px));
      max-height: calc(100dvh - 32px);
      overflow-y: auto;
      padding: 0 4px 4px 0;
      color: var(--ink-soft);
      font-family: var(--font-sans);
    }
    .shell-corner, .shell-corner * { box-sizing: border-box; }
    .shell-corner [hidden], .shell-corner[hidden] { display: none; }
    .shell-downloads { display: flex; flex-direction: column; gap: 10px; width: 100%; }
    .shell-corner .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .shell-corner details { width: 100%; }
    .shell-corner details > .shell-downloads { margin-top: 10px; }
    /* "N more files": older cards fold into a status-chip; a static chevron flips when open. */
    .shell-corner summary { display: flex; width: fit-content; min-height: 44px; margin-left: auto; cursor: pointer; list-style: none; }
    .shell-corner summary::-webkit-details-marker { display: none; }
    .shell-corner summary::after {
      content: "";
      width: 6px;
      height: 6px;
      margin: -3px 2px 0 4px;
      border-right: 2px solid var(--ink);
      border-bottom: 2px solid var(--ink);
      transform: rotate(45deg);
    }
    .shell-corner details[open] > summary::after { margin-top: 3px; transform: rotate(-135deg); }
    /* The 481-1364px band: a 620px page-state bar centred at the bottom can reach the corner, so while page state is up
       the downloads stack above it. --patchy-status-offset is the top of the page state, measured by the shell. */
    @media (min-width: 481px) and (max-width: 1364px) {
      body:has(.shell-bottom > :not([hidden])) .shell-corner {
        bottom: calc(var(--patchy-status-offset, 0px) + 10px);
        max-height: calc(100dvh - 26px - var(--patchy-status-offset, 0px));
      }
    }
    /* shell-scrim: the T-1 cover. A static dim over the whole frame with one centred note-float; nothing moves or fades.
       It is a modal dialog, so the dim is the dialog itself and the top-layer backdrop stays clear. */
    .shell-scrim {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      max-width: none;
      max-height: none;
      margin: 0;
      padding: 16px;
      border: 0;
      background: rgba(18, 17, 15, .38);
      color: var(--ink-soft);
      font-family: var(--font-sans);
    }
    .shell-scrim[open] { display: grid; place-items: center; }
    .shell-scrim, .shell-scrim * { box-sizing: border-box; }
    .shell-scrim::backdrop { background: transparent; }
    .shell-scrim [hidden] { display: none; }
    .shell-scrim > .note-float { width: min(420px, 100%); }
    /* The elapsed line follows the note's live region rather than a p, so it takes the note's paragraph gap here. */
    .shell-scrim .supporting-text { margin-top: 6px; }
    .shell-scrim .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .shell-scrim .actions:has(> [hidden]) { display: none; }
    /* note-inline: a note-float laid out as one row (text, actions, then any Hide) for the bottom-centre bar. */
    .note-inline { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px 16px; max-width: 620px; }
    .note-inline:has(> .note-collapse) { grid-template-columns: minmax(0, 1fr) auto auto; }
    .note-inline .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; }
    /* Under 480px the bar becomes a full-width bottom sheet with its actions on a second row; chips stay centred pills above it. */
    @media (max-width: 480px) {
      .note-inline { grid-template-columns: minmax(0, 1fr); }
      .note-inline:has(> .note-collapse) { grid-template-columns: minmax(0, 1fr) auto; }
      .note-inline .actions { grid-column: 1 / -1; }
      .shell-bottom > .note-float {
        align-self: stretch;
        max-width: none;
        margin: 0 -16px -16px;
        border-radius: var(--radius) var(--radius) 0 0;
        box-shadow: none;
      }
      /* Downloads become bottom sheets too, stacked above the page state while it is up. */
      .shell-corner { right: 0; bottom: 0; width: 100%; max-height: calc(100dvh - 16px); gap: 8px; padding: 0; }
      body:has(.shell-bottom > :not([hidden])) .shell-corner {
        bottom: calc(var(--patchy-status-offset, 0px) + 8px);
        max-height: calc(100dvh - 24px - var(--patchy-status-offset, 0px));
      }
      .shell-downloads { gap: 8px; }
      .shell-corner details > .shell-downloads { margin-top: 8px; }
      .shell-corner summary { margin-right: auto; }
      .shell-corner .note-float { border-radius: var(--radius) var(--radius) 0 0; box-shadow: none; }
    }
`;

/**
 * The sidebar's places, in order. Every role sees the same map: what a member can't change is
 * read-only on its page, never missing here. The second group's label names the scope its places
 * share; the company's name rides on the brand above.
 */
const places = [
  {
    label: undefined,
    items: [
      { href: "/", label: "Home", section: "home" },
      { href: "/patches", label: "All patches", section: "patches" },
      { href: "/machines", label: "Your agents", section: "agents" }
    ]
  },
  {
    label: "Company",
    items: [
      { href: "/company", label: "People", section: "people" },
      { href: "/company/connections", label: "Integrations", section: "integrations" },
      { href: "/company/agent-access", label: "Agent access", section: "agent-access" }
    ]
  }
] as const;

export interface AppShell {
  readonly viewer: {
    readonly user: { readonly name: string; readonly email: string };
    readonly company: { readonly name: string };
    /** The newest What's new release the person has seen. */
    readonly whatsNewSeen: number;
    /** One line naming what their last form did, shown once at the top of the page. */
    readonly receipt?: string | undefined;
  };
  /** The place the page belongs to; `whats-new` is reached from its own button, so no place is lit there. */
  readonly section: (typeof places)[number]["items"][number]["section"] | "whats-new";
  /**
   * A modal panel over the page, such as Home’s Final step: the frame behind it goes inert
   * and blurs, and the panel carries its own role, label and ways out.
   */
  readonly overlay?: string;
  /** The sidebar search's query, when the page shows its results, so the field keeps it. */
  readonly query?: string;
}

/** A change's kind as a pill: New green, Improved blue, Fixed plain. */
export const whatsNewKind = (kind: ChangeKind): string =>
  `<span class="pill${kind === "New" ? " pill-done" : kind === "Improved" ? " pill-progress" : ""}">${kind}</span>`;

const plural = (count: number) => `${count} ${count === 1 ? "change" : "changes"}`;

/**
 * What's new, at the foot of the sidebar, opens a panel of what shipped since the viewer's last
 * visit, or the latest few once they are caught up. Opening it clears the dot through
 * `/whats-new/seen`; the page loads that script only while there is a dot to clear.
 */
function whatsNewButton(seen: number, current: boolean): string {
  const unseen = changesSince(seen);
  const shown = unseen.length > 0 ? unseen.slice(0, 6) : changesSince(0).slice(0, 3);
  const label =
    unseen.length > 0 ? `What’s new: ${plural(unseen.length)} since your last visit` : "What’s new";
  const summary =
    unseen.length > 0
      ? `${plural(unseen.length)} since your last visit · ${tally(unseen)}`
      : "You’re all caught up. The latest:";
  const list = shown.length
    ? `<ul class="list list-compact">${shown.map((change) => `<li class="list-row whats-new-change">${whatsNewKind(change.kind)}<span>${escapeHtml(change.title)}</span></li>`).join("")}</ul>`
    : "";
  const more =
    unseen.length > shown.length
      ? `<p class="supporting-text">and ${unseen.length - shown.length} more</p>`
      : "";
  return `<button type="button" class="app-place whats-new-bell" popovertarget="whats-new" aria-label="${label}"${current ? ' aria-current="page"' : ""}>What’s new${unseen.length > 0 ? '<span class="whats-new-dot"></span>' : ""}</button><div id="whats-new" class="whats-new-panel" popover role="dialog" aria-labelledby="whats-new-heading" data-through="${latestRelease}"><h2 class="section-heading" id="whats-new-heading">What’s new</h2><p class="supporting-text">${summary}</p>${list}${more}<a class="btn btn-primary" href="/whats-new">See all changes</a></div>${unseen.length > 0 ? '<script defer src="/whats-new/bell.js"></script>' : ""}`;
}

const chevron =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const menuIcon =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke-linecap="round"/></svg>';

/** The signed-in person: their name opens a menu with who they are and Sign out. */
function account(user: AppShell["viewer"]["user"]): string {
  return `<button type="button" class="app-place app-account" popovertarget="account-menu">${avatar(user.email, user.name)}<span class="app-account-name">${escapeHtml(user.name)}</span>${chevron}</button><div class="menu app-account-menu" id="account-menu" popover aria-label="Account"><p class="menu-head"><strong>${escapeHtml(user.name)}</strong><br>${escapeHtml(user.email)}</p><hr class="menu-rule"><form method="post" action="/logout"><button class="menu-item" type="submit">Sign out</button></form></div>`;
}

/**
 * Every signed-in page's frame: a sidebar of `places` beside the page. On a phone the sidebar
 * folds into a bar whose Menu button opens the same markup as a popover, so there is one nav and
 * no script. A page's `overlay` sits over the whole frame, which goes inert behind it.
 */
function appBody(app: AppShell, body: string): string {
  const place = (item: (typeof places)[number]["items"][number]) =>
    `<a class="app-place" href="${item.href}"${item.section === app.section ? ' aria-current="page"' : ""}>${item.label}</a>`;
  const nav = places
    .map((group) =>
      group.label === undefined
        ? group.items.map(place).join("")
        : `<div class="app-group" role="group" aria-labelledby="app-group-${group.label.toLowerCase()}"><p class="app-group-label" id="app-group-${group.label.toLowerCase()}">${group.label}</p>${group.items.map(place).join("")}</div>`
    )
    .join("");
  const search = searchField({
    action: "/",
    id: "app-search",
    query: app.query ?? "",
    placeholder: "Search patches",
    label: "Search patches",
    className: "app-search"
  });
  return `<div class="app"${app.overlay === undefined ? "" : " inert"}><aside class="app-side"><div class="app-side-inner"><a class="brand" href="/"><span class="glyph" aria-hidden="true"></span><span>${escapeHtml(app.viewer.company.name)}</span></a><button type="button" class="btn btn-quiet app-menu-button" popovertarget="app-menu">${menuIcon}Menu</button><div class="app-menu" id="app-menu" popover>${search}<nav class="app-nav" aria-label="Primary">${nav}</nav><div class="app-foot">${whatsNewButton(app.viewer.whatsNewSeen, app.section === "whats-new")}${account(app.viewer.user)}</div></div></div></aside><main class="app-page">${app.viewer.receipt === undefined ? "" : `<p class="note note-ok app-receipt" role="status">${escapeHtml(app.viewer.receipt)}</p>`}${body}</main></div>${app.overlay === undefined ? "" : `<div class="modal-scrim"></div>${app.overlay}`}`;
}

/**
 * Patchy's mark from patchyhq.com, the one icon on every first-party page and patch tab. It is
 * inline, so it needs no route and passes every one of those pages' `img-src data:`.
 */
export const faviconLink = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect x="114" y="110" width="286" height="286" rx="82" fill="#15130F" transform="rotate(-6 257 253) translate(22 22)"/><rect x="114" y="110" width="286" height="286" rx="82" fill="#91DD5A" stroke="#15130F" stroke-width="30" transform="rotate(-6 257 253)"/><path d="M256 180H326V250" fill="none" stroke="#15130F" stroke-width="30" stroke-linecap="round" stroke-linejoin="round" transform="rotate(-6 291 215)"/></svg>'
)}">`;

/**
 * A document as a `srcdoc` frame receives it, led by the frame's own base URL so its same-page
 * links (`href="#totals"`) scroll instead of loading the embedding page into the frame.
 *
 * A srcdoc document's URL is `about:srcdoc`, but without a base of its own its relative URLs
 * resolve against the embedder's: `#totals` names the embedding page. Against this base it names
 * the framed document, so following it is a scroll, with no request. Any other relative URL stops
 * resolving; absolute URLs are unaffected. A srcdoc document inherits its embedder's CSP, which
 * must admit this base with `base-uri about:`.
 *
 * The base leads everything, doctype included: the first base with an `href` is the one that
 * counts, so nothing in the page can displace it. A srcdoc document never renders in quirks mode,
 * so the doctype it displaces changes nothing. Its one casualty is the attributes of the page's own
 * `<head>` tag, which the parser drops once the base has implied a head. A leading byte order mark
 * goes first: behind the base it would be text and end the head early.
 */
export const framedDocument = (html: string): string =>
  `<base href="about:srcdoc">${html.replace(/^\uFEFF/, "")}`;

/** First-party HTML shell. Served patch documents remain separate in Serving. */
export function htmlPage(options: {
  title: string;
  body: string;
  head?: string;
  styles?: string;
  app?: AppShell;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.title)}</title>
  ${faviconLink}
  ${options.head ?? ""}
  <style>
    ${shellStyles}

    * {
      box-sizing: border-box;
    }

    html {
      background: var(--paper-blue);
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      background:
        linear-gradient(rgba(18, 17, 15, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(18, 17, 15, .035) 1px, transparent 1px),
        linear-gradient(180deg, var(--paper-blue) 0%, var(--paper) 34%, var(--paper-green) 78%, #fef7ef 100%);
      background-size: 32px 32px, 32px 32px, auto;
      color: var(--ink-soft);
      font-family: var(--font-sans);
      font-size: 17px;
      font-weight: 450;
      line-height: 1.65;
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
    }

    ::selection {
      background: rgba(255, 191, 53, .6);
      color: var(--ink);
    }


    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-size: 1.05rem;
      font-weight: 900;
      text-decoration: none;
    }


    .pill {
      display: inline-flex;
      align-items: center;
      border: 2px solid var(--ink);
      border-radius: var(--radius-pill);
      color: var(--ink);
      font-weight: 850;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: 0;
      white-space: nowrap;
    }

    .pill {
      gap: 6px;
      min-height: 28px;
      padding: 3px 11px;
      font-size: .76rem;
    }

    .pill::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: currentColor;
    }

    .pill-progress {
      background: var(--paper-blue);
      color: var(--blue-dark);
    }

    .pill-done {
      background: var(--paper-green);
      color: var(--green-ink);
    }

    /* pill-failed: failed and refused outcomes, danger ink on amber like btn-danger. */
    .pill-failed {
      background: var(--paper-amber);
      color: var(--danger);
    }

    h1,
    h2,
    h3 {
      margin: 0 0 .5em;
      color: var(--ink);
      font-weight: 850;
      line-height: 1.04;
      letter-spacing: 0;
      text-wrap: balance;
    }

    h1 {
      max-width: 12ch;
      font-size: 3.35rem;
      font-weight: 900;
      line-height: .98;
    }

    h2 {
      margin: 0;
      font-size: 1.6rem;
    }

    h3 {
      margin-top: 1.6rem;
      font-size: 1.2rem;
    }

    p {
      max-width: 70ch;
      margin: 0 0 1rem;
    }

    a {
      color: var(--blue-dark);
      font-weight: 750;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    pre {
      font-family: var(--font-mono);
    }

    pre {
      margin: 0;
      padding: 16px 18px;
      overflow-x: auto;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: #fffdf7;
      box-shadow: var(--shadow-hard);
      color: var(--ink);
      font-size: .88rem;
      line-height: 1.55;
    }

    pre code {
      padding: 0;
      background: none;
      font-size: inherit;
    }

    .lede {
      max-width: 64ch;
      color: var(--ink-soft);
      font-size: 1.08rem;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-top: .95rem;
      color: var(--muted);
      font-size: .92rem;
      font-weight: 650;
    }

    .panel {
      display: grid;
      grid-template-columns: minmax(0, .8fr) minmax(0, 1fr);
      gap: 20px;
      align-items: start;
      margin: 0 0 16px;
      padding: 22px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: var(--white);
      box-shadow: var(--shadow-hard);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin: 16px 0;
    }

    .task {
      padding: 20px 22px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: var(--white);
      box-shadow: var(--shadow-hard);
    }

    .task > h3 {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin: 0 0 .5rem;
    }

    .num {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      flex: none;
      border: 2px solid var(--ink);
      border-radius: 8px;
      background: var(--yellow);
      box-shadow: 2px 2px 0 var(--ink);
      color: var(--ink);
      font-size: .95rem;
      font-weight: 900;
      transform: rotate(-3deg);
    }


    .foot {
      color: var(--muted);
      font-size: .92rem;
      font-weight: 650;
    }

    body:has(.auth-card, .app) { min-height: 100vh; display: flow-root; }

    .auth-card {
      width: min(520px, calc(100% - 32px));
      margin: 64px auto;
      padding: 32px;
      border: 2px solid var(--ink);
      border-radius: var(--radius);
      background: var(--white);
      box-shadow: var(--shadow-hard);
      overflow-wrap: anywhere;
    }

    .auth-card .brand { margin-bottom: 32px; }
    .auth-kicker { margin: 0 0 16px; color: var(--muted); font-size: .8rem; font-weight: 750; text-transform: uppercase; letter-spacing: .12em; }
    .page-heading { max-width: none; margin-bottom: .6rem; font-size: 2.2rem; line-height: 1.12; overflow-wrap: anywhere; }
    .section-heading { margin: 0 0 12px; font-size: 1.2rem; line-height: 1.2; }
    .verification-code { max-width: none; font-family: var(--font-mono); font-size: clamp(1.65rem, 7vw, 3rem); letter-spacing: .04em; white-space: nowrap; }
    .field-label { display: block; margin: 18px 0 6px; font-size: .9rem; font-weight: 750; }
    .field {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: 44px;
      padding: 9px 12px;
      border: 1.5px solid var(--ink);
      border-radius: var(--field-radius);
      background: var(--white);
      color: var(--ink);
      font: inherit;
      font-size: .95rem;
    }
    textarea.field { min-height: 110px; resize: vertical; }
    /* field-grow: a textarea that starts one line tall and grows with what is typed or pasted, such as a list of
       addresses. Where field-sizing is unsupported it stays one line and resizes by hand. */
    textarea.field-grow { min-height: 44px; max-height: 12rem; }
    @supports (field-sizing: content) { textarea.field-grow { field-sizing: content; resize: none; } }
    .field-hint { margin: 8px 0 20px; color: var(--muted); font-size: .85rem; }
    .field-error { margin: 8px 0 20px; color: var(--danger); font-size: .85rem; font-weight: 750; }
    .field[aria-invalid="true"] { border-color: var(--danger); }
    /* field-group: a fixed field-prefix, such as the address a handle opens, before the editable input. The group
       draws the field and its focus ring; the prefix is a second label, so clicking it focuses the input. A long
       prefix wraps rather than squeezing the input below a few characters. */
    .field-group { display: flex; align-items: stretch; padding-block: 0; cursor: text; }
    .field-group > input { flex: 1; min-width: 8ch; padding: 9px 0; border: 0; background: transparent; color: inherit; font: inherit; }
    .field-group > input:focus-visible { outline: none; }
    .field-group:has(> input:focus-visible) { outline: 3px solid var(--blue); outline-offset: 3px; }
    .field-group:has(> [aria-invalid="true"]) { border-color: var(--danger); }
    /* field-search: searchField's group, its prefix the search icon rather than text, so it keeps a gap. */
    .field-search > .field-prefix { margin-right: 8px; }
    .field-prefix { flex: 0 1 auto; align-self: center; min-width: 0; padding-block: 6px; color: var(--muted); font-family: var(--font-mono); font-size: .85rem; overflow-wrap: anywhere; cursor: text; }
    /* field-rule: a hint stating its field's rule, which turns into the warning while the value breaks the field's
       own constraints (pattern, length, required). CSS only; Patchy names the exact problem on submit. */
    .field:is(:invalid, :has(:invalid)):has(+ .field-rule) { border-color: var(--danger); }
    .field:is(:invalid, :has(:invalid)) + .field-rule { color: var(--danger); font-weight: 750; }
    /* field-callout: a refusal attached under its field after a submit, in place of the hint. Compose with note
       note-refused and role="alert"; the field carries aria-invalid and aria-describedby pointing at it. */
    .field-callout { position: relative; margin: 14px 0 20px; font-size: .9rem; }
    .field-callout::before { content: ""; position: absolute; top: -9px; left: 22px; width: 14px; height: 14px; border-top: 1.5px solid var(--line-strong); border-left: 1.5px solid var(--line-strong); background: var(--paper-amber); transform: rotate(45deg); }
    .field-callout .note-title { display: flex; align-items: center; gap: 8px; }
    .field-callout .note-title::before { content: "!"; content: "!" / ""; display: inline-flex; align-items: center; justify-content: center; flex: none; width: 20px; height: 20px; border: 2px solid var(--ink); border-radius: 6px; background: var(--yellow); box-shadow: 2px 2px 0 var(--ink); font-size: .75rem; font-weight: 900; }
    .field-choice, .confirmation-acknowledgement { display: flex; align-items: baseline; gap: 10px; min-height: 44px; padding: 8px 0; cursor: pointer; }
    .field-checkbox, .field-radio { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--blue); cursor: pointer; }
    .field:disabled, .field-checkbox:disabled, .field-radio:disabled { opacity: .55; cursor: not-allowed; }
    .auth-email { font-weight: 750; overflow-wrap: anywhere; }
    .auth-signout { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line-strong); }
    .section { margin-top: 32px; }
    .list, .confirmation-list { list-style: none; padding: 0; margin: 16px 0; }
    .list-row, .confirmation-list > li { padding: 20px 0; border-bottom: 1px solid var(--line-strong); overflow-wrap: anywhere; }
    .list-row p { margin: 0 0 8px; }
    .list-row summary { margin: 12px 0; cursor: pointer; }
    .list-compact .list-row { padding: 4px 0; border-bottom: 0; }
    /* list-tree: a row's children indented under a left rule, such as the steps inside a log entry. Use with list list-compact. */
    .list-tree { margin: 8px 0 12px 6px; padding-left: 16px; border-left: 1px solid var(--line-strong); }
    .list-link { display: block; min-height: 44px; padding: 8px 10px; border: 2px solid transparent; border-radius: var(--field-radius); color: var(--ink); text-decoration: none; }
    .list-link:hover { background: var(--paper-blue); }
    .list-link[aria-current="page"] { background: color-mix(in srgb, var(--yellow) 45%, var(--white)); }
    /* list-link-placeholder: a row standing in for something not made yet, such as the portal's "Your first patch". */
    .list-link-placeholder { border: 2px dashed var(--line-strong); }
    .list-link-placeholder:not([aria-current="page"]) { color: var(--muted); }
    .table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: .9rem; overflow-wrap: anywhere; }
    .table th, .table td { padding: 10px 8px; border-bottom: 1px solid var(--line-strong); text-align: left; vertical-align: top; }
    .table th { color: var(--muted); font-weight: 750; }
    /* An expandable table row: a table-expand row after its entry holds one full-width cell with a details. The entry
       gives up its rule so the pair reads as one row, and the summary takes the list-row summary's pointer. */
    .table tr:has(+ .table-expand) > * { border-bottom: 0; }
    .table-expand > td { padding-top: 0; }
    .table-expand summary { margin: 0 0 8px; cursor: pointer; }
    /* avatar: a person's initials beside their name, so a list of people scans by face. avatar-green and avatar-amber
       vary the tint; avatar-waiting dashes an invitation with no person yet; avatar-off mutes a deactivated user. */
    .avatar { display: inline-grid; place-items: center; flex: none; width: 36px; height: 36px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--paper-blue); color: var(--ink); font-size: .74rem; font-weight: 850; letter-spacing: .03em; line-height: 1; }
    .avatar-green { background: var(--paper-green); }
    .avatar-amber { background: var(--paper-amber); }
    .avatar-waiting { border-style: dashed; border-color: var(--line-strong); background: transparent; color: var(--muted); }
    .avatar-off { border-color: var(--line-strong); background: transparent; color: var(--muted); }
    /* agent-mark: an agent beside its name, as an avatar sits beside a person's: the guide's agent icon in an avatar's frame. */
    .agent-mark { display: inline-grid; place-items: center; flex: none; width: 36px; height: 36px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--paper-blue); color: var(--ink); }
    .agent-mark svg { width: 20px; height: 20px; }
    /* consent-strip: who meets whom when an agent asks to act as a person: the agent's mark, name and site, the
       consent-strip-ask, then the person's avatar, name and email, each in a consent-strip-party. */
    .consent-strip { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin: 0 0 18px; padding: 12px 14px; border: 1.5px solid var(--line-strong); border-radius: var(--radius); background: var(--paper); }
    .consent-strip-party { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .consent-strip-party > div { min-width: 0; line-height: 1.35; }
    .consent-strip-ask { margin-left: 46px; color: var(--muted); font-size: .8rem; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    /* can-list: what something will and won't be able to do, such as an agent at consent. A can-head names each
       list list-compact; can-list-yes ticks its rows and can-list-no crosses them, the marks hidden from readers. */
    .can-head { margin: 14px 0 0; font-weight: 750; }
    .can-head + .can-list { margin-top: 6px; }
    .can-list .list-row { display: flex; gap: 10px; align-items: baseline; }
    .can-list .list-row::before { flex: none; font-weight: 850; }
    .can-list-yes .list-row::before { content: "✓"; content: "✓" / ""; color: var(--green-ink); }
    .can-list-no .list-row::before { content: "✕"; content: "✕" / ""; color: var(--danger); }
    /* mono: a tool's two-letter mark, tinted from its name and turned like the glyph; mono-blue, mono-green and
       mono-amber vary the tint. page-mark: a page's ruled sheet in the same footprint. */
    .mono { display: inline-grid; place-items: center; flex: none; width: 34px; height: 34px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--yellow); color: var(--ink); font-size: .72rem; font-weight: 900; letter-spacing: .02em; line-height: 1; transform: rotate(-3deg); }
    .mono-blue { background: var(--tint-blue); }
    .mono-green { background: var(--tint-green); }
    .mono-amber { background: var(--tint-amber); }
    .mono-pink { background: var(--tint-pink); }
    /* mono-lg and page-mark-lg: the mark at a page heading's size, as on a patch's card. */
    .mono-lg { width: 56px; height: 56px; border-radius: 14px; box-shadow: 3px 3px 0 var(--ink); font-size: 1.05rem; }
    .page-mark { position: relative; flex: none; width: 26px; height: 32px; margin-inline: 4px; border: 2px solid var(--ink); border-radius: 3px 9px 3px 3px; background: var(--white); }
    .mono-placeholder { border-style: dashed; border-color: var(--line-strong); background: transparent; box-shadow: none; color: var(--muted); font-size: 1.1rem; transform: none; }
    /* tile: one patch someone already knows, with its mark, name and why it is here; the corner button opens its menu.
       tile-row is the compact form for a longer shelf, with a line of what the patch does; tile-row-placeholder dashes
       one standing in for something to make. */
    .tile { position: relative; min-width: 0; }
    .tile-link { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; height: 100%; padding: 16px 16px 14px; border: 1.5px solid var(--line-strong); border-radius: var(--radius); background: var(--white); color: var(--ink-soft); font-weight: 450; text-decoration: none; }
    .tile-link:hover { border-color: var(--ink); background: var(--paper-blue); }
    .tile-link > :is(.mono, .page-mark) { margin-bottom: 10px; }
    /* A tile's mark is a size up from a row's, a page's sheet in the same footprint. */
    .tile-link > .mono { width: 44px; height: 44px; border-radius: 10px; font-size: .85rem; }
    .tile-link > .page-mark { width: 34px; height: 44px; margin-inline: 5px; }
    .tile > .btn-icon { position: absolute; top: 6px; right: 6px; }
    .tile-name { color: var(--ink); font-weight: 850; line-height: 1.25; overflow-wrap: anywhere; }
    .tile-text { font-size: .85rem; line-height: 1.4; }
    .tile-meta { margin-top: auto; padding-top: 6px; color: var(--muted); font-size: .8rem; font-weight: 650; }
    .tile-row { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 60px; padding: 10px 12px; border: 1.5px solid var(--line-strong); border-radius: var(--radius); background: var(--white); color: var(--ink-soft); font-weight: 450; text-decoration: none; }
    .tile-row:hover { border-color: var(--ink); background: var(--paper-blue); }
    .tile-body { display: grid; flex: 1; gap: 1px; min-width: 0; }
    .tile-row .tile-text { overflow: hidden; color: var(--muted); font-size: .8rem; white-space: nowrap; text-overflow: ellipsis; }
    .tile-row .tile-meta { margin: 0; padding: 0; font-size: .75rem; }
    .tile-row > .whats-new-dot { position: static; align-self: start; margin-top: 6px; }
    .tile-row-placeholder { border: 2px dashed var(--line-strong); background: transparent; }
    /* tile-row-plain: a row in a list rather than a shelf of cards, so it has no frame until hovered, and its text wraps. */
    .tile-row-plain { min-height: 0; padding: 8px; border-color: transparent; background: transparent; }
    .tile-row-plain .tile-text { white-space: normal; }
    /* side-panel: a framed column beside a page's main content, such as Home's Pages. */
    .side-panel { min-width: 0; padding: 18px 18px 8px; border: 1.5px solid var(--line-strong); border-radius: var(--radius); background: var(--white); }
    /* card-split: a page's main column with a side-panel to its right, such as what agents can do beside a patch's
       card, or the how-to beside a connect form. On a narrow page the panel drops below. */
    .card-split { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 32px 28px; align-items: start; }
    @media (max-width: 960px) {
      .card-split { grid-template-columns: minmax(0, 1fr); }
    }
    /* form-step: one numbered part of a one-page form, a fieldset whose legend is a form-step-title led by its
       form-step-number. While disabled, such as before an earlier part is done, its words dim; its controls dim
       themselves as disabled controls do. */
    .form-step { min-width: 0; margin: 28px 0 0; padding: 0; border: 0; }
    .form-step-title { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; padding: 0; color: var(--ink); font-size: 1.15rem; font-weight: 850; line-height: 1.2; }
    .form-step-number { display: inline-grid; place-items: center; flex: none; width: 26px; height: 26px; border: 2px solid var(--ink); border-radius: 50%; background: var(--yellow); color: var(--ink); font-size: .8rem; font-weight: 900; }
    .form-step:disabled :is(.form-step-title, .field-label, .field-hint, .supporting-text) { opacity: .5; }
    .field-group:has(> input:disabled) { opacity: .55; cursor: not-allowed; }
    /* tile-option: a tile-row that is one choice of a radio group, its native radio kept for keyboard and screen
       readers but drawn as the row: checked fills pale yellow with a strong frame, as a current list-link fills,
       and disabled mutes, such as an address that can't be picked. tile-row-placeholder dashes one standing in for
       something to make. */
    .tile-options { display: grid; gap: 10px; margin: 12px 0 0; }
    .tile-option { position: relative; cursor: pointer; }
    .tile-option > input, .choice-card > input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
    .tile-option:has(> input:checked) { border-color: var(--ink); background: color-mix(in srgb, var(--yellow) 45%, var(--white)); color: var(--ink); }
    .tile-option:has(> input:checked) .tile-text { color: var(--ink-soft); }
    .tile-option:has(> input:focus-visible), .choice-card:has(> input:focus-visible) { outline: 3px solid var(--blue); outline-offset: 3px; }
    .tile-option:has(> input:disabled), .choice-card:has(> input:disabled) { opacity: .5; cursor: not-allowed; }
    .tile-option:has(> input:disabled):hover { border-color: var(--line-strong); background: var(--white); }
    .tile-row-placeholder.tile-option:has(> input:disabled):hover { background: transparent; }
    /* choice-card: one choice of a radio group as a card, a choice-card-title over its choice-card-point lines;
       choice-cards lays a group side by side, one under another on a narrow page. Checked and disabled read as a
       tile-option's do. */
    .choice-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 12px 0 0; }
    .choice-card { position: relative; display: block; padding: 14px 16px; border: 1.5px solid var(--line-strong); border-radius: var(--radius); background: var(--white); color: var(--ink-soft); cursor: pointer; }
    .choice-card:hover { border-color: var(--ink); background: var(--paper-blue); }
    .choice-card:has(> input:checked) { border-color: var(--ink); background: color-mix(in srgb, var(--yellow) 45%, var(--white)); }
    .choice-card:has(> input:disabled):hover { border-color: var(--line-strong); background: var(--white); }
    .choice-card-title { display: block; margin: 0 0 6px; color: var(--ink); font-size: 1.05rem; font-weight: 850; line-height: 1.25; }
    .choice-card-point { position: relative; display: block; padding-left: 16px; font-size: .9rem; line-height: 1.45; }
    .choice-card-point::before { content: "•"; content: "•" / ""; position: absolute; left: 2px; }
    /* shelf-label: a small capitalised label over a group inside a shelf or panel, such as New to you. */
    .shelf-label { margin: 14px 0 4px; color: var(--muted); font-size: .74rem; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
    mark { padding: 0 2px; border-radius: 3px; background: rgba(255, 191, 53, .6); color: var(--ink); }
    .page-mark::after { content: ""; position: absolute; inset: 7px 5px 6px; background: repeating-linear-gradient(transparent 0 4px, var(--line-strong) 4px 6px); }
    /* After the base rules, which would otherwise win at equal specificity. */
    .page-mark-lg { width: 44px; height: 54px; margin-inline: 6px; border-radius: 4px 14px 4px 4px; box-shadow: 3px 3px 0 var(--ink); }
    .page-mark-lg::after { inset: 12px 9px 10px; background: repeating-linear-gradient(transparent 0 6px, var(--line-strong) 6px 8px); }
    /* tag: a small label after a name, such as You. */
    .tag { display: inline-flex; align-items: center; min-height: 20px; margin-left: 6px; padding: 1px 7px; border: 1.5px solid var(--line-strong); border-radius: var(--radius-pill); color: var(--ink-soft); font-size: .7rem; font-weight: 800; letter-spacing: .04em; line-height: 1; text-transform: uppercase; vertical-align: 2px; }
    /* tag-new: something new to the viewer, in the brand's highlighter yellow. */
    .tag-new { border-color: var(--ink); background: var(--yellow); color: var(--ink); }
    /* tabs: links that narrow one list, the current one marked like the app nav, each label followed by its count. */
    .tabs { display: flex; flex-wrap: wrap; gap: 4px; }
    .tabs a { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 6px 12px; border: 0; border-radius: var(--field-radius); color: var(--ink); font-size: .9rem; font-weight: 750; text-decoration: none; }
    .tabs a:hover { background: var(--paper-blue); }
    .tabs a[aria-current="page"] { background: color-mix(in srgb, var(--yellow) 45%, var(--white)); }
    .count { color: var(--muted); font-weight: 650; font-variant-numeric: tabular-nums; }
    .tabs a[aria-current="page"] .count { color: var(--ink); }
    /* btn-icon: a square button holding one icon, named by its aria-label. */
    /* btn-quiet btn-danger: a destructive action kept out of the way, such as Disconnect everything: no frame, danger ink. */
    .btn-quiet.btn-danger { background: transparent; color: var(--danger); }
    .btn-icon { width: 44px; padding: 0; }
    .btn-icon svg { width: 18px; height: 18px; }
    .btn-quiet:has(+ .menu:popover-open) { background: color-mix(in srgb, var(--blue) 10%, transparent); }
    /* menu: a native popover of one row's actions, right after the button whose popovertarget opens it. Where the
       browser anchors a popover to its invoker the menu drops under the button; elsewhere it opens centred, so its
       menu-head names whose actions they are. Items are links or buttons in their own forms. */
    .menu { min-width: 220px; margin: auto; padding: 6px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); color: var(--ink); box-shadow: var(--shadow-hard); text-align: left; white-space: normal; }
    @supports (position-area: bottom) {
      .menu { inset: auto; margin: 6px 0; position-area: bottom span-left; position-try-fallbacks: flip-block; }
    }
    .menu form { margin: 0; }
    .menu-head { max-width: none; margin: 0; padding: 6px 12px 4px; color: var(--muted); font-size: .8rem; font-weight: 750; overflow-wrap: anywhere; }
    .menu-item { display: flex; align-items: center; width: 100%; min-height: 44px; padding: 8px 12px; border: 0; border-radius: var(--field-radius); background: transparent; color: var(--ink); font: inherit; font-size: .9rem; font-weight: 750; line-height: 1.3; text-align: left; text-decoration: none; cursor: pointer; }
    .menu-item:hover { background: var(--paper-blue); }
    .menu-item-danger { color: var(--danger); }
    /* A Copy item waits hidden for the page's copy script, so a menu without script offers only what works. */
    .menu-item[hidden] { display: none; }
    .menu-rule { margin: 4px 0; border: 0; border-top: 1px solid var(--line-strong); }
    .copy-address { user-select: all; overflow-wrap: anywhere; }
    .code-panel { max-height: 18rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    /* copy-line: one line to hand to an agent, selectable as a whole. Its Copy button starts hidden and the page's
       copy script reveals it, so a page without script still offers the selectable line. */
    .copy-line { display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 8px 8px 8px 16px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); }
    .copy-line > code { flex: 1; min-width: 0; padding: 0; background: none; color: var(--ink); font-size: .95rem; font-weight: 650; user-select: all; overflow-wrap: anywhere; }
    .copy-line > .btn { flex: none; }
    .copy-line > [hidden] { display: none; }
    /* agent-preview: an illustration of what an agent will say back, never a live transcript. */
    .agent-preview { padding: 14px 16px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--ink); box-shadow: 4px 4px 0 var(--yellow); color: #f4efe2; font-family: var(--font-mono); font-size: .8rem; line-height: 1.55; overflow-wrap: anywhere; }
    .agent-preview p { max-width: none; margin: 0; }
    .agent-preview p + p { margin-top: 8px; }
    .agent-preview strong { color: var(--yellow); }
    .agent-preview-you { color: var(--yellow); font-weight: 900; }
    .agent-preview-said { color: var(--green); }
    /* flow: boxes joined by arrows that say how something gets made. It stacks with down arrows where a row would crowd. */
    .flow { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 30px; margin: 22px 0 0; padding: 0; list-style: none; }
    .flow-node { position: relative; display: grid; align-content: start; justify-items: start; gap: 4px; padding: 12px; border: 1.5px solid var(--line-strong); border-radius: var(--radius); background: var(--white); color: var(--muted); font-size: .85rem; line-height: 1.35; }
    .flow-node strong { color: var(--ink); font-size: 1rem; line-height: 1.25; }
    .flow-node:not(:last-child)::after { content: "→"; position: absolute; top: 50%; right: -25px; color: var(--ink); font-size: 1.25rem; font-weight: 900; transform: translateY(-50%); }
    .flow-icon { display: grid; place-items: center; width: 40px; height: 40px; margin-bottom: 4px; border: 2px solid var(--ink); border-radius: 10px; background: var(--white); color: var(--ink); }
    .flow-icon svg { width: 22px; height: 22px; }
    .flow-icon-you { background: var(--yellow); transform: rotate(-4deg); }
    .flow-icon-agent { background: var(--paper-blue); transform: rotate(3deg); }
    .flow-icon-team { background: var(--paper-green); transform: rotate(-2deg); }
    .flow-icon-patchy { border-color: transparent; background: none; box-shadow: none; }
    @media (max-width: 1180px) {
      .flow { grid-template-columns: minmax(0, 1fr); gap: 22px; }
      .flow-node { grid-template-columns: auto minmax(0, 1fr); align-items: center; column-gap: 12px; }
      .flow-icon { grid-row: span 2; margin: 0; }
      .flow-node:not(:last-child)::after { content: "↓"; top: auto; right: auto; bottom: -24px; left: 28px; transform: none; }
    }
    /* steps: a numbered walk-through with one step open. A step-done or step-current step is lit; any other is still
       to come. Its step-marker holds the number or a check, and the open step's work sits in a step-card. */
    .steps { margin: 26px 0 0; padding: 0; list-style: none; }
    .step { position: relative; display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 0 18px; padding-bottom: 24px; color: var(--muted); }
    .step:last-child { padding-bottom: 0; }
    .step:not(:last-child)::before { content: ""; position: absolute; top: 48px; bottom: 4px; left: 21px; border-left: 2px dashed var(--line-strong); }
    .step-done:not(:last-child)::before { border-left: 2px solid var(--ink); }
    .step-marker { display: grid; place-items: center; width: 44px; height: 44px; border: 2px solid var(--line-strong); border-radius: 50%; background: var(--white); font-weight: 900; }
    .step-done .step-marker { border-color: var(--ink); background: var(--green); color: var(--ink); }
    .step-current .step-marker { border-color: var(--ink); background: var(--yellow); box-shadow: 3px 3px 0 var(--ink); color: var(--ink); }
    .step-title { margin: 8px 0 4px; color: var(--muted); font-size: 1.2rem; }
    .step-done, .step-current { color: var(--ink-soft); }
    .step-done .step-title, .step-current .step-title { color: var(--ink); }
    .step-title + p { margin: 0; }
    .step-card { margin-top: 12px; padding: 18px 20px; border: 1.5px solid var(--line-strong); border-radius: var(--radius); background: var(--paper); }
    .step-card > * { margin: 0; }
    .step-card > * + * { margin-top: 12px; }
    .step-card > * + .agent-preview { margin-top: 8px; }
    .step-card summary { color: var(--blue-dark); font-weight: 750; cursor: pointer; }
    .step-card details p { margin: 6px 0 0; }
    /* modal-panel: a panel over an app page, which is inert and statically blurred behind it, never animated. It has
       no close button: its own actions are the ways out. On a phone it is a bottom sheet. */
    .app[inert] { filter: blur(3px); user-select: none; }
    .modal-scrim { position: fixed; inset: 0; background: rgba(18, 17, 15, .32); }
    .modal-panel { position: fixed; top: 40px; left: 50%; width: min(640px, calc(100% - 32px)); max-height: calc(100dvh - 64px); overflow-y: auto; padding: 26px 28px 22px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); box-shadow: 6px 6px 0 var(--ink); transform: translateX(-50%); }
    .modal-panel .page-heading { margin-top: 0; }
    @media (max-width: 600px) {
      .modal-panel { top: auto; right: 0; bottom: 0; left: 0; width: auto; max-height: 88dvh; padding: 20px 18px 22px; border-radius: 16px 16px 0 0; box-shadow: 0 -4px 0 var(--ink); transform: none; }
    }
    @media (max-width: 480px) {
      .step { grid-template-columns: 36px minmax(0, 1fr); gap: 0 12px; }
      .step-marker { width: 36px; height: 36px; }
      .step:not(:last-child)::before { top: 40px; left: 17px; }
      .step-card { padding: 14px; }
      .copy-line { flex-wrap: wrap; padding: 10px 12px; }
      .copy-line > code { flex-basis: 100%; }
    }
    .actions, .confirmation-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
    .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 24px; margin: 20px 0; font-size: .9rem; overflow-wrap: anywhere; }
    .facts dt { color: var(--muted); font-weight: 750; }
    .facts dd { min-width: 0; margin: 0; }
    .confirmation-form { margin-top: 24px; }
    .confirmation-consequence { margin: 0 0 20px; }
    /* app: the signed-in frame, a sidebar of places beside the page. */
    .app { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
    .app-side { border-right: 1.5px solid var(--line-strong); background: var(--white); }
    /* The sidebar's column runs the page's full height; its contents stay in view as the page scrolls. */
    .app-side-inner { position: sticky; top: 0; display: flex; flex-direction: column; gap: 16px; height: 100vh; padding: 18px 14px 14px; overflow-y: auto; }
    .app-side-inner > .brand { padding: 2px 8px; font-size: 1rem; overflow-wrap: anywhere; }
    .app-side .glyph { width: 26px; height: 26px; }
    .app-menu-button { display: none; }
    /* app-menu: the search, places and foot. On a phone it is the Menu button's popover; wider, an author display
       outranks the browser's rule hiding a closed popover, so the same markup shows in place. */
    .app-menu { position: static; inset: auto; display: flex; flex: 1; flex-direction: column; gap: 16px; width: auto; height: auto; margin: 0; padding: 0; overflow: visible; border: 0; background: transparent; color: inherit; }
    .app-search .field { min-height: 40px; }
    .app-nav { display: grid; gap: 2px; }
    /* app-place: one place in the sidebar, lit while the page belongs to it. The foot's buttons share its look. */
    .app-place { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 6px 10px; border: 0; border-radius: var(--field-radius); background: transparent; color: var(--ink-soft); font: inherit; font-size: .92rem; font-weight: 650; text-align: left; text-decoration: none; cursor: pointer; }
    .app-place:hover { background: var(--paper-blue); color: var(--ink); }
    .app-place[aria-current="page"] { background: color-mix(in srgb, var(--yellow) 45%, var(--white)); color: var(--ink); font-weight: 800; }
    .app-group { display: grid; gap: 2px; margin-top: 14px; }
    .app-group-label { margin: 0 10px 4px; color: var(--muted); font-size: .72rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .app-foot { display: grid; gap: 2px; margin-top: auto; padding-top: 12px; border-top: 1px solid var(--line); }
    .app-account .avatar { width: 28px; height: 28px; border-width: 1.5px; border-radius: 50%; font-size: .66rem; }
    .app-account-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .app-account-menu .menu-head strong { color: var(--ink); }
    @supports (position-area: bottom) {
      .app-account-menu { position-area: top span-right; position-try-fallbacks: flip-block; }
    }
    .app-page { min-width: 0; max-width: 1240px; padding: 34px 44px 48px; overflow-wrap: anywhere; }
    /* app-receipt: what the person's last form did, once, above the page it landed on. */
    .app-receipt { margin: 0 0 20px; font-weight: 650; }
    /* A Menu opened on a phone stays open in the top layer if the window widens; it then sits where
       the in-place menu would, under the brand, until dismissed. */
    @media (min-width: 900px) {
      .app-menu:popover-open { position: fixed; inset: 64px auto 0 0; width: 248px; height: auto; padding: 0 14px 14px; overflow-y: auto; border: 0; border-right: 1.5px solid var(--line-strong); background: var(--white); }
      .app-menu::backdrop { background: transparent; }
    }
    @media (max-width: 899px) {
      .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: max-content minmax(0, 1fr); }
      .app-side { position: sticky; top: 0; z-index: 2; border-right: 0; border-bottom: 1.5px solid var(--line-strong); }
      .app-side-inner { position: static; flex-direction: row; align-items: center; justify-content: space-between; height: auto; padding: 10px 14px; overflow: visible; }
      .app-menu-button { display: inline-flex; gap: 6px; text-decoration: none; }
      .app-menu:not(:popover-open) { display: none; }
      /* The gutter left of the sheet is the backdrop a tap lands on to close it, even at 320px. */
      .app-menu:popover-open { position: fixed; inset: 0 0 0 auto; width: min(320px, calc(100vw - 48px)); height: 100dvh; padding: 18px 14px 14px; overflow-y: auto; border-left: 2px solid var(--ink); background: var(--white); }
      .app-menu::backdrop { background: rgba(18, 17, 15, .32); }
      .app-page { padding: 24px 18px 36px; }
    }
    /* What's new: the bell, its panel, and a change the viewer has not seen yet. */
    .whats-new-bell { anchor-name: --whats-new; }
    /* While its panel is open, What's new takes a current place's look. */
    .whats-new-bell:has(+ .whats-new-panel:popover-open) { background: color-mix(in srgb, var(--yellow) 45%, var(--white)); color: var(--ink); }
    .whats-new-dot { position: absolute; top: 8px; right: 8px; width: 10px; height: 10px; border: 2px solid var(--ink); border-radius: 50%; background: var(--blue); }
    .app-place > .whats-new-dot { position: static; width: 8px; height: 8px; margin-left: auto; border: 0; }
    .whats-new-panel { position: fixed; inset: auto auto 16px 16px; width: min(400px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: 0; padding: 18px 20px 20px; overflow-y: auto; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); color: var(--ink-soft); box-shadow: var(--shadow-hard); }
    @supports (position-area: bottom) {
      .whats-new-panel { inset: auto; margin: 0 0 0 8px; position-anchor: --whats-new; position-area: right span-top; position-try-fallbacks: flip-block; }
      @media (max-width: 899px) {
        .whats-new-panel { inset: auto 8px 8px 8px; width: auto; margin: 0; position-area: none; }
      }
    }
    .whats-new-panel > .supporting-text { margin: 0 0 4px; }
    .whats-new-panel .btn-primary { width: 100%; margin-top: 12px; }
    .whats-new-change { display: grid; grid-template-columns: 6.75rem minmax(0, 1fr); gap: 12px; align-items: start; }
    .list-row.whats-new-change { padding-block: 14px; }
    .whats-new-change > .pill { justify-self: start; }
    .whats-new-change p { margin: 0; }
    .whats-new-change p + p { margin-top: 4px; }
    .whats-new-change strong { color: var(--ink); }
    .whats-new-panel .whats-new-change { align-items: center; padding-block: 6px; color: var(--ink); font-weight: 650; line-height: 1.35; }
    .whats-new-unseen { margin-inline: -14px; padding-inline: 14px; background: var(--paper-blue); box-shadow: inset 4px 0 0 var(--blue); }
    .whats-new-day-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding-bottom: 10px; border-bottom: 2px solid var(--ink); }
    .whats-new-day-head .section-heading { margin: 0; }
    .whats-new-seen { display: flex; align-items: center; gap: 12px; max-width: none; margin: 32px 0 0; }
    li.whats-new-seen { margin: 18px 0; }
    .whats-new-seen::before, .whats-new-seen::after { content: ""; flex: 1; border-top: 1px solid var(--line-strong); }
    @media (max-width: 480px) {
      .whats-new-day .whats-new-change { grid-template-columns: minmax(0, 1fr); gap: 6px; }
      .auth-card { padding: 24px; }
      .facts { grid-template-columns: minmax(0, 1fr); gap: 4px; }
      .facts dd { margin-bottom: 8px; }
    }


    @media (max-width: 760px) {
      h1 {
        max-width: 13ch;
        font-size: 2.45rem;
      }

      .panel,
      .grid {
        grid-template-columns: 1fr;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      html {
        scroll-behavior: auto;
      }
    }
    ${options.styles ?? ""}
  </style>
</head>
<body>${options.app ? appBody(options.app, options.body) : options.body}</body>
</html>`;
}
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
export function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
/** "a, b and c", escaped, as when a page names a company's admins. */
export const sentenceList = (items: readonly string[]): string => {
  const escaped = items.map(escapeHtml);
  return escaped.length < 2
    ? escaped.join("")
    : `${escaped.slice(0, -1).join(", ")} and ${escaped.at(-1)}`;
};
