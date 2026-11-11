/**
 * Things that hold: sections, boxes, cards with setting rows, entity rows, lists and fact lists.
 * Hairline edges and no shadow; a row with a stretched link opens on a press anywhere while its
 * own buttons and menus stay operable above the link.
 */
export const containers = `
    .section { margin-top: var(--space-6); }
    .section:first-child { margin-top: 0; }
    .section-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--space-2) var(--space-4); min-height: var(--h-sm); margin-bottom: var(--space-3); }
    .section-head > div { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; min-width: 0; }
    .section-head .section-title { margin: 0; }
    .stack { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
    .cluster { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }

    .box { border: 1px solid var(--border); border-radius: var(--r-container); background: var(--surface); }
    .box-pad { padding: var(--space-4); }

    .card { border: 1px solid var(--border); border-radius: var(--r-container); background: var(--surface); }
    .card + .card { margin-top: var(--space-5); }
    .card-head { padding: var(--space-4) 20px var(--space-1); }
    .card-head .section-title { margin: 0; }
    .card-body { padding: var(--space-4) 20px; }
    .card-foot {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2) var(--space-4);
      min-height: 52px; padding: var(--space-2) var(--space-3) var(--space-2) 20px;
      border-top: 1px solid var(--border-subtle); border-radius: 0 0 var(--r-container) var(--r-container); background: var(--sunken);
    }
    .card-foot > .meta { margin-right: auto; }
    .card-danger { border-color: var(--danger-line); }
    .card-danger .card-head .section-title { color: var(--danger); }
    .card-gap { margin-top: var(--space-7); }

    .rows { margin: 0; padding: 0; list-style: none; }
    .rows > * + * { border-top: 1px solid var(--border-subtle); }
    .row {
      position: relative;
      display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-3);
      min-height: var(--h-row-2); padding: 10px var(--space-4);
    }
    .row-plain { grid-template-columns: minmax(0, 1fr) auto; }
    .row-main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; min-width: 0; }
    .row-name { color: var(--ink); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
    .row-name a { color: inherit; text-decoration: none; }
    .row-desc { color: var(--muted); font: var(--text-meta); }
    .row-end { display: flex; align-items: center; gap: var(--space-2); justify-self: end; }
    /* A stretched link covers its row; the row's own controls sit above it. */
    .row-link { color: var(--ink); font-weight: var(--weight-strong); text-decoration: none; }
    @media (hover: hover) { .row-link:hover { text-decoration: underline; } }
    .row-link::after { content: ""; position: absolute; inset: 0; }
    .row :is(.btn, form) { position: relative; z-index: 1; }
    @media (hover: hover) { .row:has(.row-link):hover { background: var(--hover); } }
    .setting { grid-template-columns: minmax(0, 1fr) auto; min-height: 64px; padding: 14px 20px; }
    .setting .row-main { gap: 3px; }
    .setting form { margin: 0; }
    @media (max-width: 639px) { .setting { grid-template-columns: minmax(0, 1fr); } .setting .row-end { justify-self: start; } }

    .facts { display: grid; grid-template-columns: minmax(96px, 128px) minmax(0, 1fr); gap: 10px var(--space-4); margin: var(--space-4) 0; overflow-wrap: anywhere; }
    .facts dt { color: var(--muted); font: var(--text-meta); line-height: var(--line-body); }
    .facts dd { min-width: 0; margin: 0; color: var(--ink); }
    @media (max-width: 639px) { .facts { grid-template-columns: minmax(0, 1fr); gap: 2px 0; } .facts dd { margin-bottom: 10px; } }

    .list { margin: var(--space-4) 0; padding: 0; list-style: none; }
    .list-row { padding: var(--space-3) 0; border-bottom: 1px solid var(--border-subtle); overflow-wrap: anywhere; }
    .list-row p { margin: 0 0 var(--space-1); }
    .list-row summary { margin: var(--space-2) 0; cursor: pointer; }
    .list-compact .list-row { padding: var(--space-1) 0; border-bottom: 0; }
    .list-tree { margin: var(--space-2) 0 var(--space-3) 6px; padding-left: var(--space-4); border-left: 1px solid var(--border); }

    /* split: a main column with a panel beside it; on a narrow page the panel drops below. */
    .split { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: var(--space-6) var(--space-7); align-items: start; }
    @media (max-width: 1023px) { .split { grid-template-columns: minmax(0, 1fr); gap: var(--space-6); } }

    .auth-signout { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle); color: var(--muted); font: var(--text-meta); }

    .empty { display: grid; grid-template-columns: minmax(0, 1fr); justify-items: start; gap: 6px; padding: 28px var(--space-5); }
    .empty-title { color: var(--ink); font: var(--text-section); }
    .empty .btn-group { margin-top: 10px; }
`;
