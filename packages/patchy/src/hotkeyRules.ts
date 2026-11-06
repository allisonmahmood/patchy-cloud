// @effect-diagnostics globalConsole:off — Page code has no Effect runtime; warnings are for the builder's console.
/**
 * What `patchy/hotkeys` checks around TanStack Hotkeys at runtime, in Patchy's words. Internal:
 * `hotkeys.ts` is the public entry and applies these when its hooks register.
 */
import { normalizeHotkey, parseHotkey, type HotkeyChord } from "@tanstack/preact-hotkeys";

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

// Whether each hotkey seen binds the reserved chord. Normalizing reads the platform from the
// navigator, which costs enough to matter for a page that renders 50 hotkeys many times a second.
const reserves = new Map<string, boolean>();
const reserved = (hotkey: string): boolean => {
  let found = reserves.get(hotkey);
  if (found === undefined) {
    found = steps(hotkey).some((step) => normalizeHotkey(step) === reservedChord);
    reserves.set(hotkey, found);
  }
  return found;
};

// Physical keys that type text: letters, digits, the numpad's digits and operators, punctuation and
// Space. A hotkey names one only through a cast, as `"[KeyA]"`.
const typingCode =
  /^(Key[A-Z]|Digit\d|Numpad(\d|Add|Subtract|Multiply|Divide|Decimal|Comma|Equal)|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|Intl(Backslash|Ro|Yen)|Space)$/;

// Whether each hotkey seen types text at every step, cached as `reserves` is.
const typing = new Map<string, boolean>();
const typesText = (hotkey: string): boolean => {
  let found = typing.get(hotkey);
  if (found === undefined) {
    found = steps(hotkey).every((step) => {
      const chord = parseHotkey(step as HotkeyChord);
      if (chord.ctrl || chord.alt || chord.meta) return false;
      return chord.code === undefined
        ? chord.key === "Space" || [...chord.key].length === 1
        : typingCode.test(chord.code);
    });
    typing.set(hotkey, found);
  }
  return found;
};

/**
 * Whether a hotkey is a character shortcut, which a viewer who turns single-key shortcuts off
 * stops. It is when every step, as TanStack parses it, is a key that types text: a letter, digit,
 * symbol or Space, Shift or not, with no Mod, Ctrl or Alt anywhere in the hotkey. A character
 * typed with AltGr or reached through a dead key's position counts, and so do the numpad's digits
 * and operators. Named keys, the arrows and Home a numpad sends without NumLock among them, don't,
 * and neither does a sequence with one. A hotkey `within` an element is exempt, as its keys work
 * only while focus is there, unless the element is the page's body or root.
 */
export const characterShortcut = (hotkey: string, within: Element | undefined): boolean =>
  typesText(hotkey) &&
  (within === undefined ||
    within === within.ownerDocument.body ||
    within === within.ownerDocument.documentElement);

const refused = new Set<string>();

/**
 * The bindings that may register. One with a step that binds the reserved chord on this
 * platform, in any spelling, can only arrive through a cast; it is left out and warned about
 * once.
 */
export const permitted = <T extends { readonly hotkey: string }>(bindings: ReadonlyArray<T>): T[] =>
  bindings.filter(({ hotkey }) => {
    if (!reserved(hotkey)) return true;
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
  /** Where it listens: `"page"`, or a name for the one element it is `within`. */
  readonly place: string;
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
    const key = `${hotkey.scope}\n${hotkey.place}\n${hotkey.hotkey}`;
    const earlier = first.get(key);
    if (earlier === undefined) {
      first.set(key, hotkey);
      continue;
    }
    const pair = `${key}\n${earlier.label}\n${hotkey.label}`;
    if (warned.has(pair)) continue;
    warned.add(pair);
    const where = hotkey.place === "page" ? "in the same scope" : "within the same element";
    warnings.push(
      `patchy/hotkeys: ${name(earlier)} and ${name(hotkey)} both use ${hotkey.hotkey} ${where}, so both fire on each press.`
    );
  }
  return warnings;
};

/**
 * The kind of field focus is in, for the keys it keeps: a one-line text field (a text
 * `<input>`, a `<select>`, a textbox or searchbox role), a field of lines (a `<textarea>` or
 * a multi-line textbox), rich text (contenteditable), or a read-only text input or textarea.
 */
