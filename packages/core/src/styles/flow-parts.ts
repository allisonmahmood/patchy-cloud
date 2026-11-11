/**
 * What a flow holds besides its numbered sections. Choice links are its choices as tiles that are
 * links: pressed, so a strong edge at rest, and the current one takes the 2px ink edge and fill a
 * checked choice takes; a dashed one stands in for any other. A flow's outcome sits on the flow's
 * own gap, above and below.
 */
export const flowParts = `
    .choice-links { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: var(--space-2); }
    .choice-link {
      display: flex; align-items: center; gap: 10px; min-width: 0; min-height: var(--h-row-2);
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--border-strong); border-radius: var(--r-container);
      background: var(--surface); color: var(--ink); font: var(--text-label); text-decoration: none;
    }
    .choice-link > span { min-width: 0; overflow-wrap: anywhere; }
    @media (hover: hover) { .choice-link:hover { border-color: var(--ink); } }
    .choice-link[aria-current="page"] { padding: 7px 11px; border: 2px solid var(--ink); background: var(--chosen); }
    .choice-link-dashed:not([aria-current="page"]) { border-style: dashed; color: var(--muted); }
    .flow-outcome > :last-child { margin-bottom: 0; }
`;
