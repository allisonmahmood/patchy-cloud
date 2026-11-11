/**
 * Menus: a native popover of links and buttons, right after the button whose popovertarget
 * opens it. It floats, so it has the ink edge and the hard shadow. Where the browser anchors a
 * popover to its invoker the menu drops under the button; elsewhere it opens centred and its
 * menu-head names whose actions they are.
 */
export const menus = `
    .menu {
      min-width: 220px; margin: auto; padding: var(--space-1);
      border: 2px solid var(--ink); border-radius: var(--r-container);
      background: var(--surface); color: var(--ink); box-shadow: var(--float);
      text-align: left; white-space: normal;
    }
    @supports (position-area: bottom) {
      .menu { inset: auto; margin: 6px 0; position-area: bottom span-left; position-try-fallbacks: flip-block; }
    }
    .menu form { margin: 0; }
    .menu-head { max-width: none; margin: 0; padding: var(--space-2) 10px 6px; color: var(--muted); font: var(--text-badge); font-weight: var(--weight-regular); overflow-wrap: anywhere; }
    .menu-head strong { display: block; color: var(--ink); font: var(--text-meta); font-weight: var(--weight-strong); }
    .menu-item {
      display: flex; align-items: center; gap: 10px;
      width: 100%; min-height: var(--h-sm); padding: 0 10px;
      border: 0; border-radius: var(--r-control);
      background: transparent; color: var(--ink);
      font: var(--text-meta); font-weight: var(--weight-medium);
      text-align: left; text-decoration: none; cursor: pointer;
    }
    .menu-item svg { width: 16px; height: 16px; color: var(--muted); }
    @media (hover: hover) { .menu-item:hover { background: var(--hover); } }
    .menu-item-danger, .menu-item-danger svg { color: var(--danger); }
    /* A setting's item is the switch: role="switch" on the item, its drawing at the end. */
    .menu-item > .switch { margin-left: auto; }
    /* A Copy item waits hidden for the page's copy script, so a menu without script offers only what works. */
    .menu-item[hidden] { display: none; }
    .menu-rule { height: 1px; margin: var(--space-1) calc(-1 * var(--space-1)); border: 0; background: var(--border-subtle); }
`;