export type Field = "line" | "lines" | "rich" | "read-only";

/** What `fieldKeeps` reads of a keydown. */
export type Press = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "shiftKey"
  | "isComposing"
  | "keyCode"
  | "getModifierState"
>;

// The keys that move the caret, and with Shift the selection.
const caret = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown"
]);

// The letter a Mod chord names: what the layout types, or the key's US position when that isn't
// a Latin letter, as on a Russian layout. Text editing follows the same rule.
const letterOf = (press: Press) =>
  /^[a-z]$/i.test(press.key)
    ? press.key.toLowerCase()
    : /^Key[A-Z]$/.test(press.code)
      ? press.code.slice(3).toLowerCase()
      : "";

/** What `fieldKeeps` reads of a hotkey: whether it listens on the field itself, and its option. */
export interface Asking {
  readonly within: boolean;
  readonly whileTyping?: boolean | undefined;
}

/**
 * Whether the focused field keeps a key from a hotkey, so the hotkey doesn't take it. On a Mac,
 * Mod is ⌘.
 *
 * A text field keeps every key that types, Shift and Alt chords included, the keys of an input
 * method's composition and dead keys, and the keys that edit text: Backspace, Delete, the arrows,
 * Home, End, Page Up and Page Down with any modifiers; Mod with A, C, X, V, Z or Y; Mod+Shift with
 * Z or V; Mod with B, I or U in rich text. Only these leave it: other Mod chords, Escape, and, for
 * a hotkey within a one-line field, its plain Enter, ↑ and ↓. A hotkey with `whileTyping: false`
 * takes none of them, even within the field. No other option changes this.
 *
 * A read-only field keeps its caret and selection keys, with or without Shift, and Mod with A and
 * C; the rest leave it.
 */
export const fieldKeeps = (press: Press, field: Field, hotkey: Asking, mac: boolean): boolean => {
  const mod = mac ? press.metaKey : press.ctrlKey;
  const letter = letterOf(press);
  if (field === "read-only")
    return caret.has(press.key)
      ? !(press.ctrlKey || press.metaKey || press.altKey)
      : mod && !press.altKey && !press.shiftKey && (letter === "a" || letter === "c");
  const composing =
    press.isComposing ||
    press.keyCode === 229 ||
    press.key === "Process" ||
    press.key === "Unidentified" ||
    press.key === "Dead";
  const types =
    [...press.key].length === 1 &&
    (!(press.ctrlKey || press.metaKey) || press.getModifierState("AltGraph"));
  if (composing || types || hotkey.whileTyping === false) return true;
  if (mod)
    return (
      press.key === "Backspace" ||
      press.key === "Delete" ||
      caret.has(press.key) ||
      (!press.altKey &&
        letter !== "" &&
        (press.shiftKey
          ? letter === "z" || letter === "v"
          : "acxvzy".includes(letter) || (field === "rich" && "biu".includes(letter))))
    );
  if (press.key === "Escape") return false;
  const bare = !(press.ctrlKey || press.metaKey || press.altKey || press.shiftKey);
  return !(
    hotkey.within &&
    field === "line" &&
    bare &&
    (press.key === "Enter" || press.key === "ArrowUp" || press.key === "ArrowDown")
  );
};

// Input types that aren't for text, as TanStack's typing rule lists them.
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

/** The field focus is in, looking inside open shadow roots, and its kind; none outside one. */
export const focusedField = (
  doc: Document
): { readonly element: Element; readonly field: Field } | undefined => {
  let focused = doc.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  if (!focused) return undefined;
  const field = fieldOf(focused);
  return field === undefined ? undefined : { element: focused, field };
};

const fieldOf = (element: Element): Field | undefined => {
  if (element instanceof HTMLInputElement)
    return notText.has(element.type) ? undefined : element.readOnly ? "read-only" : "line";
  if (element instanceof HTMLTextAreaElement) return element.readOnly ? "read-only" : "lines";
  if (element instanceof HTMLSelectElement) return "line";
  if (element instanceof HTMLElement && element.isContentEditable) return "rich";
  const role = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (role !== "textbox" && role !== "searchbox") return undefined;
  return element.getAttribute("aria-multiline") === "true" ? "lines" : "line";
};
