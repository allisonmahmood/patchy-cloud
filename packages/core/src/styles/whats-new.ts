/** What's new: the sidebar's button and its panel, a change, and the line under what was seen. */
export const whatsNew = `
    .whats-new-bell { anchor-name: --whats-new; }
    /* While its panel is open, What's new takes a current place's look. */
    .whats-new-bell:has(+ .whats-new-panel:popover-open) { border-color: var(--ink); background: var(--selected); color: var(--ink); }
    .app-place > .whats-new-dot { margin-left: auto; }
    .whats-new-panel {
      position: fixed; inset: auto auto var(--space-4) var(--space-4);
      width: min(360px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: 0;
      padding: var(--space-4); overflow-y: auto;
      border: 2px solid var(--ink); border-radius: var(--r-container);
      background: var(--surface); color: var(--text); box-shadow: var(--float);
    }
    @supports (position-area: bottom) {
      .whats-new-panel { inset: auto; margin: 0 0 0 var(--space-2); position-anchor: --whats-new; position-area: right span-top; position-try-fallbacks: flip-block; }
      @media (max-width: 899px) {
        .whats-new-panel { inset: auto var(--space-2) var(--space-2) var(--space-2); width: auto; margin: 0; position-area: none; }
      }
    }
    .whats-new-panel > .supporting-text { margin: 0 0 var(--space-1); }
    .whats-new-panel .btn-primary { width: 100%; margin-top: var(--space-3); }
    .whats-new-change { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: var(--space-3); align-items: start; }
    .list-row.whats-new-change { padding-block: var(--space-3); }
    .whats-new-change > .pill { justify-self: start; }
    .whats-new-change p { margin: 0; }
    .whats-new-change p + p { margin-top: var(--space-1); }
    .whats-new-change strong { color: var(--ink); }
    .whats-new-panel .whats-new-change { grid-template-columns: 5.5rem minmax(0, 1fr); align-items: baseline; padding-block: 6px; color: var(--ink); font: var(--text-meta); }
    .whats-new-unseen { margin-inline: calc(-1 * var(--space-3)); padding-inline: var(--space-3); box-shadow: inset 2px 0 0 var(--blue); }
    .whats-new-day-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-3); padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    .whats-new-day-head .section-heading { margin: 0; }
    .whats-new-seen { display: flex; align-items: center; gap: var(--space-3); max-width: none; margin: var(--space-6) 0 0; color: var(--muted); font: var(--text-meta); }
    li.whats-new-seen { margin: var(--space-4) 0; }
    .whats-new-seen::before, .whats-new-seen::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
    @media (max-width: 479px) { .whats-new-day .whats-new-change { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
`;
