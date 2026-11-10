/**
 * Notices and receipts. A notice is info, warning or danger, at most one a page, beside what it
 * is about; there is no success notice. A receipt is one quiet line saying what the last form
 * did, shown once at the top of the page it lands on.
 */
export const notices = `
    .note, .notice {
      margin: var(--space-4) 0;
      padding: var(--space-3) 14px;
      border: 1px solid var(--border); border-radius: var(--r-container);
      background: var(--surface); color: var(--text);
    }
    .note-title, .notice-title { display: block; margin-bottom: 2px; color: var(--ink); font-weight: var(--weight-strong); }
    .note > p, .notice > p { margin: 0; }
    .note > p + p, .notice > p + p { margin-top: 6px; }
    .note .actions, .notice .actions { margin-top: var(--space-3); }
    .note-info, .notice-info { border-color: var(--info-line); background: var(--info-bg); }
    .note-warn, .notice-warning { border-color: var(--warning-line); background: var(--warning-bg); }
    .note-refused, .notice-danger { border-color: var(--danger-line); background: var(--danger-bg); }
    .note-ok { border-color: var(--success-line); background: var(--success-bg); }
    .notice-info .notice-title { color: var(--info); }
    .notice-warning .notice-title { color: var(--warning); }
    .notice-danger .notice-title { color: var(--danger); }

    /* notice: the helper's anatomy, an icon, title and body, and an action at the end. */
    .notice { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 10px; align-items: start; }
    .notice > svg { width: 16px; height: 16px; margin-top: 2px; }
    .notice-info > svg { color: var(--info); }
    .notice-warning > svg { color: var(--warning); }
    .notice-danger > svg { color: var(--danger); }
    .notice-body { grid-column: 2; }
    .notice > .notice-action { grid-column: 3; grid-row: 1 / span 2; align-self: center; }

    /* note-inline: a note laid out as one row, its text then its actions. */
    .note-inline { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-4); }
    .note-inline .note-title { margin: 0; }
    .note-inline .actions { margin: 0; }
    @media (max-width: 479px) { .note-inline { grid-template-columns: minmax(0, 1fr); } }

    .receipt, .app-receipt {
      display: flex; align-items: center; gap: 10px;
      min-height: 40px; margin: 0 0 var(--space-5); padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
      border: 1px solid var(--success-line); border-radius: var(--r-container);
      background: var(--success-bg); color: var(--ink);
    }
    .receipt > svg { width: 16px; height: 16px; flex: none; color: var(--success); }
    .receipt > .btn { margin-left: auto; }
`;
