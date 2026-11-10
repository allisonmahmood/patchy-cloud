/**
 * Table cells beyond the base table, each opted into by a column or a class: a column that keeps
 * its cells on one line, such as a time, a count or a row's buttons; the one that takes the room
 * left, whose description stays one line; a column of short sentences; a link in a row that opens
 * on a press anywhere, such as a failure count leading to its log, which sits above the row's own
 * link and stays pressable, as the row's buttons and menu do; and what a cell shows only on a
 * phone, where its column is gone. The growing column and a sentence's keep a floor, so their
 * words stay whole; a narrower window scrolls the table in its wrapper instead.
 */
export const tableCells = `
    .table .nowrap { white-space: nowrap; overflow-wrap: normal; }
    .table td.cell-grow { width: 100%; }
    .table td.cell-grow > * { min-width: 10rem; }
    .table td.cell-readable > * { min-width: 14rem; }
    .table .cell-grow .row-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .table tbody tr:has(.row-link) a:not(.row-link) { position: relative; }
    .table .show-sm { display: none; }
    @media (max-width: 639px) { .table .show-sm { display: block; } }
`;
