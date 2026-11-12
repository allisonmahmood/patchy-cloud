/** A flat directory grid; phones keep the same links as compact single-column cards. */
export const directoryCards = `
    .directory-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); margin: 0; padding: 0; list-style: none; }
    .directory-cards > li { min-width: 0; }
    .directory-card {
      display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2);
      height: 100%; min-width: 0; padding: var(--space-4);
      border: 1px solid var(--border); border-radius: var(--r-container);
      background: var(--surface); color: var(--ink); text-decoration: none; font-weight: var(--weight-regular);
    }
    .directory-card-copy { display: grid; gap: var(--space-1); min-width: 0; overflow-wrap: anywhere; }
    .directory-card-preview { display: flex; gap: var(--space-1); margin-top: var(--space-1); }
    .directory-card-action { display: flex; align-items: center; gap: var(--space-2); margin-top: auto; padding-top: var(--space-2); color: var(--muted); font: var(--text-meta); }
    .directory-card-action svg { width: var(--space-4); height: var(--space-4); }
    @media (hover: hover) { .directory-card:hover { border-color: var(--ink); background: linear-gradient(var(--hover), var(--hover)) var(--surface); } }
    @media (max-width: 1100px) { .directory-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 639px) {
      .directory-cards { grid-template-columns: minmax(0, 1fr); gap: var(--space-2); }
      .directory-card { flex-direction: row; align-items: center; gap: var(--space-3); }
      .directory-card-copy { flex: 1; }
      .directory-card-preview, .directory-card-label { display: none; }
      .directory-card-action { margin-top: 0; padding-top: 0; }
    }
`;
