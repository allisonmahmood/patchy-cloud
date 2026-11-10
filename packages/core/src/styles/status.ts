/**
 * Status: a badge means something needs a decision; routine success is plain text or a dot.
 * Always a word beside the colour, in sentence case.
 */
export const status = `
    .badge, .pill, .tag {
      display: inline-flex; align-items: center; gap: var(--space-1); flex: none;
      min-height: 20px; padding: 0 7px;
      border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: var(--r-round);
      background: var(--sunken); color: var(--text);
      font: var(--text-badge); white-space: nowrap; vertical-align: 1px;
    }
    .badge svg { width: 12px; height: 12px; }
    .badge-success, .pill-done { background: var(--success-bg); color: var(--success); }
    .badge-warning { background: var(--warning-bg); color: var(--warning); }
    .badge-danger, .pill-failed { background: var(--danger-bg); color: var(--danger); }
    .badge-info, .pill-progress { background: var(--info-bg); color: var(--info); }
    .badge-yellow, .tag-new { border-color: rgba(18, 17, 15, .35); background: var(--selected); color: var(--ink); }
    .tag { margin-left: 6px; }

    .dot { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
    .dot::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--border-strong); }
    .dot-success::before { background: var(--success-dot); }
    .dot-danger::before { background: var(--danger-solid); }
    .dot-warning::before { background: var(--yellow); box-shadow: inset 0 0 0 1px var(--warning); }
    .dot-info::before { background: var(--blue); }

    /* unseen: something new to the viewer, a blue dot beside its name. */
    .unseen, .whats-new-dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--blue); }
`;
