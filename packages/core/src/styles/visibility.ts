/**
 * What shows at which width, and what waits for script. `hide-sm` leaves something out below
 * 640px and `show-sm` shows it only there, as a table's columns do. A copy button stays hidden
 * until the copy script reveals it.
 */
export const visibility = `
    @media (min-width: 640px) { .show-sm { display: none !important; } }
    @media (max-width: 639px) { .hide-sm { display: none !important; } }
    .copy-button[hidden] { display: none; }
`;
