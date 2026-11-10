/**
 * Dialogs: a URL rendered over its page, which goes inert behind a static scrim. Modal elevation,
 * the deepest shadow there is. On a phone a dialog is a bottom sheet.
 */
export const dialogs = `
    .app[inert] { user-select: none; }
    .modal-scrim { position: fixed; inset: 0; z-index: 40; background: var(--scrim); }
    .dialog, .modal-panel {
      position: fixed; top: 72px; left: 50%; z-index: 41;
      width: min(var(--w-dialog), calc(100% - 32px)); max-height: calc(100dvh - 120px); overflow-y: auto;
      border: 2px solid var(--ink); border-radius: var(--r-modal);
      background: var(--surface); box-shadow: var(--modal);
      transform: translateX(-50%);
    }
    .modal-panel { top: 40px; width: min(640px, calc(100% - 32px)); max-height: calc(100dvh - 64px); padding: var(--space-5); }
    .dialog-md { width: min(var(--w-dialog-md), calc(100% - 32px)); }
    .dialog-head { display: flex; align-items: flex-start; gap: var(--space-3); padding: 20px 20px 0 var(--space-5); }
    .dialog-head > h2 { flex: 1; margin: 0; padding-top: 2px; color: var(--ink); font: var(--text-title-sm); }
    .dialog-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); padding: var(--space-4) var(--space-5) var(--space-5); }
    .dialog-body > * { margin: 0; }
    .dialog-foot {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--space-2);
      padding: var(--space-3) var(--space-4) var(--space-3) var(--space-5);
      border-top: 1px solid var(--border-subtle); border-radius: 0 0 var(--r-modal) var(--r-modal); background: var(--sunken);
    }
    .dialog-foot > .dialog-foot-start { margin-right: auto; }
    @media (max-width: 639px) {
      .dialog, .modal-panel {
        top: auto; right: 0; bottom: 0; left: 0; width: auto; max-height: 88dvh;
        border-radius: var(--r-modal) var(--r-modal) 0 0; box-shadow: none; transform: none;
      }
    }
`;
