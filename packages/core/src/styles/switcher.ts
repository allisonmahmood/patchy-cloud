/**
 * The switcher on an app page: Mod+Shift+K's command list (core's `commandList`) in a modal dialog
 * with a flat dim, anchored near the top so the field never moves as the list shrinks. Over a
 * running patch the shell draws the same anatomy from `servedStyles`; here it takes the app's
 * tokens. Nothing about it animates.
 */
export const switcher = `
    .glyph-sm { width: 18px; height: 18px; border-radius: 5px; box-shadow: var(--lift); }
    .glyph-sm::after { top: 3px; right: 3px; width: 5px; height: 5px; }

    .shell-scrim {
      position: fixed; inset: 0;
      width: 100%; height: 100%; max-width: none; max-height: none;
      margin: 0; padding: var(--space-4); border: 0;
      background: var(--scrim); color: var(--text); font-family: var(--font-ui);
    }
    .shell-scrim[open] { display: grid; place-items: center; }
    .shell-scrim::backdrop { background: transparent; }
    .shell-scrim [hidden] { display: none; }
    .switcher[open] { place-items: start center; padding-top: min(96px, 10vh); }
    .switcher > .command { width: min(600px, 100%); max-height: calc(100dvh - 2 * min(96px, 10vh)); }

    /* kbd: a keycap, its glyph drawn rather than typed; kbd-sm sits in a row. */
    .kbd {
      display: inline-flex; align-items: center; justify-content: center; gap: 2px; flex: none;
      min-width: 26px; height: 24px; padding: 0 6px;
      border: 1px solid var(--ink); border-radius: var(--r-control);
      background: var(--surface); box-shadow: var(--key);
      color: var(--ink); font: var(--text-badge);
    }
    .kbd svg { display: block; }
    .kbd-sm { min-width: 22px; height: 20px; padding: 0 4px; border-radius: 5px; box-shadow: var(--key-sm); }

    .command, .command * { box-sizing: border-box; }
    .command {
      display: flex; flex-direction: column; min-height: 0; overflow: hidden;
      border: 2px solid var(--ink); border-radius: var(--r-modal);
      background: var(--surface); box-shadow: var(--modal);
      color: var(--ink); font: var(--text-body); text-align: left;
    }
    .command :is(p, a) { max-width: none; margin: 0; }
    .command-field.field {
      display: flex; align-items: center; gap: var(--space-3); flex: none;
      min-height: var(--h-command); padding: 0 var(--space-4);
      border: 0; border-bottom: 1px solid var(--border); border-radius: 0;
      background: transparent; box-shadow: none; font: var(--text-section);
    }
    /* The caret is the field's focus: it holds focus for as long as the list is open. */
    .command-field.field:has(> input:focus-visible) { outline: none; box-shadow: none; }
    .command-field > input { align-self: stretch; padding: 0; font: inherit; font-size: var(--field-text); }
    .command-field > input::placeholder { color: var(--placeholder); font-weight: var(--weight-regular); }
    .command-list { display: flex; flex-direction: column; min-height: 0; padding: 6px; overflow-y: auto; overscroll-behavior: contain; scroll-padding-block: 6px; }
    .command-group { display: flex; flex-direction: column; }
    .command-row {
      display: flex; align-items: center; gap: 10px; flex: none; min-width: 0;
      min-height: var(--h-sm); padding: var(--space-1) 10px var(--space-1) var(--space-2);
      border-radius: var(--r-control);
      color: var(--ink); font: var(--text-label); text-decoration: none; cursor: pointer;
    }
    .command-row[aria-selected="true"] { background: var(--selected); }
    .command-row .mono { width: 24px; height: 24px; border-radius: 6px; font-size: 9px; }
    .command-row .page-mark { width: 24px; height: 24px; border-radius: 6px; }
    .command-row .page-mark::after { inset: 6px 5px; }
    .command-icon { display: inline-grid; place-items: center; flex: none; width: 24px; height: 24px; }
    .command-icon svg { width: 16px; height: 16px; }
    .command-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .command-title > .whats-new-dot { margin-left: var(--space-2); vertical-align: 1px; }
    .command-detail { flex: none; color: var(--muted); font: var(--text-meta); font-variant-numeric: tabular-nums; }
    .command-row > .kbd { margin-left: -2px; }
    .command-head.shelf-label { display: flex; align-items: center; gap: var(--space-2); flex: none; height: 30px; margin: 0; padding: 10px 10px 0; }
    .command-head-patchy.shelf-label { color: var(--ink); }
    .command-head .glyph-sm { width: 14px; height: 14px; border-width: 1.5px; border-radius: 4px; box-shadow: var(--lift-sm); }
    .command-head .glyph-sm::after { top: 2px; right: 2px; width: 4px; height: 4px; border-width: 1.5px; }
    .command-empty { flex: none; padding: 20px var(--space-4) var(--space-1); color: var(--text); font-weight: var(--weight-medium); }
    /* A live region, so it stays in place, empty and without height, until it has something to say. */
    .command-empty:empty { padding: 0; }
`;
