/**
 * What `HotkeySheet` draws from: its sections and its default styles. Internal: `hotkeys.ts`
 * exports the component.
 */
import type { ListedHotkey } from "./hotkeys.js";

/**
 * The sheet's sections: named groups in the order they are first seen, then the ungrouped under
 * General. When no hotkey has a group, one section with no name.
 */
export const sections = (
  list: ReadonlyArray<ListedHotkey>
): Array<[name: string | undefined, rows: ListedHotkey[]]> => {
  const groups = new Map<string, ListedHotkey[]>();
  const ungrouped: ListedHotkey[] = [];
  for (const item of list) {
    if (item.group === undefined) ungrouped.push(item);
    else groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  if (groups.size === 0) return [[undefined, ungrouped]];
  if (ungrouped.length > 0) groups.set("General", [...(groups.get("General") ?? []), ...ungrouped]);
  return [...groups];
};

// Only --look-* tokens, so the sheet follows the company look, each with a system colour for a
// page without one. The layer, added after the look's, beats the look's element styles and loses
// to the patch's own unlayered CSS.
const styles = `@layer patchy-hotkeys {
  .hotkey-opener {
    box-sizing: border-box;
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
    width: 2.75rem;
    height: 2.75rem;
    min-height: 0;
    margin: 0;
    padding: 0;
    border: 2px solid var(--look-border, CanvasText);
    border-bottom-width: 4px;
    border-radius: min(var(--look-radius, 8px), 8px);
    background: var(--look-surface, Canvas);
    color: var(--look-fg, CanvasText);
    font: 800 1.05rem/1 var(--look-font-body, system-ui, sans-serif);
    cursor: pointer;
  }

  /* The dialog is the layer over the page: its background is the scrim, and the card sits in it. */
  .hotkey-sheet-dialog {
    box-sizing: border-box;
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    margin: 0;
    padding: calc(var(--look-space, 8px) * 4);
    border: 0;
    overflow: auto;
    overscroll-behavior: contain;
    background: color-mix(in srgb, var(--look-bg, Canvas) 72%, transparent);
    color: var(--look-fg, CanvasText);
    font-family: var(--look-font-body, system-ui, sans-serif);
  }
  .hotkey-sheet-dialog[open] {
    display: flex;
  }
  .hotkey-sheet-dialog::backdrop {
    background: none;
  }
  .hotkey-sheet {
    box-sizing: border-box;
    width: min(100%, 48rem);
    margin: auto;
    padding: calc(var(--look-space, 8px) * 3);
    border: 2px solid var(--look-border, CanvasText);
    border-radius: var(--look-radius, 8px);
    background: var(--look-surface, Canvas);
    box-shadow: calc(var(--look-space, 8px) * 0.5) calc(var(--look-space, 8px) * 0.5) 0
      var(--look-border, CanvasText);
  }
  /* One column needs no more than a column's width. */
  .hotkey-sheet:where(:has(.hotkey-groups > :only-child)) {
    width: min(100%, 28rem);
  }
  .hotkey-sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(var(--look-space, 8px) * 2);
    margin-bottom: calc(var(--look-space, 8px) * 3);
  }
  .hotkey-sheet-head h2 {
    margin: 0;
    font-size: 1.35rem;
    line-height: 1.1;
  }
  .hotkey-sheet-close {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    min-height: 0;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: min(var(--look-radius, 8px), 8px);
    background: none;
    color: var(--look-fg, CanvasText);
    font: 750 0.9rem/1 var(--look-font-body, system-ui, sans-serif);
    cursor: pointer;
  }
  .hotkey-sheet-close kbd {
    height: 1.6rem;
    font-size: 0.8rem;
  }
  .hotkey-sheet-close-word {
    display: none;
  }

  .hotkey-groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: calc(var(--look-space, 8px) * 2) calc(var(--look-space, 8px) * 4);
    align-items: start;
  }
  .hotkey-group h3 {
    margin: 0;
    padding-bottom: calc(var(--look-space, 8px) * 0.75);
    border-bottom: 2px solid var(--look-border, CanvasText);
    color: var(--look-muted, GrayText);
    font: 750 0.82rem/1.3 var(--look-font-body, system-ui, sans-serif);
    letter-spacing: 0.01em;
  }
  .hotkey-group ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .hotkey-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(var(--look-space, 8px) * 2);
    min-height: 2.6rem;
    border-bottom: 1px solid color-mix(in srgb, var(--look-border, CanvasText) 22%, transparent);
  }
  .hotkey-row:last-child {
    border-bottom: 0;
  }
  .hotkey-label {
    font-size: 0.94rem;
  }
  .hotkey-keys {
    display: inline-flex;
    align-items: center;
    gap: 0.25em;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .hotkey-then {
    margin: 0 0.35em;
    color: var(--look-muted, GrayText);
    font-size: 0.78rem;
  }
  .hotkey-sheet-dialog kbd {
    box-sizing: border-box;
    display: inline-grid;
    place-items: center;
    min-width: 1.4rem;
    height: 1.4rem;
    padding: 0 0.35rem;
    border: 1.5px solid
      color-mix(in srgb, var(--look-border, CanvasText) 70%, var(--look-fg, CanvasText));
    border-bottom-width: 3px;
    border-radius: min(var(--look-radius, 8px), 6px);
    background: var(--look-bg, Canvas);
    color: var(--look-fg, CanvasText);
    font: 700 0.76rem/1 var(--look-font-body, system-ui, sans-serif);
  }
  .hotkey-sheet-dialog kbd.hotkey-symbol {
    font-size: 0.95rem;
    font-weight: 600;
  }

  /* A phone: the sheet rises from the bottom edge, and its close button is a word to tap. */
  @media (max-width: 520px) {
    .hotkey-sheet-dialog {
      padding: 0;
    }
    .hotkey-sheet {
      width: 100%;
      max-height: 84%;
      overflow: auto;
      margin: auto 0 0;
      padding: calc(var(--look-space, 8px) * 2.5);
      border-width: 2px 0 0;
      border-radius: var(--look-radius, 8px) var(--look-radius, 8px) 0 0;
      box-shadow: none;
    }
    .hotkey-sheet-head {
      margin-bottom: calc(var(--look-space, 8px) * 2);
    }
    .hotkey-groups {
      grid-template-columns: 1fr;
      gap: calc(var(--look-space, 8px) * 2.5);
    }
    .hotkey-sheet-close {
      min-height: 2.75rem;
      padding: 0 calc(var(--look-space, 8px) * 1.75);
      border: 2px solid var(--look-border, CanvasText);
      background: var(--look-surface, Canvas);
    }
    .hotkey-sheet-close kbd {
      display: none;
    }
    .hotkey-sheet-close-word {
      display: inline;
    }
  }
}
`;

let styled = false;

/** Adds the sheet's default styles to the page, once, after whatever styles it already has. */
export const addSheetStyles = (): void => {
  if (styled) return;
  styled = true;
  const style = document.createElement("style");
  style.textContent = styles;
  document.head.append(style);
};
