/// <reference lib="dom" />
/**
 * Mod+Shift+K, the switcher's chord, as every Patchy document reads it. Patchy *claims* a press
 * of these keys: the page's own listeners and the browser never get it. A claimed press
 * *activates* the switcher unless it is a repeat or an input method is composing. The relay runs
 * this ahead of any other script; `key.test.ts` holds activation equal to TanStack Hotkeys'
 * `matchesKeyboardEvent(event, "Mod+Shift+K")` under the repo's patch.
 */

/** Which key Mod is: ⌘ on a Mac, Ctrl everywhere else. TanStack's names. */
export type Platform = "mac" | "windows" | "linux";

/** What the chord reads of a key press. */
export type Press = Pick<
  KeyboardEvent,
  | "isTrusted"
  | "key"
  | "code"
  | "metaKey"
  | "ctrlKey"
  | "shiftKey"
  | "altKey"
  | "repeat"
  | "isComposing"
  | "keyCode"
  | "getModifierState"
>;

/** The platform as TanStack detects it, from the navigator's platform and user agent. */
export const platformOf = ({
  platform,
  userAgent
}: Pick<Navigator, "platform" | "userAgent">): Platform => {
  const name = `${platform} ${userAgent}`.toLowerCase();
  return name.includes("mac") ? "mac" : name.includes("win") ? "windows" : "linux";
};

/** An input method owns the press, by the repo's patched normalization. */
const composing = (press: Press) =>
  press.isComposing ||
  press.keyCode === 229 ||
  press.key === "Process" ||
  press.key === "Unidentified";

/**
 * K by TanStack's rule. A Latin letter is the key it names, wherever it sits, so a remapped
 * layout's J on the physical K key is J's shortcut. A key that can't name one, such as Cyrillic
 * л, a symbol or a dead key, stands for the key at its position, as does an input method's
 * Process or Unidentified.
 */
const isK = (press: Press) => {
  const key = press.key.normalize("NFC");
  if (/^\p{Script_Extensions=Latin}$/u.test(key))
    return key.localeCompare("K", undefined, { sensitivity: "accent" }) === 0;
  const standsIn = key === "Dead" || [...key].length === 1 || composing(press);
  return standsIn && press.code === "KeyK";
};

/** Mod and Shift without Alt; elsewhere than a Mac, AltGr held is never Ctrl. */
const modifiers = (press: Press, platform: Platform) =>
  press.shiftKey &&
  !press.altKey &&
  (platform === "mac"
    ? press.metaKey && !press.ctrlKey
    : press.ctrlKey && !press.metaKey && !press.getModifierState("AltGraph"));

/**
 * Whether Patchy takes this press: a person pressed the chord, even mid-composition or holding
 * it down, so no listener after the claiming one and no browser action may have it.
 */
export const claims = (press: Press, platform: Platform) =>
  press.isTrusted && modifiers(press, platform) && isK(press);

/** Whether a claimed press asks for the switcher: once per press, never while composing. */
export const activates = (press: Press, platform: Platform) =>
  claims(press, platform) && !press.repeat && !composing(press);
