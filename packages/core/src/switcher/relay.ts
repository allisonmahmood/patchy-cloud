/// <reference lib="dom" />
/**
 * The switcher relay, the first script in every document Patchy serves. Serving inserts it ahead
 * of a patch's own code; Patchy's pages, shells and notices carry it at the top of their `<head>`,
 * allowed by its hash. `scripts/build-core-scripts.mjs` bundles it into `generated/`.
 *
 * Its one capture listener on `window` is the first any script registers, so it hears every key
 * before page code can: it claims Mod+Shift+K and on an activating press asks for the switcher.
 * In a frame, that is an `open` message to the shell, which also learns the relay is running from
 * its `hello`. A shell with a switcher says so (`available`); there, every key that follows the
 * press is the switcher's until it takes the keyboard, so the page never hears one; at the top it toggles this page's own switcher, and lets a shell's waiting frame
 * take clicks and focus once that frame's document can claim the key. When the shell says the
 * switcher closed, the relay puts focus and the selection back where the press found them.
 */
import { activates, claims, platformOf } from "./key.js";
import { switcherMessage, switcherMessageKind, toggleSwitcher } from "./messages.js";

const platform = platformOf(navigator);
// Read once, before page code runs, which could shadow them.
const shell = parent;
const framed = shell !== window;
const now = performance.now.bind(performance);

/** The shell said it has a switcher that takes the keyboard when it opens. */
let menu = false;
/**
 * Until when every key this frame hears belongs to the switcher just asked for: from an
 * activating press, where a switcher will take the keyboard, until it has (this window blurs), it
 * closed, or a second passes. A key pressed in that moment is dropped, never the page's.
 */
let holdUntil = 0;
const hold = (event: Event) => {
  if (!event.isTrusted || now() >= holdUntil) return;
  event.preventDefault();
  event.stopImmediatePropagation();
};
/** `closed` came while the frame didn't have focus yet: restore once it does. */
let restoreOnFocus = false;
/**
 * The browser's own focus or blur of this frame as a whole, not of an element in it, nor one the
 * page dispatched; Firefox aims some at the document.
 */
const whole = (event: Event) =>
  event.isTrusted && (event.target === window || event.target === document);

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
    if (!claims(event, platform)) {
      if (framed) hold(event);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!activates(event, platform)) return;
    // At the top, the press is the page's own, so it toggles; a frame's only ever asks to open.
    if (!framed) return toggleSwitcher(window);
    remember();
    shell.postMessage(switcherMessage("open"), "*");
    if (menu) holdUntil = now() + 1_000;
  },
  true
);

if (framed) {
  addEventListener("keypress", hold, true);
  addEventListener("keyup", hold, true);
  addEventListener(
    "blur",
    (event) => {
      // The switcher took the keyboard; keys that come back here are the page's.
      if (whole(event) && !document.hasFocus()) holdUntil = 0;
    },
    true
  );
  addEventListener(
    "focus",
    (event) => {
      if (!whole(event) || !restoreOnFocus) return;
      restoreOnFocus = false;
      restore();
    },
    true
  );
  addEventListener(
    "message",
    (event) => {
      // Only the shell's own message: a page can dispatch one claiming any source, untrusted.
      if (!event.isTrusted || event.source !== shell) return;
      const kind = switcherMessageKind(event.data, ["available", "closed"]);
      if (kind === undefined) return;
      // Patchy's own message; page code never sees it.
      event.stopImmediatePropagation();
      if (kind === "available") {
        menu = true;
        return;
      }
      holdUntil = 0;
      // Focus returns with the message, but a browser can settle it later: then restore on arrival.
      if (document.hasFocus()) restore();
      else restoreOnFocus = true;
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
