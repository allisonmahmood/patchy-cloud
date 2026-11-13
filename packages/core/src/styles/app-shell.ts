/**
 * The signed-in frame: a sidebar beside the page, with the brand, the patch search, New patch, the
 * places and a foot of What's new and the account. Below 1024px the sidebar folds into a top bar
 * of the brand, the search (an icon until it has focus) and Menu, whose popover is the rest of the
 * same markup, so there is one nav and no script. The page's anchors land below that bar.
 */
export const appShell = `
    .app { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
    .app-side { border-right: 1px solid var(--border); background: var(--surface); }
    /* The sidebar's column runs the page's full height; its contents stay in view as the page scrolls. */
    .app-side-inner { position: sticky; top: 0; display: flex; flex-direction: column; gap: var(--space-2); height: 100vh; padding: 14px var(--space-3) var(--space-3); overflow-y: auto; }
    .app-side-inner > .brand { min-height: var(--h-control); padding: 0 6px; }
    .brand-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .app-search .field-group > input { min-height: calc(var(--h-sm) - 2px); }
    .app-menu-button, .app-menu-opened { display: none; }
    /* app-menu: New patch, the places and the foot. On a narrow window it is the Menu button's
       popover; wider, an author display outranks the browser's rule hiding a closed popover, so it
       shows in place. */
    .app-menu { position: static; inset: auto; display: flex; flex: 1; flex-direction: column; gap: var(--space-4); width: auto; height: auto; margin: 0; padding: 0; overflow: visible; border: 0; background: transparent; color: inherit; }
    .app-nav { display: grid; gap: 2px; }
    /* app-place: one place in the sidebar, lit while the page belongs to it. The foot's buttons share its look. */
    .app-place {
      display: flex; align-items: center; gap: 10px;
      width: 100%; min-height: var(--h-sm); padding: 0 var(--space-2);
      border: 1px solid transparent; border-radius: var(--r-control);
      background: transparent; color: var(--text);
      font: var(--text-label); text-align: left; text-decoration: none; cursor: pointer;
    }
    .app-place > svg { flex: none; width: 16px; height: 16px; color: var(--muted); }
    @media (hover: hover) { .app-place:hover { background: var(--hover); color: var(--ink); } }
    .app-place[aria-current="page"] { border-color: var(--ink); background: var(--selected); color: var(--ink); font-weight: var(--weight-strong); }
    /* Settings, open around one of its pages, which the subnav lights. */
    .app-place-open { color: var(--ink); font-weight: var(--weight-strong); }
    .app-place[aria-current="page"] > svg, .app-place-open > svg { color: var(--ink); }
    .app-place-end { display: inline-flex; margin-left: auto; color: var(--muted); }
    .app-place-end > svg { width: 14px; height: 14px; }
    /* The line runs under the place's icon, so its pages read as inside it. */
    .app-subnav { display: grid; gap: 2px; margin: 0 0 var(--space-1) 17px; padding-left: 9px; border-left: 1px solid var(--border); }
    .app-subnav > .app-place { padding-left: 10px; }

    .app-pins { min-height: 0; }
    .app-pins > h2 { margin: 0 var(--space-2) var(--space-2); color: var(--muted); font: var(--text-meta); font-weight: var(--weight-strong); }
    .app-pin-list { max-height: calc(5 * var(--h-control)); margin: 0; padding: 0; overflow-y: auto; overscroll-behavior: contain; list-style: none; scrollbar-width: thin; border: 1px solid var(--border); border-radius: var(--r-control); }
    .app-pin { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; min-height: var(--h-control); }
    .app-pin-link { display: flex; align-items: center; gap: var(--space-2); min-width: 0; min-height: var(--h-control); padding: var(--space-1) var(--space-2); color: var(--ink); font: var(--text-label); text-decoration: none; }
    .app-pin-link > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .app-pin-link :is(.mono, .page-mark) { width: var(--space-5); height: var(--space-5); font: var(--text-badge); }
    .app-pin > .btn { width: var(--h-sm); height: var(--h-sm); }
    @media (hover: hover) { .app-pin:has(.app-pin-link:hover) { background: var(--hover); } }

    .app-foot { display: grid; gap: 2px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border-subtle); }
    .app-place > .whats-new-dot { margin-left: auto; }
    /* While its panel is open, What's new takes a current place's look; the account, a hovered one's. */
    .whats-new-bell:has(+ .app-whats-new:popover-open) { border-color: var(--ink); background: var(--selected); color: var(--ink); }
    .app-account:has(+ .app-account-menu:popover-open) { background: var(--hover); color: var(--ink); }
    .whats-new-bell { anchor-name: --whats-new; }
    .app-account { min-height: var(--h-control); anchor-name: --account; color: var(--ink); }
    .app-account .avatar { width: 26px; height: 26px; font-size: 10px; }
    .app-account-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The foot's menus open above their button, across the sidebar's edge if they need to. */
    @supports (position-area: bottom) {
      .app-foot-menu { margin: 0 0 6px; position-area: top span-right; position-try-fallbacks: flip-block; }
      .app-whats-new { position-anchor: --whats-new; }
      .app-account-menu { position-anchor: --account; }
    }
    /* Wide enough for its switch's label on one line. */
    .app-account-menu { width: 248px; }
    .app-whats-new { width: min(360px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; }
    /* Headlines only: the kind in muted text, then the change's title. */
    .app-headlines { display: grid; margin: 0; padding: 0; list-style: none; }
    .app-headline { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: var(--space-2); align-items: baseline; align-content: center; min-height: var(--h-sm); padding: 6px 10px; border-radius: var(--r-control); color: var(--ink); font: var(--text-meta); text-decoration: none; }
    @media (hover: hover) { .app-headline:hover { background: var(--hover); } }
    .app-headline-kind { color: var(--muted); font: var(--text-badge); font-weight: var(--weight-regular); }
    .app-whats-new .menu-item > svg { width: 14px; height: 14px; }
    /* Tell Patchy: the same frame, beside whichever button opened it, its form, then the answer
       to a send: the receipt and, for a request, its similar requests stacked under it. */
    .app-side-inner:has(> .app-tell-patchy:popover-open) .tell-patchy-button { border-color: var(--ink); background: var(--selected); color: var(--ink); }
    @supports (position-area: bottom) {
      .app-tell-patchy { position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline; }
    }
    .app-tell-patchy { width: min(360px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; }
    .app-tell-patchy .menu-item > svg { width: 14px; height: 14px; }
    .app-tell-body { display: grid; gap: var(--space-3); padding: var(--space-1) 10px var(--space-3); }
    .app-tell-form:not([hidden]), .app-tell-answer:not([hidden]) { display: grid; gap: var(--space-3); }
    .app-tell-answer:focus { outline: none; }
    .app-tell-body :is(.receipt, .notice, .shelf-label) { margin: 0; }
    .app-tell-body .row { grid-template-columns: minmax(0, 1fr); gap: var(--space-2); padding-inline: 0; }
    .app-tell-body .row-end { justify-self: start; }

    .app-page { min-width: 0; max-width: calc(var(--w-index) + 80px); padding: 28px 40px 72px; overflow-wrap: anywhere; }
    /* A Menu opened on a narrow window stays open in the top layer if the window widens; it then
       sits where the in-place menu would, under the brand and the search, until dismissed. */
    @media (min-width: 1024px) {
      .app-menu:popover-open { position: fixed; inset: calc(14px + var(--h-control) + var(--h-sm) + 2 * var(--space-2)) auto 0 0; width: 240px; height: auto; padding: 0 var(--space-3) var(--space-3); overflow-y: auto; border: 0; border-right: 1px solid var(--border); background: var(--surface); }
      .app-menu::backdrop { background: transparent; }
    }
    @media (max-width: 1023px) {
      .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: max-content minmax(0, 1fr); }
      .app-side { position: sticky; top: 0; z-index: 10; border-right: 0; border-bottom: 1px solid var(--border); }
      /* A fragment, such as a change's permalink, lands below the bar rather than under it. */
      :root:has(.app-side) { scroll-padding-top: calc(var(--h-control) + var(--space-4) + 1px); }
      .app-side-inner { position: relative; flex-direction: row; align-items: center; gap: var(--space-1); height: auto; min-height: calc(var(--h-control) + var(--space-4)); padding: 0 var(--space-3) 0 var(--space-4); overflow: visible; }
      .app-side-inner > .brand { flex: 1; min-width: 0; padding: 0; }
      .app-menu-button { display: inline-flex; }
      .app-menu-closed, .app-side-inner:has(> .app-menu:popover-open) .app-menu-opened { display: inline-flex; align-items: center; gap: 6px; }
      .app-side-inner:has(> .app-menu:popover-open) .app-menu-closed { display: none; }
      .app-menu-button svg { width: 16px; height: 16px; }
      /* The search waits as its icon, which is its label, so a press focuses the field and it
         opens across the bar until focus leaves it. */
      .app-search { flex: none; }
      .app-search:not(:focus-within) .field-group { width: var(--h-control); border-color: transparent; background: transparent; cursor: pointer; }
      .app-search:not(:focus-within) .field-prefix { justify-content: center; width: 100%; padding: 0; color: var(--text); cursor: pointer; }
      .app-search:not(:focus-within) .field-group > input { flex: 0 0 0; width: 0; min-width: 0; padding: 0; opacity: 0; }
      @media (hover: hover) { .app-search:not(:focus-within) .field-group:hover { background: var(--hover); } }
      .app-search:focus-within { position: absolute; z-index: 1; inset: 0 var(--space-3) 0 var(--space-4); display: flex; align-items: center; background: var(--surface); }
      .app-search:focus-within > .field-group { flex: 1; }
      /* The Menu's popover opens under the bar, which stays to close it. */
      .app-menu:not(:popover-open) { display: none; }
      .app-menu:popover-open { position: fixed; inset: calc(var(--h-control) + var(--space-4) + 1px) 0 0 0; width: auto; height: auto; padding: var(--space-4); overflow-y: auto; border: 0; background: var(--surface); }
      .app-menu::backdrop { background: transparent; }
      .app-page { padding: 20px 20px 56px; }
    }
    @media (max-width: 639px) { .app-page { padding: var(--space-4) var(--space-4) var(--space-7); } }
`;
