/**
 * The signed-in frame: a sidebar of places beside the page. Below 900px the sidebar folds into a
 * bar whose Menu button opens the same markup as a popover, so there is one nav and no script.
 */
export const appShell = `
    .app { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
    .app-side { border-right: 1px solid var(--border); background: var(--surface); }
    /* The sidebar's column runs the page's full height; its contents stay in view as the page scrolls. */
    .app-side-inner { position: sticky; top: 0; display: flex; flex-direction: column; gap: var(--space-3); height: 100vh; padding: 14px var(--space-3) var(--space-3); overflow-y: auto; }
    .app-side-inner > .brand { min-height: var(--h-control); padding: 0 6px; overflow-wrap: anywhere; }
    .app-menu-button { display: none; }
    /* app-menu: the search, places and foot. On a phone it is the Menu button's popover; wider, an
       author display outranks the browser's rule hiding a closed popover, so it shows in place. */
    .app-menu { position: static; inset: auto; display: flex; flex: 1; flex-direction: column; gap: var(--space-3); width: auto; height: auto; margin: 0; padding: 0; overflow: visible; border: 0; background: transparent; color: inherit; }
    .app-search .field { min-height: var(--h-sm); font-size: 13px; }
    .app-nav { display: grid; gap: 2px; }
    /* app-place: one place in the sidebar, lit while the page belongs to it. The foot's buttons share its look. */
    .app-place {
      display: flex; align-items: center; gap: 10px;
      width: 100%; min-height: var(--h-sm); padding: 0 var(--space-2);
      border: 1px solid transparent; border-radius: var(--r-control);
      background: transparent; color: var(--text);
      font: var(--text-label); text-align: left; text-decoration: none; cursor: pointer;
    }
    @media (hover: hover) { .app-place:hover { background: var(--hover); color: var(--ink); } }
    .app-place[aria-current="page"] { border-color: var(--ink); background: var(--selected); color: var(--ink); font-weight: var(--weight-strong); }
    .app-group { display: grid; gap: 2px; margin-top: var(--space-3); }
    .app-group-label { margin: 0 var(--space-2) var(--space-1); color: var(--muted); font: var(--text-badge); }
    .app-foot { display: grid; gap: 2px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border-subtle); }
    .app-account { min-height: var(--h-control); }
    .app-account .avatar { width: 26px; height: 26px; font-size: 10px; }
    .app-account-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .app-account svg { color: var(--muted); }
    .app-account-menu .menu-head strong { color: var(--ink); }
    @supports (position-area: bottom) {
      .app-account-menu { position-area: top span-right; position-try-fallbacks: flip-block; }
    }
    .app-page { min-width: 0; max-width: calc(var(--w-index) + 80px); padding: 28px 40px 72px; overflow-wrap: anywhere; }
    /* A Menu opened on a phone stays open in the top layer if the window widens; it then sits where
       the in-place menu would, under the brand, until dismissed. */
    @media (min-width: 900px) {
      .app-menu:popover-open { position: fixed; inset: 64px auto 0 0; width: 240px; height: auto; padding: 0 var(--space-3) var(--space-3); overflow-y: auto; border: 0; border-right: 1px solid var(--border); background: var(--surface); }
      .app-menu::backdrop { background: transparent; }
    }
    @media (max-width: 899px) {
      .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: max-content minmax(0, 1fr); }
      .app-side { position: sticky; top: 0; z-index: 10; border-right: 0; border-bottom: 1px solid var(--border); }
      .app-side-inner { position: static; flex-direction: row; align-items: center; justify-content: space-between; height: auto; min-height: 52px; padding: 0 var(--space-3) 0 var(--space-4); overflow: visible; }
      .app-menu-button { display: inline-flex; gap: 6px; }
      .app-menu:not(:popover-open) { display: none; }
      /* The gutter left of the sheet is the backdrop a tap lands on to close it, even at 320px. */
      .app-menu:popover-open { position: fixed; inset: 0 0 0 auto; width: min(320px, calc(100vw - 48px)); height: 100dvh; padding: 14px var(--space-3) var(--space-3); overflow-y: auto; border: 0; border-left: 2px solid var(--ink); background: var(--surface); }
      .app-menu::backdrop { background: var(--scrim); }
      .app-page { padding: 20px 20px 56px; }
    }
    @media (max-width: 639px) { .app-page { padding: var(--space-4) var(--space-4) var(--space-7); } }
`;
