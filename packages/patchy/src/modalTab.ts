/**
 * Tab and Shift+Tab stay inside a page's topmost modal dialog when the dialog is plain, and are the
 * browser's everywhere else. `showModal()` makes the rest of the patch's page inert, but not
 * Patchy's page around the patch's frame, so Tab past a modal dialog's last control takes focus out
 * of the frame, and Escape can stop reaching the dialog.
 *
 * A dialog is plain when every element in it is an ordinary container or text, or a control Tab
 * stops on once, and nothing in it adds, hides or reorders stops: see `isPlain`. In a plain dialog,
 * Tab from its last stop goes to its first, Shift+Tab from its first to its last, and a dialog with
 * no stops keeps focus. Anything richer keeps the browser's own Tab, out of the frame included.
 *
 * Two things this can't see, both left as they are: a closed shadow root attached to a standard
 * element, and a listener a capture listener adds to the window, during the key's own dispatch,
 * that takes Tab after this has.
 *
 * Internal to the SDK: `patchy/preact`, the generated client and `HotkeySheet` each call
 * `keepTabInModals`, so a page built on the SDK has it once whichever of them it imports.
 */

type Focusable = HTMLElement | SVGElement;

const isFocusable = (element: Element): element is Focusable =>
  element instanceof HTMLElement || element instanceof SVGElement;

// Ordinary containers and text, which hold no stop of their own, and the controls Tab stops on once:
// a button, a link, a select and its options, a summary and its details. A link is plain without
// its href too.
const plainTags = new Set([
  ...["div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "label", "form", "legend"],
  ...["ul", "ol", "li", "dl", "dt", "dd", "section", "header", "footer", "article", "aside"],
  ...["nav", "main", "figure", "figcaption", "blockquote", "address", "pre"],
  ...["table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col"],
  ...["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark"],
  ...["q", "s", "samp", "small", "strong", "sub", "sup", "time", "u", "var", "wbr", "del", "ins"],
  ...["br", "hr", "button", "select", "option", "optgroup", "summary", "details"]
]);

// Inputs with one field, which Tab stops on once, or not at all.
const plainInputs = new Set([
  ...["text", "search", "url", "tel", "email", "password", "number", "checkbox"],
  ...["button", "submit", "reset", "image", "hidden"]
]);

// SVG that only draws. A link, a `<use>` that can draw one from elsewhere, embedded HTML or a
// tabindex can each put a stop in the drawing, some where the walk doesn't reach.
const svgStops = new Set(["a", "use", "foreignObject"]);

// What kind of element it is: on `plainTags`, a one-field input, an image without a map, an enabled
// fieldset, a `<details>` with its own summary first, an option without a tabindex, or SVG that
// only draws.
const isPlainKind = (element: Element): boolean => {
  if (element instanceof SVGElement)
    return !svgStops.has(element.localName) && !element.hasAttribute("tabindex");
  if (element instanceof HTMLInputElement) return plainInputs.has(element.type);
  if (element instanceof HTMLImageElement) return !element.hasAttribute("usemap");
  if (element instanceof HTMLFieldSetElement) return !element.matches(":disabled");
  // Without a summary of its own, the browser draws one, which takes Tab out of the walk's sight.
  if (element instanceof HTMLDetailsElement)
    return element.firstElementChild?.localName === "summary";
  // An option given a tabindex is a stop of its own.
  if (element instanceof HTMLOptionElement || element instanceof HTMLOptGroupElement)
    return !element.hasAttribute("tabindex");
  return element instanceof HTMLElement && plainTags.has(element.localName);
};

// Whether an inert attribute from the dialog down to the element makes it inert. A modal dialog
// escapes the inertness of its own ancestors, so theirs doesn't count.
const isInertIn = (dialog: Element, element: Element): boolean => {
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    if (at.hasAttribute("inert")) return true;
    if (at === dialog) return false;
  }
  return false;
};

// How it is laid out: not `display: contents`, not reordered by `reading-flow`, not made inert by
// `interactivity`, and not a region that scrolls, which browsers can stop on as well as on what it
// holds.
const isPlainBox = (dialog: Element, element: Element): boolean => {
  const style = getComputedStyle(element);
  const flow = style.getPropertyValue("reading-flow");
  if (style.display === "contents" || (flow !== "" && flow !== "normal")) return false;
  // Chromium draws the inert attribute as `interactivity: inert` too; that is the attribute's,
  // whose subtree is no stop anyway.
  const inert = style.getPropertyValue("interactivity") === "inert";
  if (inert && !isInertIn(dialog, element)) return false;
  const scrollable = /auto|scroll/.test(`${style.overflowX} ${style.overflowY}`);
  return !(
    scrollable &&
    (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
  );
};

// No popover, shadow root, positive tabindex or editable content, which add or reorder stops, and a
// plain box.
const hasPlainParts = (dialog: Element, element: Element): boolean =>
  !element.hasAttribute("popover") &&
  element.shadowRoot === null &&
  !(isFocusable(element) && element.tabIndex > 0) &&
  !(element instanceof HTMLElement && element.isContentEditable) &&
  isPlainBox(dialog, element);

const isPlain = (dialog: Element, element: Element): boolean =>
  isPlainKind(element) && hasPlainParts(dialog, element);

// Whether Tab may stop on an element of the dialog: it takes focus by Tab, and isn't disabled,
// inert or unseen.
const mayStop = (dialog: Element, element: Element): element is Focusable =>
  isFocusable(element) &&
  element.tabIndex >= 0 &&
  !element.matches(":disabled") &&
  !isInertIn(dialog, element) &&
  element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });

