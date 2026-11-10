/**
 * The document: flat paper, Geist body text, one focus ring, links, code and the headings pages
 * write by hand. Doors draw on the grid-and-gradient canvas; the app stays flat.
 */
export const base = `
    *, *::before, *::after { box-sizing: border-box; }
    html { background: var(--paper); -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--text);
      font: var(--text-body);
      text-rendering: optimizeLegibility;
      -webkit-font-smoothing: antialiased;
    }
    body:has(.auth-card, .app) { min-height: 100vh; display: flow-root; }
    body:has(> .auth-card) {
      background:
        linear-gradient(var(--door-grid) 1px, transparent 1px),
        linear-gradient(90deg, var(--door-grid) 1px, transparent 1px),
        linear-gradient(180deg, var(--info-bg) 0%, var(--paper) 40%, var(--success-bg) 100%);
      background-size: 32px 32px, 32px 32px, auto;
    }
    ::selection { background: var(--highlight); color: var(--ink); }
    /* Ink, never blue: a blue ring vanishes on a blue button. */
    :focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

    h1, h2, h3 { margin: 0 0 var(--space-2); color: var(--ink); text-wrap: balance; }
    h1 { font: var(--text-title); }
    h2 { font: var(--text-section); }
    h3 { margin-top: var(--space-5); font: var(--text-section); }
    p { max-width: 70ch; margin: 0 0 var(--space-3); text-wrap: pretty; }

    a { color: var(--link); font-weight: var(--weight-medium); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    @media (hover: hover) { a:hover { text-decoration-thickness: 2px; } }

    code, kbd, pre { font-family: var(--font-mono); font-variant-ligatures: none; }
    code { padding: 1px 5px; border-radius: 4px; background: var(--sunken); color: var(--ink); font-size: .929em; }
    pre {
      margin: 0;
      padding: var(--space-3) var(--space-4);
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: var(--r-container);
      background: var(--sunken);
      color: var(--ink);
      font: var(--text-code);
    }
    pre code { padding: 0; background: none; font-size: inherit; }
    kbd {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 20px; height: 20px; padding: 0 5px;
      border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px;
      background: var(--surface); color: var(--muted);
      font: var(--text-badge);
    }
    summary { cursor: pointer; }
    mark { padding: 0 2px; border-radius: 3px; background: var(--highlight); color: var(--ink); }
    time, .tabular { font-variant-numeric: tabular-nums; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; }
    }
`;
