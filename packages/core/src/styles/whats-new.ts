/** What's new's page: a change, a day's head and the line under what was seen. The sidebar's panel is the app shell's. */
export const whatsNew = `
    .whats-new-change { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: var(--space-3); align-items: start; }
    .list-row.whats-new-change { padding-block: var(--space-3); }
    .whats-new-change > .pill { justify-self: start; }
    .whats-new-change p { margin: 0; }
    .whats-new-change p + p { margin-top: var(--space-1); }
    .whats-new-change strong { color: var(--ink); }
    .whats-new-unseen { margin-inline: calc(-1 * var(--space-3)); padding-inline: var(--space-3); box-shadow: inset 2px 0 0 var(--blue); }
    .whats-new-day-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-1) var(--space-3); padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    .whats-new-day-head .section-heading { margin: 0; }
    .whats-new-seen { display: flex; align-items: center; gap: var(--space-3); max-width: none; margin: var(--space-6) 0 0; color: var(--muted); font: var(--text-meta); }
    li.whats-new-seen { margin: var(--space-4) 0; }
    .whats-new-seen::before, .whats-new-seen::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
    @media (max-width: 479px) { .whats-new-day .whats-new-change { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
`;
