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

    .flow { display: grid; grid-template-columns: minmax(0, 1fr); gap: 40px; }
    .flow-section { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
    .flow-title { display: flex; align-items: baseline; gap: 10px; margin: 0; padding: 0; color: var(--ink); font: var(--text-section); }
    .flow-number { color: var(--muted); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
`;