// Whether nothing after `active` in the dialog, or before it going `backward`, may take focus. Only
// then does the rest look further, so a Tab between stops costs no more than this.
const isAtEnd = (dialog: Element, active: Element, backward: boolean): boolean => {
  const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_ELEMENT);
  walker.currentNode = active;
  const step = () => (backward ? walker.previousNode() : walker.nextNode());
  for (let node = step(); node !== null && node !== dialog; node = step())
    if (node instanceof Element && mayStop(dialog, node)) return false;
  return true;
};

// An open popover puts its content in the Tab order after the control that opened it, wherever it
// is in the page. A browser without popovers has none open.
const popoverOpen = (): boolean => {
  try {
    return document.querySelector(":popover-open") !== null;
  } catch {
    return false;
  }
};

// The tab stops of a plain dialog in tree order, which is the browser's order there, or nothing
// when the dialog isn't plain.
const plainStops = (dialog: HTMLDialogElement): Focusable[] | undefined => {
  if (!hasPlainParts(dialog, dialog) || popoverOpen()) return undefined;
  const stops: Focusable[] = [];
  for (const element of dialog.querySelectorAll("*")) {
    if (!isPlain(dialog, element)) return undefined;
    if (mayStop(dialog, element) && !(element instanceof HTMLOptionElement)) stops.push(element);
  }
  return stops;
};

/**
 * Where a Tab, or a Shift+Tab going `backward`, from `active` wraps to in `dialog`, or nothing when
 * the browser's own move is the one to make. In a plain dialog with no stops, focus stays.
 */
const wrapTo = (
  dialog: HTMLDialogElement,
  active: Element,
  backward: boolean
): Focusable | undefined => {
  if (active !== dialog && !isAtEnd(dialog, active, backward)) return undefined;
  const stops = plainStops(dialog);
  if (stops === undefined) return undefined;
  const [first] = stops;
  const last = stops.at(-1);
  if (first === undefined || last === undefined) return isFocusable(active) ? active : undefined;
  // The dialog itself comes before what it holds.
  if (active === dialog) return backward ? last : undefined;
  if (active !== (backward ? first : last)) return undefined;
  // Firefox stops on a modal dialog itself, ahead of what it holds, so Shift+Tab from its first
  // stop stays inside, and the next one wraps from the dialog.
  if (backward && dialog.tabIndex >= 0) return undefined;
  return backward ? last : first;
};

// The Tab being dispatched, for `decide` at the end of its way.
let pending: KeyboardEvent | undefined;

// Last of every listener on the key's way, so a widget or a later window listener that takes Tab
// with `preventDefault()` keeps it.
const decide = (event: KeyboardEvent): void => {
  window.removeEventListener("keydown", decide);
  if (event !== pending) return;
  pending = undefined;
  const active = document.activeElement;
  if (event.defaultPrevented || active === null) return;
  const dialog = active.closest("dialog:modal");
  if (!(dialog instanceof HTMLDialogElement)) return;
  const target = wrapTo(dialog, active, event.shiftKey);
  if (target === undefined) return;
  event.preventDefault();
  target.focus();
};

// A Tab, as its dispatch starts. `decide` goes on the end of the window's listeners now: a listener
// added during the capture runs as the key bubbles back to the window, after those there before it.
const note = (event: KeyboardEvent): void => {
  if (event.key !== "Tab" || event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
    return;
  pending = event;
  window.removeEventListener("keydown", decide);
  window.addEventListener("keydown", decide);
};

let installed = false;

/**
 * Keeps Tab and Shift+Tab inside the page's topmost modal dialog, the one focus is in, when the
 * dialog is plain: from its last tab stop to its first, from its first to its last, and on itself
 * when it has none. Everywhere else the browser moves focus. A Tab that something on the page took
 * with `preventDefault()` is left to it. Once per document; outside a browser it does nothing.
 */
export function keepTabInModals(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  window.addEventListener("keydown", note, true);
}
