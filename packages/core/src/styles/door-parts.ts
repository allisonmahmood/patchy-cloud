/**
 * What only doors hold: the code a person compares, who meets whom before consent, the can and
 * can't list, two answers of equal weight, a form's fields set apart from the words above them,
 * a refusal's focus target, and a sign-out form that sits in the foot's line.
 */
export const doorParts = `
    .code-display {
      display: flex; justify-content: center;
      max-width: none; margin: var(--space-4) 0; padding: var(--space-4);
      border: 1px solid var(--border); border-radius: var(--r-container);
      background: var(--sunken); color: var(--ink);
      font: var(--text-display-code); letter-spacing: .08em; font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    @media (max-width: 379px) { .code-display { letter-spacing: .02em; } }

    .meet {
      display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 10px;
      margin: var(--space-4) 0; padding: 14px;
      border: 1px solid var(--border); border-radius: var(--r-container); background: var(--sunken);
    }
    .meet-party { display: grid; justify-items: center; gap: 6px; min-width: 0; text-align: center; }
    .meet-party .meta { overflow-wrap: anywhere; }
    .meet-party > .agent-mark, .meet-party > .avatar { width: 44px; height: 44px; border: 2px solid var(--ink); box-shadow: none; }
    .meet-party > .agent-mark { border-radius: var(--r-container); }
    .meet-party > .agent-mark svg { width: 22px; height: 22px; }
    .meet-arrow { color: var(--muted); }
    .meet-arrow svg { display: block; width: 16px; height: 16px; }

    .can { display: grid; gap: var(--space-2); margin: var(--space-4) 0; padding: 0; list-style: none; }
    .can > li { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 10px; align-items: start; }
    .can svg { width: 16px; height: 16px; margin-top: 2px; }
    .can-yes svg { color: var(--success); }
    .can-no svg { color: var(--danger); }

    .btn-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-2); width: 100%; }

    .door-body > form:has(.fieldset) { margin-top: var(--space-5); }
    /* refusal: where the page's focus starts, read first and never drawn as a control. */
    .refusal:focus { outline: none; }
    .door-foot form { display: inline; }
    .door-foot .btn-sm { vertical-align: baseline; }
`;
