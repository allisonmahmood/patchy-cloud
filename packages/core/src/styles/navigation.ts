/**
 * Moving and narrowing: underline tabs between an object's pages, a segmented control to filter a
 * list, chips to filter a log. Three jobs, three looks; every one is a link with a URL.
 */
export const navigation = `
    .tabs { display: flex; gap: var(--space-1); margin: 0 0 var(--space-5); overflow-x: auto; border-bottom: 1px solid var(--border); }
    .tabs a, .tab {
      position: relative; display: inline-flex; align-items: center; gap: 6px;
      min-height: var(--h-tab); margin-bottom: -1px; padding: 0 10px;
      border-bottom: 2px solid transparent;
      color: var(--muted); font: var(--text-label); text-decoration: none; white-space: nowrap;
    }
    /* The strip scrolls, which clips anything outside it, so its links ring themselves inside. */
    .tabs a:focus-visible, .tab:focus-visible, .seg a:focus-visible { outline-offset: -2px; }
    .tabs a[aria-current], .tab[aria-current] { border-bottom-color: var(--ink); color: var(--ink); font-weight: var(--weight-strong); }
    @media (hover: hover) { .tabs a:not([aria-current]):hover { color: var(--ink); } }
    .tabs a[aria-current] .count { color: var(--muted); }

    .seg {
      display: inline-flex; flex: none; gap: 2px; max-width: 100%; padding: 2px; overflow-x: auto;
      border: 1px solid var(--border-strong); border-radius: 8px; background: var(--sunken);
    }
    .seg a {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: var(--h-seg); padding: 0 10px; border-radius: var(--r-control);
      color: var(--text); font: var(--text-meta); font-weight: var(--weight-medium); text-decoration: none; white-space: nowrap;
    }
    .seg a[aria-current] { background: var(--surface); box-shadow: 0 0 0 1px var(--ink); color: var(--ink); font-weight: var(--weight-strong); }

    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); min-width: 0; margin-bottom: var(--space-4); }
    .toolbar > .grow { margin-left: auto; }
    @media (max-width: 639px) { .toolbar > .grow { width: 100%; margin-left: 0; } }

    .chip {
      display: inline-flex; align-items: center; gap: 6px;
      min-height: var(--h-chip); padding: 0 var(--space-2) 0 10px;
      border: 1px solid var(--border-strong); border-radius: var(--r-round);
      background: var(--surface); color: var(--text);
      font: var(--text-meta); font-weight: var(--weight-medium); text-decoration: none; white-space: nowrap;
    }
    .chip svg { width: 14px; height: 14px; }
    .chip-key { color: var(--muted); font-weight: var(--weight-regular); }
    .chip[aria-current], .chip-on { border-color: var(--ink); background: var(--selected); color: var(--ink); }

    .pagination { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-top: var(--space-4); color: var(--muted); font: var(--text-meta); }
`;
