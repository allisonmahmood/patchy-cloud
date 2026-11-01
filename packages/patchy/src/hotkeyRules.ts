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
  readonly hotkey: string;
  readonly label?: string | undefined;
  readonly enabled: boolean;
}

const name = (hotkey: Mounted) =>
  hotkey.label === undefined ? "an unlabelled hotkey" : `"${hotkey.label}"`;

/**
 * A warning for each enabled hotkey that shares its hotkey and scope with an earlier one, since
 * both fire. Pairs already in `warned` are skipped; the returned ones are added to it.
 */
export const duplicateWarnings = (mounted: Iterable<Mounted>, warned: Set<string>): string[] => {
  const first = new Map<string, Mounted>();
  const warnings: string[] = [];
  for (const hotkey of mounted) {
    if (!hotkey.enabled) continue;
    const key = `${hotkey.scope}\n${hotkey.hotkey}`;
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
