/**
 * What shows at which width, and what waits for script. `hide-sm` leaves something out below
 * 640px and `show-sm` shows it only there, as a table's columns do; `hide-below-wide` and
 * `show-below-wide` do the same below 1280px, where a table beside a rail runs narrow. A copy
 * button stays hidden until the copy script reveals it.
 */
export const visibility = `
    @media (min-width: 640px) { .show-sm { display: none !important; } }
    @media (max-width: 639px) { .hide-sm { display: none !important; } }
    @media (min-width: 1280px) { .show-below-wide { display: none !important; } }
    @media (max-width: 1279px) { .hide-below-wide { display: none !important; } }
    .copy-button[hidden] { display: none; }
`;
