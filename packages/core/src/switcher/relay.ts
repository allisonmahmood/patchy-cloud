/// <reference lib="dom" />
/**
 * The switcher relay, the first script in every document Patchy serves. Serving inserts it ahead
 * of a patch's own code; Patchy's pages, shells and notices carry it at the top of their `<head>`,
 * allowed by its hash. `scripts/build-core-scripts.mjs` bundles it into `generated/`.
 *
 * Its one capture listener on `window` is the first any script registers, so it hears every key
 * before page code can: it claims Mod+Shift+K and on an activating press asks for the switcher.
 * In a frame, that is an `open` message to the shell, which also learns the relay is running from
 * its `hello`; at the top it toggles this page's own switcher, and lets a shell's waiting frame
 * take clicks and focus once that frame's document can claim the key. When the shell says the
 * switcher closed, the relay puts focus and the selection back where the press found them.
 */
import { activates, claims, platformOf } from "./key.js";
import { switcherMessage, switcherMessageKind, toggleSwitcher } from "./messages.js";

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
    // At the top, the press is the page's own, so it toggles; a frame's only ever asks to open.
    if (!framed) return toggleSwitcher(window);
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
} else {
  // A shell's frame waits hidden (`data-waiting`), out of reach of a click or Tab, until its
  // document can claim the key: its relay says hello, or a document without one loads. This
  // script ships inside the same response as that markup, so a broker from another release can
  // never strand it. The load of the frame's first, empty document comes before it has a `src`.
  const release = (frame: EventTarget | MessageEventSource | null) => {
    for (const waiting of document.querySelectorAll<HTMLIFrameElement>("iframe[data-waiting]"))
      if (waiting === frame || waiting.contentWindow === frame)
        waiting.removeAttribute("data-waiting");
  };
  // A frame's load never reaches the window, only the document.
  document.addEventListener(
    "load",
    (event) => {
      if (event.target instanceof HTMLIFrameElement && event.target.hasAttribute("src"))
        release(event.target);
    },
    true
  );
  addEventListener("message", (event) => {
    if (event.origin === "null" && switcherMessageKind(event.data, ["hello"]))
      release(event.source);
  });
}

// The document keeps the listeners, not the tag.
document.currentScript?.remove();
