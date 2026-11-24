/**
 * What shows at which width, and what waits for script. `hide-sm` leaves something out below
 * 640px and `show-sm` shows it only there, as a table's columns do. `hide-narrow` and
 * `show-narrow` do the same where a table runs narrow: on a phone, and from 1024px to 1279px in
 * `mainWithRail`'s main column, while the rail sits beside it (below 1024px it follows, and the
 * table has the width back). A copy button stays hidden until the copy script reveals it.
 */
export const visibility = `
    @media (min-width: 640px) { .show-sm { display: none !important; } }
    @media (max-width: 639px) { .hide-sm, .hide-narrow { display: none !important; } }
    @media (min-width: 1024px) and (max-width: 1279px) { .main-rail-main .hide-narrow { display: none !important; } }
    @media (min-width: 640px) and (max-width: 1023px), (min-width: 1280px) { .show-narrow { display: none !important; } }
    @media (min-width: 1024px) and (max-width: 1279px) { .show-narrow:not(.main-rail-main *) { display: none !important; } }
    .copy-button[hidden] { display: none; }
`;
