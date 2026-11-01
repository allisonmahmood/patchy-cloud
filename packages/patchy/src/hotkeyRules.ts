// @effect-diagnostics globalConsole:off — Page code has no Effect runtime; warnings are for the builder's console.
/**
 * What `patchy/hotkeys` checks around TanStack Hotkeys at runtime, in Patchy's words. Internal:
 * `hotkeys.ts` is the public entry and applies these when its hooks register.
 */
import { normalizeHotkey } from "@tanstack/preact-hotkeys";

/** Patchy keeps this chord for its own shortcuts. `Hotkey` refuses it at compile time. */
const reservedChord = "Mod+Shift+K";

/** A hotkey's steps, split on spaces. A lone trailing lowercase letter is the same key as its capital. */
export const steps = (hotkey: string): string[] =>
  hotkey
    .trim()
    .split(/\s+/)
    .map((step) =>
      step.replace(
        /(^|\+)([a-z])$/,
        (_, before: string, letter: string) => before + letter.toUpperCase()
      )
    );

const refused = new Set<string>();

/**
 * The bindings that may register. One with a step that binds the reserved chord on this
 * platform, in any spelling, can only arrive through a cast; it is left out and warned about
 * once.
 */
export const permitted = <T extends { readonly hotkey: string }>(bindings: ReadonlyArray<T>): T[] =>
  bindings.filter(({ hotkey }) => {
    if (!steps(hotkey).some((step) => normalizeHotkey(step) === reservedChord)) return true;
    if (!refused.has(hotkey)) {
      refused.add(hotkey);
      // oxlint-disable-next-line no-console -- the warning is for the builder, in the page's console.
      console.warn(
        `patchy/hotkeys: "${hotkey}" isn't registered. Patchy keeps ${reservedChord} for its own shortcuts; choose another chord.`
      );
    }
    return false;
  });

/** A mounted hotkey as the duplicate check sees it. A sequence's steps are joined by a space. */
export interface Mounted {
  readonly scope: string;
  /** Where it listens: the page, or one element's id. Each place takes its own keys. */
  readonly place?: string;
  readonly hotkey: string;
  readonly label?: string | undefined;
  readonly enabled: boolean;
}

const name = (hotkey: Mounted) =>
  hotkey.label === undefined ? "an unlabelled hotkey" : `"${hotkey.label}"`;

/**
 * A warning for each enabled hotkey that shares its hotkey, scope and place with an earlier one,
 * since both fire. Pairs already in `warned` are skipped; the returned ones are added to it.
 */
export const duplicateWarnings = (mounted: Iterable<Mounted>, warned: Set<string>): string[] => {
  const first = new Map<string, Mounted>();
  const warnings: string[] = [];
  for (const hotkey of mounted) {
    if (!hotkey.enabled) continue;
    const key = `${hotkey.scope}\n${hotkey.place ?? "page"}\n${hotkey.hotkey}`;
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, hotkey);
      continue;
    }
    const pair = `${key}\n${earlier.label}\n${hotkey.label}`;
    if (warned.has(pair)) continue;
    warned.add(pair);
    warnings.push(
      `patchy/hotkeys: ${name(earlier)} and ${name(hotkey)} both use ${hotkey.hotkey} in the same scope, so both fire on each press.`
    );
  }
  return warnings;
};

/**
 * The focused text field, if focus is in one: a text-entry input or textarea that isn't
 * read-only, a select, a contenteditable, or a textbox or searchbox role. TanStack's typing rule
 * reads the same list.
 */
export const focusedTextField = (doc: Document): Element | undefined => {
  let focused = doc.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  if (!focused) return undefined;
  if (focused instanceof HTMLInputElement)
    return notText.has(focused.type) || focused.readOnly ? undefined : focused;
  if (focused instanceof HTMLTextAreaElement) return focused.readOnly ? undefined : focused;
  if (focused instanceof HTMLSelectElement) return focused;
  const role = focused.getAttribute("role");
  return role === "textbox" ||
    role === "searchbox" ||
    (focused instanceof HTMLElement && focused.isContentEditable)
    ? focused
    : undefined;
};
const notText = new Set([
  "button",
  "submit",
  "reset",
  "image",
  "color",
  "file",
  "checkbox",
  "radio",
  "range"
]);

// A field that holds lines, where the up and down keys move the caret between them.
const multiline = (field: Element) =>
  field instanceof HTMLTextAreaElement ||
  (field instanceof HTMLElement && field.isContentEditable) ||
  field.getAttribute("aria-multiline") === "true";

// The letter a Mod chord names: what the layout types, or the key's US position when that isn't
// a Latin letter, as on a Russian layout. Text editing follows the same rule.
const letterOf = (event: KeyboardEvent) =>
  /^[a-z]$/i.test(event.key)
    ? event.key.toLowerCase()
    : /^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3).toLowerCase()
      : "";

/**
 * Whether a key edits the text in `field`, so it belongs to the field whatever hotkey wants it:
 * - Backspace, Delete, the left and right arrows, Home and End, with any modifiers;
 * - the up and down arrows, Page Up and Page Down, in a field of lines or with a modifier;
 * - Mod with A, C, X, V, Z or Y, Mod+Shift with Z or V, and Mod with B, I or U in rich text.
 *
 * Other Mod chords, such as Mod+K and Mod+Enter, don't edit text. On a Mac, Mod is ⌘, and the
 * Ctrl keys text fields read there can't be written as a chord.
 */
export const editsText = (event: KeyboardEvent, field: Element, mac: boolean): boolean => {
  const mod = mac ? event.metaKey : event.ctrlKey;
  switch (event.key) {
    case "Backspace":
    case "Delete":
    case "ArrowLeft":
    case "ArrowRight":
    case "Home":
    case "End":
      return true;
    case "ArrowUp":
    case "ArrowDown":
    case "PageUp":
    case "PageDown":
      return multiline(field) || mod || event.altKey || event.shiftKey;
  }
  const letter = letterOf(event);
  if (!mod || event.altKey || letter === "") return false;
  if (event.shiftKey) return letter === "z" || letter === "v";
  return (
    "acxvzy".includes(letter) ||
    ("biu".includes(letter) && field instanceof HTMLElement && field.isContentEditable)
  );
};

/** Whether a key types a character, as a letter, digit, symbol or space does without Mod. */
export const typesText = (event: KeyboardEvent): boolean =>
  [...event.key].length === 1 &&
  (!(event.ctrlKey || event.metaKey) || event.getModifierState("AltGraph"));
