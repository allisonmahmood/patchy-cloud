/**
 * A wide table keeps its columns whole and scrolls inside its wrapper on a narrow page, as a log
 * or a connection's calls do, rather than squeezing words apart. Layout only.
 */
export const wideTables = `
    .table-wide { min-width: 720px; overflow-wrap: break-word; }
    .table-wide time { white-space: nowrap; }
`;
