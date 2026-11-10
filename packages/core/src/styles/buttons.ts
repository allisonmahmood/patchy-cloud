/**
 * Buttons: 2px ink edges, because they are pressed. Primary is blue and lifted, one per region;
 * secondary is plain; quiet has no frame; danger is the destructive tone and danger-solid the
 * final destructive step. A press sinks into the shadow; nothing spins. Pending is static text on
 * the pressed button with `aria-disabled`.
 */
export const buttons = `
    .btn {
      position: relative;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      max-width: 100%; min-height: var(--h-control); padding: 6px 14px;
      border: 2px solid var(--ink); border-radius: var(--r-control);
      background: var(--surface); color: var(--ink);
      font: var(--text-label);
      text-align: center; text-decoration: none; overflow-wrap: anywhere;
      cursor: pointer;
      transition: transform .12s, box-shadow .12s;
    }
    .btn svg { width: 16px; height: 16px; flex: none; }
    .btn-primary { background: var(--blue); color: var(--on-blue); box-shadow: var(--lift); }
    .btn-quiet { padding-inline: 10px; border-color: transparent; background: transparent; }
    .btn-danger { border-color: var(--danger); color: var(--danger); }
    .btn-danger-solid { border-color: var(--ink); background: var(--danger-solid); color: var(--on-blue); box-shadow: var(--lift); }
    .btn-quiet.btn-danger { border-color: transparent; background: transparent; }
    .btn-sm { min-height: var(--h-sm); padding: 5px 10px; font: var(--text-meta); font-weight: var(--weight-medium); }
    .btn-icon { width: var(--h-sm); min-height: var(--h-sm); padding: 0; border-color: transparent; background: transparent; color: var(--text); }
    .btn-icon.btn-md { width: var(--h-control); min-height: var(--h-control); }
    .btn-block { width: 100%; }
    @media (hover: hover) {
      .btn:not(.btn-quiet, .btn-icon, :disabled, [aria-disabled="true"]):hover { transform: translate(-1px, -1px); box-shadow: var(--lift); }
      .btn-primary:not(:disabled, [aria-disabled="true"]):hover { background: var(--blue-hover); box-shadow: var(--lift-tile); }
      .btn-danger-solid:not(:disabled, [aria-disabled="true"]):hover { box-shadow: var(--lift-tile); }
      .btn-danger:not(.btn-quiet):hover { background: var(--danger-bg); }
      .btn-quiet:hover, .btn-icon:hover { background: var(--hover); }
    }
    .btn:not(.btn-quiet, .btn-icon, :disabled, [aria-disabled="true"]):active { transform: translate(2px, 2px); box-shadow: none; }
    .btn-quiet:has(+ .menu:popover-open), .btn-icon:has(+ .menu:popover-open) { background: var(--hover); }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .btn[aria-disabled="true"] { cursor: progress; }
    .btn-group, .actions, .confirmation-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    .actions, .confirmation-actions { margin-top: var(--space-5); }
    .btn-group-end { justify-content: flex-end; }
`;
