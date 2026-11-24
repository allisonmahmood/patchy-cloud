/**
 * `mainWithRail`: a main column and a narrow rail beside it, spaced from what comes before as a
 * section is. Below 1024px, where the sidebar folds, the rail follows the main column; the
 * `visibility` chunk's `hide-narrow` keys on the same width. Layout only.
 */
export const mainRail = `
    .main-rail { display: grid; grid-template-columns: minmax(0, 1fr) clamp(260px, 25vw, 320px); gap: var(--space-6); align-items: start; margin-top: var(--space-6); }
    .main-rail:first-child { margin-top: 0; }
    .main-rail-main, .main-rail-rail { min-width: 0; }
    @media (max-width: 1023px) { .main-rail { grid-template-columns: minmax(0, 1fr); } }
`;
