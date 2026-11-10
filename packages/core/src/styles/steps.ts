/**
 * Steps and flows. Setup steps (at most three) are numbers in circles with no connecting lines:
 * done is ink, current is yellow, later is muted. A flow's sections are numbered by their heading
 * alone, in the order the task goes.
 */
export const steps = `
    .steps { display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; margin: var(--space-5) 0 0; padding: 0; list-style: none; }
    .step { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 0 14px; color: var(--muted); }
    .step-marker {
      display: grid; place-items: center; width: 28px; height: 28px;
      border: 1.5px solid var(--border-strong); border-radius: 50%;
      background: var(--surface); color: var(--muted);
      font: var(--text-meta); font-weight: var(--weight-strong); font-variant-numeric: tabular-nums;
    }
    .step-current .step-marker { border-color: var(--ink); background: var(--yellow); color: var(--ink); }
    .step-done .step-marker { border-color: var(--ink); background: var(--ink); color: var(--surface); }
    .step-title { margin: 3px 0 var(--space-1); color: var(--muted); font: var(--text-section); }
    .step-done, .step-current { color: var(--text); }
    .step-done .step-title, .step-current .step-title { color: var(--ink); }
    .step-title + p { margin: 0; }
    .step-card { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); margin-top: var(--space-3); padding: var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--r-container); background: var(--sunken); }
    .step-card > * { margin: 0; }
    .step-card summary { color: var(--link); font-weight: var(--weight-medium); cursor: pointer; }
    .step-card details p { margin: 6px 0 0; }

    .flow { display: grid; grid-template-columns: minmax(0, 1fr); gap: 40px; }
    .flow-section, .form-step { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
    .form-step { margin-top: var(--space-6); }
    .flow-title, .form-step-title { display: flex; align-items: baseline; gap: 10px; margin: 0; padding: 0; color: var(--ink); font: var(--text-section); }
    .flow-number, .form-step-number { color: var(--muted); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
    .form-step:disabled :is(.form-step-title, .field-label, .field-hint, .supporting-text) { color: var(--muted); }

    /* agent-preview: an illustration of what an agent will say back, never a live transcript. */
    .agent-preview { padding: 14px var(--space-4); border-radius: var(--r-container); background: var(--ink); color: var(--paper); font: var(--text-code); overflow-wrap: anywhere; }
    .agent-preview p { max-width: none; margin: 0; }
    .agent-preview p + p { margin-top: var(--space-2); }
    .agent-preview strong, .agent-preview-you { color: var(--yellow); }
    .agent-preview-said { color: var(--green); }
`;
