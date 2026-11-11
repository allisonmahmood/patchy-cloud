/**
 * What's new's changes: one line of kind and title that opens in place to the detail, the new-to-you
 * dot on those the viewer hasn't seen, and a day's behind-the-scenes lines as a quieter one.
 */
export const changelog = `
    .change { border-bottom: 1px solid var(--border-subtle); }
    .change:first-of-type { border-top: 1px solid var(--border-subtle); }
    .change-head {
      display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: baseline; gap: var(--space-3);
      min-height: var(--h-row); margin-inline: calc(-1 * var(--space-2)); padding: var(--space-3) var(--space-2);
      border-radius: var(--r-control); color: var(--ink); cursor: pointer; list-style: none;
    }
    .change-head::-webkit-details-marker { display: none; }
    @media (hover: hover) { .change-head:hover { background: var(--hover); } }
    .change-head > svg { align-self: center; width: 16px; height: 16px; color: var(--muted); }
    .change[open] > .change-head > svg { transform: rotate(90deg); }
    .change-kind { color: var(--muted); font: var(--text-badge); }
    .change-title { font-weight: var(--weight-medium); overflow-wrap: anywhere; }
    .change-title > .whats-new-dot { margin-left: var(--space-2); vertical-align: 1px; }
    .change-quiet { color: var(--muted); font-weight: var(--weight-regular); }
    /* A permalink scrolls to the body; the margin keeps its one-line title in view above it. */
    .change-body { padding: 0 0 var(--space-4) calc(72px + var(--space-3)); scroll-margin-top: var(--space-8); }
    .change-body > .prose { margin: 0 0 var(--space-2); }
    .change-body > .meta { margin: 0; }
    .change-lines { display: grid; gap: var(--space-2); max-width: var(--w-prose); margin: 0; padding-left: 1.2em; font: var(--text-prose); }
    @media (max-width: 639px) {
      .change-head { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
      .change-kind { grid-column: 1 / -1; }
      .change-kind:empty { display: none; }
      .change-body { padding-left: 0; }
    }
`;
