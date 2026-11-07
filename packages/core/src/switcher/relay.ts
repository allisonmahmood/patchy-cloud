/// <reference lib="dom" />
/**
 * The switcher relay, the first script in every document Patchy serves. Serving inserts it ahead
 * of a patch's own code; Patchy's pages, shells and notices carry it at the top of their `<head>`,
 * allowed by its hash. `scripts/build-core-scripts.mjs` bundles it into `generated/`.
 *
 * Its one capture listener on `window` is the first any script registers, so it hears every key
 * before page code can: it claims Mod+Shift+K and on an activating press asks for the switcher.
 * In a frame, that is a message to the shell, which also learns the relay is running from its
 * `hello`; at the top it is this page's own request. When the shell says the switcher closed, the
 * relay puts focus and the selection back where the press found them.
 */
import { activates, claims, platformOf } from "./key.js";
import { requestSwitcher, switcherMessage, switcherMessageKind } from "./messages.js";

const platform = platformOf(navigator);
// Read once, before page code runs, which could shadow it.
const shell = parent;
const framed = shell !== window;

/** Where the press found focus, and the selection there, for `closed` to restore. */
let saved:
  | {
      readonly element: Element;
      readonly field?: readonly [number, number, "forward" | "backward" | "none"];
      readonly range?: Range;
    }
  | undefined;

const remember = () => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (element === null) return;
  if (
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    element.selectionStart !== null &&
    element.selectionEnd !== null
  ) {
    saved = {
      element,
      field: [element.selectionStart, element.selectionEnd, element.selectionDirection ?? "none"]
    };
    return;
  }
  const selection = getSelection();
  saved = {
    element,
    ...(selection?.rangeCount ? { range: selection.getRangeAt(0).cloneRange() } : {})
  };
};

const restore = () => {
  const found = saved;
  saved = undefined;
  if (found === undefined || !found.element.isConnected) return;
  const { element, field, range } = found;
  if (element instanceof HTMLElement || element instanceof SVGElement)
    element.focus({ preventScroll: true });
  try {
    if (field && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
      element.setSelectionRange(...field);
    else if (range) {
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  } catch {
    // A field whose type changed meanwhile has no selection to restore.
  }
};

addEventListener(
  "keydown",
  (event) => {
    if (!claims(event, platform)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!activates(event, platform)) return;
    if (!framed) return requestSwitcher(window);
    remember();
    shell.postMessage(switcherMessage("open"), "*");
  },
  true
);

if (framed) {
  addEventListener(
    "message",
    (event) => {
      if (event.source !== shell || switcherMessageKind(event.data, ["closed"]) === undefined)
        return;
      // Patchy's own message; page code never sees it.
      event.stopImmediatePropagation();
      restore();
    },
    true
  );
  shell.postMessage(switcherMessage("hello"), "*");
}

// The document keeps the listeners, not the tag.
document.currentScript?.remove();
