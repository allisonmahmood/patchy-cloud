/**
 * Framed choices. A tile row is one framed choice or link; a choice card is a radio drawn large.
 * Checked choices take a 2px ink edge over the native radio they keep. Home's usual tiles, the one
 * resting container that lifts, are the `usual` chunk's.
 */
export const tiles = `
    .tile-name { color: var(--ink); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
    .tile-text { color: var(--muted); font: var(--text-meta); }

    .tile-row {
      display: flex; align-items: center; gap: var(--space-3); min-width: 0;
      min-height: var(--h-row-2); padding: var(--space-2) var(--space-3);
      border: 1px solid var(--border); border-radius: var(--r-container);
      background: var(--surface); color: var(--text); font-weight: var(--weight-regular); text-decoration: none;
    }
    @media (hover: hover) { a.tile-row:hover, label.tile-row:hover { background: var(--hover); } }
    .tile-body { display: grid; flex: 1; gap: 1px; min-width: 0; }
    .tile-row .tile-text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .tile-row > .whats-new-dot { align-self: start; margin-top: 6px; }
    .tile-row-placeholder { border-style: dashed; border-color: var(--border-strong); background: transparent; }

    .tile-options { display: grid; gap: var(--space-2); margin: var(--space-3) 0 0; }
    .tile-option { position: relative; cursor: pointer; }
    .tile-option > input, .choice-card > input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
    .tile-option:has(> input:checked), .choice-card:has(> input:checked) { border: 2px solid var(--ink); background: var(--chosen); color: var(--ink); }
    .tile-option:has(> input:checked) { padding: 7px 11px; }
    .tile-option:has(> input:focus-visible), .choice-card:has(> input:focus-visible) { outline: 2px solid var(--ink); outline-offset: 2px; }
    .tile-option:has(> input:disabled), .choice-card:has(> input:disabled) { opacity: .5; cursor: not-allowed; }
    .tile-option:has(> input:disabled):hover, .choice-card:has(> input:disabled):hover { background: var(--surface); }
    .tile-row-placeholder.tile-option:has(> input:disabled):hover { background: transparent; }

    .choice-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); margin: var(--space-3) 0 0; }
    .choice-card {
      position: relative; display: block; padding: 14px var(--space-4);
      border: 1px solid var(--border-strong); border-radius: var(--r-container);
      background: var(--surface); color: var(--text); cursor: pointer;
    }
    .choice-card:has(> input:checked) { padding: 13px 15px; }
    @media (hover: hover) { .choice-card:hover { border-color: var(--ink); } }
    .choice-card-title { display: block; margin: 0 0 var(--space-1); color: var(--ink); font-weight: var(--weight-strong); }
    .choice-card-point { position: relative; display: block; padding-left: 14px; color: var(--muted); font: var(--text-meta); }
    .choice-card-point::before { content: "–"; content: "–" / ""; position: absolute; left: 0; }
`;
