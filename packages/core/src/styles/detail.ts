/**
 * The parts `ui/detail.ts` draws for a Detail page's tabs: a chip that opens a menu of links, a
 * table's group headings and expanding rows, the Settings template inside a tab, a Copy button
 * that waits hidden for the copy script, a person beside their mark and a refusal that takes focus.
 */
export const detail = `
    button.chip { cursor: pointer; }
    /* A chip sits at a toolbar's start, so its menu drops under it and runs right. */
    @supports (position-area: bottom) {
      .chip-menu + .menu { position-area: bottom span-right; position-try-fallbacks: flip-block, flip-inline; }
    }
    .menu-item[aria-current] { background: var(--selected); font-weight: var(--weight-strong); }

    .table .group-row th { padding-top: var(--space-4); border-bottom-color: var(--border); }
    /* A grouped table's rows keep their cells whole; on a narrow page it scrolls in its wrapper. */
    .table-grouped tr:not(.table-expand) > td { white-space: nowrap; }
    /* A permalink lands on a row's disclosure; the row it opens under stays in view. */
    .table-expand details { scroll-margin-top: var(--space-8); }

    .settings-panel { max-width: var(--w-settings); }

    .btn[data-copy][hidden] { display: none; }

    .person { display: inline-flex; align-items: center; gap: var(--space-2); vertical-align: middle; }
    .refusal:focus { outline: none; }
    .refusal:focus-visible > .notice { outline: 2px solid var(--ink); outline-offset: 2px; }
`;
