/**
 * The type roles: page title, dialog and door title, section title, prose, body, label, meta,
 * badge and code. Sentence case everywhere; nothing is set in capitals.
 */
export const type = `
    .title, .page-heading { max-width: none; margin: 0 0 var(--space-2); color: var(--ink); font: var(--text-title); letter-spacing: -.01em; overflow-wrap: anywhere; text-wrap: balance; }
    .title-sm, .auth-card .page-heading, .modal-panel .page-heading { color: var(--ink); font: var(--text-title-sm); letter-spacing: -.005em; text-wrap: balance; }
    .section-title, .section-heading { margin: 0 0 var(--space-3); color: var(--ink); font: var(--text-section); letter-spacing: -.01em; }
    .label { color: var(--ink); font: var(--text-label); }
    .prose, .lede { max-width: var(--w-prose); font: var(--text-prose); }
    .prose p + p { margin-top: var(--space-3); }
    .meta, .supporting-text { color: var(--muted); font: var(--text-meta); }
    .muted { color: var(--muted); }
    .strong { color: var(--ink); font-weight: var(--weight-strong); }
    .code { font: var(--text-code); }
    .count { color: var(--muted); font-weight: var(--weight-regular); font-variant-numeric: tabular-nums; }
    .you { color: var(--muted); font-weight: var(--weight-regular); }
    .danger-text { color: var(--danger); font-weight: var(--weight-medium); }
    .auth-kicker, .kicker { margin: 0 0 var(--space-2); color: var(--muted); font: var(--text-meta); font-weight: var(--weight-medium); }
    .shelf-label { margin: var(--space-3) 0 var(--space-1); color: var(--muted); font: var(--text-badge); }
    .auth-email { color: var(--ink); font-weight: var(--weight-strong); overflow-wrap: anywhere; }
    .verification-code { max-width: none; color: var(--ink); font: var(--text-display-code); letter-spacing: .08em; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .copy-address { user-select: all; overflow-wrap: anywhere; }
    .code-panel { max-height: 18rem; white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 639px) {
      .title, .page-heading { font: var(--text-title-phone); }
    }
`;
