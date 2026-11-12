/**
 * `changeBar`: a form's unsaved changes, stuck to the bottom of the form while it scrolls. Inked
 * and lifted, as it floats over the rows it counts. The enhancer hides it while nothing changed.
 */
export const changeBar = `
    .change-bar {
      position: sticky; bottom: var(--space-3); z-index: 5;
      display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3);
      padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
      border: 2px solid var(--ink); border-radius: var(--r-container);
      background: var(--surface); box-shadow: var(--float);
    }
    .change-bar[hidden] { display: none; }
    .change-bar-summary { flex: 1; min-width: 0; margin: 0; color: var(--ink); font-weight: var(--weight-medium); }
`;
