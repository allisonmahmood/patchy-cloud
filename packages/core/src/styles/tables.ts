/**
 * Tables, for comparing columns: muted 13px headers, 56px rows on hairlines. A wide table scrolls
 * inside its own wrapper on a phone instead of squeezing its columns.
 */
export const tables = `
    .table-wrap { overflow-x: auto; }
    .table { width: 100%; margin: var(--space-4) 0; border-collapse: collapse; overflow-wrap: anywhere; }
    .table th {
      height: 36px; padding: 0 var(--space-3);
      border-bottom: 1px solid var(--border);
      color: var(--muted); font: var(--text-meta); font-weight: var(--weight-medium);
      text-align: left; vertical-align: bottom; white-space: nowrap;
    }
    .table td { height: var(--h-row-2); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border-subtle); text-align: left; vertical-align: middle; }
    .table th:first-child, .table td:first-child { padding-left: 0; }
    .table th:last-child, .table td:last-child { padding-right: 0; }
    .table .r { text-align: right; }
    .table-compact td { height: 40px; padding-block: 6px; }
    .table tbody tr { position: relative; }
    @media (hover: hover) { .table tbody tr:has(.row-link):hover > td { background: var(--hover); } }
    .table .cell-name { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
    .table .group-row td { height: 32px; padding-top: var(--space-4); border-bottom: 1px solid var(--border); color: var(--muted); font: var(--text-meta); font-weight: var(--weight-medium); }
    /* An expandable row: a table-expand row after its entry holds one full-width cell with a
       details. The entry gives up its rule so the pair reads as one row. */
    .table tr:has(+ .table-expand) > * { border-bottom: 0; }
    .table-expand > td { height: auto; padding-top: 0; }
    .table-expand summary { margin: 0 0 var(--space-2); cursor: pointer; }
    /* Scrolling, the wrapper holds all the table draws, a hidden header's label too, so only it scrolls. */
    .table-wrap { position: relative; }
    @media (max-width: 639px) { .table .hide-sm { display: none; } }
`;
