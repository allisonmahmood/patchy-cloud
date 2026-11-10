/**
 * The five templates' frames: page widths, the page header, Detail's main and aside, Flow's
 * sections and the door's body and foot. Pages fill these slots; none adds to them.
 */
export const templates = `
    .page { width: 100%; max-width: var(--w-index); }
    .page-settings { max-width: var(--w-settings); }
    .page-flow { max-width: var(--w-flow); }

    .ph { display: grid; gap: var(--space-2); margin-bottom: var(--space-5); }
    .ph-parent { display: inline-flex; align-items: center; gap: var(--space-1); width: fit-content; min-height: 24px; color: var(--muted); font: var(--text-meta); font-weight: var(--weight-medium); text-decoration: none; }
    .ph-parent svg { width: 14px; height: 14px; }
    @media (hover: hover) { .ph-parent:hover { color: var(--ink); } }
    .ph-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-4); align-items: start; }
    .ph-row-nomark { grid-template-columns: minmax(0, 1fr) auto; }
    .ph-text { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-1); min-width: 0; }
    .ph-text > .title { margin: 0; }
    .ph-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); max-width: none; margin: 0; color: var(--muted); font: var(--text-meta); line-height: 20px; }
    .ph-sep { color: var(--border-strong); }
    .ph-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); color: var(--text); font: var(--text-meta); }
    /* A status sentence wraps inside the header, its dot beside the first line. */
    .ph-status > .dot { align-items: baseline; white-space: normal; }
    .ph-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2); }
    .ph-mark { padding-top: 2px; }
    .ph + .tabs { margin-top: calc(-1 * var(--space-2)); }
    @media (max-width: 639px) {
      .ph-row { grid-template-columns: auto minmax(0, 1fr); }
      .ph-row-nomark { grid-template-columns: minmax(0, 1fr); }
      .ph-actions { grid-column: 1 / -1; justify-content: flex-start; }
    }

    .split-main { min-width: 0; }
    .aside { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }

    .flow-section > legend { float: left; width: 100%; }
    .flow-section:disabled, .flow-section:disabled .flow-title { color: var(--muted); }
    .step-marker svg { width: 14px; height: 14px; }

    .door-body > :last-child { margin-bottom: 0; }
    .door-foot { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--border-subtle); color: var(--muted); font: var(--text-meta); }
`;
