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

// The sheet's defaults, after the page's own styles, in two layers:
// - The `?` button's defaults sit in a layer inside the company look's, beneath the look's own
//   rules, so the page's layered button styles, the look's included, make it one of its buttons.
// - The sheet's drawing sits in a layer declared after the page's existing ones. It first reverts
//   the sheet's parts past every author layer, so nothing in those layers reaches them, then draws
//   them from the look's tokens. Focus rings alone come back from the page's layers.
// On a page without a look, a token used without a fallback drops out: the parts keep the page's
// font and text colour, the card loses its shadow, and each line falls back to a hairline.
const styles = `@layer look.patchy-hotkeys {
  .hotkey-opener {
    box-sizing: border-box;
    display: inline-grid;
    place-items: center;
    height: 2.25rem;
    margin: 0;
    padding: 0;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  .hotkey-opener:hover {
    background: color-mix(in srgb, currentColor 8%, transparent);
  }
}

@layer patchy-hotkeys {
  /* Square, at the height the look gives its buttons: with a ratio, its max-content width is its
     height, so a flex column doesn't stretch it either. */
  .hotkey-opener {
    flex-shrink: 0;
    width: max-content;
    aspect-ratio: 1;
    padding-inline: 0;
  }

  /* Past every author layer, before the defaults below, which come later at the same weight. */
  .hotkey-sheet-dialog,
  .hotkey-sheet-dialog *,
  .hotkey-sheet-dialog::backdrop {
    all: revert;
  }
  .hotkey-sheet-dialog :focus-visible {
    outline: revert-layer;
    outline-offset: revert-layer;
  }

  /* The dialog is the layer over the page: its background is the scrim, and the card sits in it. */
  .hotkey-sheet-dialog {
    /* The look's lines. Without a look they are invalid, so each use falls back to the hairline. */
    --hotkey-line: 2px solid var(--look-border);
    --hotkey-key-line: color-mix(in srgb, var(--look-border) 70%, var(--look-fg));
    --hotkey-hairline: 1px solid color-mix(in srgb, currentColor 20%, transparent);
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
    color: var(--look-fg);
    font-family: var(--look-font-body);
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
    border: var(--hotkey-line, var(--hotkey-hairline));
    border-radius: var(--look-radius, 8px);
    background: var(--look-surface, Canvas);
    box-shadow: calc(var(--look-space) * 0.5) calc(var(--look-space) * 0.5) 0 var(--look-border);
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
    font-family: var(--look-font-display);
    font-size: 1.35rem;
    font-weight: 800;
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
    color: var(--look-fg);
    font-family: var(--look-font-body);
    font-size: 0.9rem;
    font-weight: 750;
    line-height: 1;
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
    border-bottom: var(--hotkey-line, var(--hotkey-hairline));
    color: var(--look-muted, color-mix(in srgb, currentColor 65%, transparent));
    font-family: var(--look-font-body);
    font-size: 0.82rem;
    font-weight: 750;
    line-height: 1.3;
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
    border-bottom: 1px solid color-mix(in srgb, var(--look-border, currentColor) 22%, transparent);
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
    color: var(--look-muted, color-mix(in srgb, currentColor 65%, transparent));
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
      var(--hotkey-key-line, color-mix(in srgb, currentColor 35%, transparent));
    border-bottom-width: 3px;
    border-radius: min(var(--look-radius, 8px), 6px);
    background: var(--look-bg, color-mix(in srgb, currentColor 5%, transparent));
    color: var(--look-fg);
    font-family: var(--look-font-body);
    font-size: 0.76rem;
    font-weight: 700;
    line-height: 1;
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
      border-inline: 0;
      border-bottom: 0;
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
      border: var(--hotkey-line, var(--hotkey-hairline));
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

// Element rules in the page's stylesheets, layered or not, don't reach the sheet. Its unlayered
// rules with a class, attribute or pseudo-class can, and so can layers it declares after the sheet
// first mounts; the `?` button also takes the page's layered styles, as its own buttons do.
// This reset handles unlayered rules: each selector weighs one class, which outranks any number of
// element names, and reverts the page's unlayered rules to the layers. It sits first in `<head>`,
// so a page's own one-class rule, such as `.hotkey-key { … }`, comes after it and wins the tie. A
// stylesheet prepended later is moved behind it when the sheet next opens; a page that replaces
// `<head>` wholesale drops it until the sheet next opens. `all` leaves out `direction` and
// `unicode-bidi`, so the parts inside take their direction from the sheet's container instead.
const reset = `.hotkey-opener,
.hotkey-sheet-dialog,
.hotkey-sheet-dialog *,
.hotkey-sheet-dialog::backdrop {
  all: revert-layer;
}
.hotkey-sheet-dialog * {
  direction: inherit;
  unicode-bidi: normal;
}
`;

const style = (text: string) => {
  const element = document.createElement("style");
  element.textContent = text;
  return element;
};

let first: HTMLStyleElement | undefined;

/**
 * Adds the sheet's styles to the page: its defaults once, after whatever styles the page already
 * has, so their layers come after the page's, and its reset first in `<head>`. Each call puts the
 * reset back first if a stylesheet has been prepended since, as the sheet does each time it opens.
 */
export const addSheetStyles = (): void => {
  if (first === undefined) {
    first = style(reset);
    document.head.append(style(styles));
  }
  if (document.head.firstElementChild !== first) document.head.prepend(first);
};
