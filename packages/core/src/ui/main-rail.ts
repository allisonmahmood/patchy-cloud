/**
 * A main column with a narrow rail beside it, such as Home's Tools with its Pages. Below 1024px,
 * where the sidebar folds, the rail follows the main column. `main` and `rail` are trusted HTML.
 */
export const mainWithRail = (spec: { readonly main: string; readonly rail: string }) =>
  `<div class="main-rail"><div class="main-rail-main">${spec.main}</div><div class="main-rail-rail">${spec.rail}</div></div>`;
