export interface AppShell {
  readonly viewer: {
    readonly user: { readonly name: string };
    readonly company: { readonly name: string };
  };
  readonly section: "patches" | "company" | "connections" | "machines";
}

function appBody(app: AppShell, body: string): string {
  const link = (href: string, label: string, section: AppShell["section"]) =>
    `<a href="${href}"${section === app.section ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<div class="app-card"><header class="app-bar"><div class="brand"><span class="glyph" aria-hidden="true"></span>Patchy</div><nav class="app-nav" aria-label="Primary">${link("/", "Patches", "patches")}${link("/company", "Company", "company")}${link("/company/connections", "Connections", "connections")}${link("/machines", "Your machines", "machines")}</nav><div class="app-who"><span>${escapeHtml(app.viewer.user.name)} · ${escapeHtml(app.viewer.company.name)}</span><form method="post" action="/logout"><button class="btn btn-quiet" type="submit">Sign out</button></form></div></header><main class="app-page">${body}</main></div>`;
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

    :focus-visible {
      outline: 3px solid var(--blue);
      outline-offset: 3px;
      border-radius: 6px;
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

    code,
    pre {
      font-family: var(--font-mono);
    }

    code {
      padding: .12em .4em;
      border-radius: 5px;
      background: rgba(18, 17, 15, .06);
      font-size: .9em;
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
    .supporting-text { color: var(--muted); font-size: .9rem; }
    .field-error { margin: 8px 0 20px; color: var(--danger); font-size: .85rem; font-weight: 750; }
    .field[aria-invalid="true"] { border-color: var(--danger); }
    .field-choice, .confirmation-acknowledgement { display: flex; align-items: baseline; gap: 10px; min-height: 44px; padding: 8px 0; cursor: pointer; }
    .field-checkbox, .field-radio { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--blue); cursor: pointer; }
    .field:disabled, .field-checkbox:disabled, .field-radio:disabled { opacity: .55; cursor: not-allowed; }
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
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .auth-email { font-weight: 750; overflow-wrap: anywhere; }
    .auth-signout { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line-strong); }
    .section { margin-top: 32px; }
    .list, .confirmation-list { list-style: none; padding: 0; margin: 16px 0; }
    .list-row, .confirmation-list > li { padding: 20px 0; border-bottom: 1px solid var(--line-strong); overflow-wrap: anywhere; }
    .list-row p { margin: 0 0 8px; }
    .list-row summary { margin: 12px 0; cursor: pointer; }
    .code-panel { max-height: 18rem; white-space: pre-wrap; overflow-wrap: anywhere; }
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
    @media (max-width: 480px) {
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
