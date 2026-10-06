import { changesSince, type ChangeKind, latestRelease, tally } from "./whatsNew.js";

/** Shared component subset for first-party pages and the served document's state notices. */
export const shellStyles = `
    :root {
      --paper: #fffdf4;
      --paper-blue: #eaf5ff;
      --paper-green: #eff9e8;
      --paper-amber: #fff7e4;
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

export interface AppShell {
  readonly viewer: {
    readonly user: { readonly name: string };
    readonly company: { readonly name: string };
    /** The newest What's new release the person has seen. */
    readonly whatsNewSeen: number;
  };
  /** `whats-new` is reached from the bell, not a section link, so no link is current. */
  readonly section: "patches" | "company" | "connections" | "machines" | "whats-new";
}

/** A change's kind as a pill: New green, Improved blue, Fixed plain. */
export const whatsNewKind = (kind: ChangeKind): string =>
  `<span class="pill${kind === "New" ? " pill-done" : kind === "Improved" ? " pill-progress" : ""}">${kind}</span>`;

const plural = (count: number) => `${count} ${count === 1 ? "change" : "changes"}`;

/**
 * The bell beside the viewer's name opens a panel of what shipped since their last visit, or
 * the latest few once they are caught up. Opening it clears the dot through `/whats-new/seen`;
 * the page loads that script only while there is a dot to clear.
 */
function whatsNewBell(seen: number): string {
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
  return `<button type="button" class="btn btn-quiet whats-new-bell" popovertarget="whats-new" aria-label="${label}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" stroke-linejoin="round"/><path d="M10 21h4" stroke-linecap="round"/></svg>${unseen.length > 0 ? '<span class="whats-new-dot"></span>' : ""}</button><div id="whats-new" class="whats-new-panel" popover role="dialog" aria-labelledby="whats-new-heading" data-through="${latestRelease}"><h2 class="section-heading" id="whats-new-heading">What’s new</h2><p class="supporting-text">${summary}</p>${list}${more}<a class="btn btn-primary" href="/whats-new">See all changes</a></div>${unseen.length > 0 ? '<script defer src="/whats-new/bell.js"></script>' : ""}`;
}

function appBody(app: AppShell, body: string): string {
  const link = (href: string, label: string, section: AppShell["section"]) =>
    `<a href="${href}"${section === app.section ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<div class="app-card"><header class="app-bar"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div><nav class="app-nav" aria-label="Primary">${link("/", "Patches", "patches")}${link("/company", "Company", "company")}${link("/company/connections", "Connections", "connections")}${link("/machines", "Your machines", "machines")}</nav><div class="app-who">${whatsNewBell(app.viewer.whatsNewSeen)}<span>${escapeHtml(app.viewer.user.name)} · ${escapeHtml(app.viewer.company.name)}</span><form method="post" action="/logout"><button class="btn btn-quiet" type="submit">Sign out</button></form></div></header><main class="app-page">${body}</main></div>`;
}

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

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      opacity: .22;
      mix-blend-mode: multiply;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 160 160' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.95' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='.36'/%3E%3C/svg%3E");
    }

    ::selection {
      background: rgba(255, 191, 53, .6);
      color: var(--ink);
    }


    .wrap {
      width: min(980px, calc(100% - 40px));
      margin: 0 auto;
      padding: 42px 0 96px;
    }

    .wrap.compact {
      max-width: 760px;
    }

    .doc-head {
      margin-bottom: 2.5rem;
      padding-bottom: 1.5rem;
      border-bottom: 2px solid var(--line-strong);
    }

    .head-line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 18px 36px;
      margin-bottom: 2.5rem;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
      font-size: 1.05rem;
      font-weight: 900;
    }


    .kicker,
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

    .kicker {
      min-height: 30px;
      padding: 5px 18px;
      background: var(--yellow);
      box-shadow: 3px 3px 0 var(--ink);
      font-size: .78rem;
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

    body:has(.auth-card, .app-card) { min-height: 100vh; display: flow-root; }

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
    .list-link[aria-current="page"] { border-color: var(--ink); background: var(--yellow); box-shadow: 2px 2px 0 var(--ink); }
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
    .flow-node { position: relative; display: grid; align-content: start; justify-items: start; gap: 4px; padding: 12px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); box-shadow: 3px 3px 0 var(--ink); color: var(--muted); font-size: .85rem; line-height: 1.35; }
    .flow-node strong { color: var(--ink); font-size: 1rem; line-height: 1.25; }
    .flow-node:not(:last-child)::after { content: "→"; position: absolute; top: 50%; right: -25px; color: var(--ink); font-size: 1.25rem; font-weight: 900; transform: translateY(-50%); }
    .flow-icon { display: grid; place-items: center; width: 40px; height: 40px; margin-bottom: 4px; border: 2px solid var(--ink); border-radius: 10px; background: var(--white); box-shadow: 2px 2px 0 var(--ink); color: var(--ink); }
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
    .step p { margin: 0; }
    .step-card { margin-top: 12px; padding: 18px 20px; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--paper); box-shadow: var(--shadow-hard); }
    .step-card > * + * { margin-top: 12px; }
    .step-card summary { color: var(--blue-dark); font-weight: 750; cursor: pointer; }
    .step-card details p { margin-top: 6px; }
    .actions, .confirmation-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
    .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 24px; margin: 20px 0; font-size: .9rem; overflow-wrap: anywhere; }
    .facts dt { color: var(--muted); font-weight: 750; }
    .facts dd { min-width: 0; margin: 0; }
    .confirmation-form { margin-top: 24px; }
    .confirmation-consequence { margin: 0 0 20px; }
    .app-card { width: min(1180px, calc(100% - 32px)); margin: 32px auto; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); box-shadow: var(--shadow-hard); }
    .app-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 28px; padding: 14px 26px; border-bottom: 2px solid var(--ink); border-radius: var(--radius) var(--radius) 0 0; background: var(--white); }
    .app-nav { display: flex; flex-wrap: wrap; gap: 4px; }
    .app-nav a { display: inline-flex; align-items: center; min-height: 44px; padding: 6px 12px; border: 2px solid transparent; border-radius: var(--field-radius); color: var(--ink); text-decoration: none; font-size: .95rem; }
    .app-nav a[aria-current="page"] { border-color: var(--ink); background: var(--yellow); box-shadow: 2px 2px 0 var(--ink); }
    .app-who { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; color: var(--muted); font-size: .88rem; font-weight: 650; overflow-wrap: anywhere; }
    .app-page { min-width: 0; padding: 30px 34px 40px; overflow-wrap: anywhere; }
    /* What's new: the bell, its panel, and a change the viewer has not seen yet. */
    .whats-new-bell { position: relative; width: 44px; padding: 0; anchor-name: --whats-new; }
    /* While its panel is open, the bell takes the nav's current-section look. */
    .whats-new-bell:has(+ .whats-new-panel:popover-open) { border-color: var(--ink); background: var(--yellow); box-shadow: 2px 2px 0 var(--ink); }
    .whats-new-dot { position: absolute; top: 8px; right: 8px; width: 10px; height: 10px; border: 2px solid var(--ink); border-radius: 50%; background: var(--blue); }
    .whats-new-panel { position: fixed; inset: 76px 12px auto auto; width: min(400px, calc(100vw - 24px)); max-height: calc(100dvh - 96px); margin: 0; padding: 18px 20px 20px; overflow-y: auto; border: 2px solid var(--ink); border-radius: var(--radius); background: var(--white); color: var(--ink-soft); box-shadow: var(--shadow-hard); }
    @supports (position-area: bottom) {
      .whats-new-panel { inset: auto; margin-top: 8px; position-anchor: --whats-new; position-area: bottom span-left; position-try-fallbacks: flip-inline; }
      @media (max-width: 480px) {
        .whats-new-panel { position-area: bottom span-all; justify-self: center; }
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
      .app-bar { padding: 14px; }
      .app-page { padding: 24px 18px; }
      .facts { grid-template-columns: minmax(0, 1fr); gap: 4px; }
      .facts dd { margin-bottom: 8px; }
    }


    @media (max-width: 760px) {
      .wrap {
        width: min(100% - 28px, 980px);
        padding-top: 28px;
      }

      h1 {
        max-width: 13ch;
        font-size: 2.45rem;
      }

      .head-line {
        margin-bottom: 1.8rem;
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
