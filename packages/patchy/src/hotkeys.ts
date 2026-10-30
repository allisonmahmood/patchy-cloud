// @effect-diagnostics globalConsole:off — Page code has no Effect runtime; warnings are for the builder's console.
/**
 * Keyboard shortcuts for Patchy pages.
 *
 * Patchy's own API. Pages write `"Mod+K"`, `"?"` or `"G H"` and never see TanStack Hotkeys,
 * which does the matching underneath; an upstream change is absorbed here, not in patches.
 */
import {
  HotkeysProvider,
  formatForDisplay,
  getHotkeyManager,
  useHotkeyRegistrations,
  useHotkeys as useTanStackHotkeys,
  type HotkeyChord,
  type HotkeyRegistration,
  type UseHotkeyDefinition
} from "@tanstack/preact-hotkeys";
import { createElement, type ComponentChildren, type JSX } from "preact";
import { useEffect, useId } from "preact/hooks";
import { duplicateWarnings, permitted, steps, type Mounted } from "./hotkeyRules.js";

type Letter =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type Named =
  | "Enter"
  | "Escape"
  | "Space"
  | "Tab"
  | "Backspace"
  | "Delete"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | `F${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`;
type Punctuation = "/" | "?" | "," | "." | ";" | "'" | "[" | "]" | "\\" | "-" | "=" | "`";

/** A key as written in a hotkey. Letters match either case. */
export type Key = Letter | Lowercase<Letter> | Digit | Named | Punctuation;

// Patchy keeps it for its own shortcuts.
type Reserved = "Mod+Shift+K" | "Mod+Shift+k";

/**
 * One chord. `Mod` is ⌘ on a Mac and Ctrl elsewhere. Modifiers come in this order: Mod, Alt,
 * Shift. Patchy keeps `Mod+Shift+K`.
 */
export type Chord = Exclude<`${"" | "Mod+"}${"" | "Alt+"}${"" | "Shift+"}${Key}`, Reserved>;

type Steps<S extends string> = S extends `${infer Step} ${infer Rest}`
  ? [Step, ...Steps<Rest>]
  : [S];
// Other names for Mod's keys, which a chord writes as Mod.
type ModName = "Ctrl" | "Control" | "Cmd" | "Command" | "Meta";
type Refusal<Step extends string> = Step extends Reserved
  ? `'${Step}' is kept by Patchy for its own shortcuts: choose another chord`
  : Step extends `${ModName}+${infer Rest}`
    ? `Mod+${Rest}` extends Reserved
      ? `'Mod+${Rest}' is kept by Patchy for its own shortcuts: choose another chord`
      : `'${Step}' isn't a chord: write 'Mod+${Rest}', which is ⌘ on a Mac and Ctrl elsewhere`
    : `'${Step}' isn't a chord: write keys like 'Mod+K', 'Escape', '?' or 'G H', modifiers in the order Mod, Alt, Shift`;
type FirstRefusal<T extends readonly string[]> = T extends readonly [
  infer Step extends string,
  ...infer Rest extends string[]
]
  ? Step extends Chord
    ? FirstRefusal<Rest>
    : Refusal<Step>
  : never;

/**
 * A chord such as `"Mod+K"` or `"?"`, or a sequence of chords separated by single spaces,
 * such as `"G H"`. A string that isn't one becomes an error naming the step to fix.
 */
export type Hotkey<S extends string> = [FirstRefusal<Steps<S>>] extends [never]
  ? S
  : FirstRefusal<Steps<S>>;

export interface HotkeyOptions {
  /** What the hotkey does, in the viewer's words. Labelled hotkeys appear in `useHotkeyList`. */
  readonly label?: string;
  /** While false, the hotkey stays mounted but doesn't fire or list. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Fire while the viewer types in a field. By default single keys and Shift combos wait
   * until the field loses focus; Mod chords and Escape fire anyway.
   */
  readonly whileTyping?: boolean;
  /**
   * Holding a chord's keys fires it again with each key repeat. Set false to fire once per
   * press. A sequence fires once per completion either way. Defaults to true.
   */
  readonly repeat?: boolean;
}

export interface HotkeyBinding<S extends string> extends HotkeyOptions {
  readonly hotkey: Hotkey<S>;
  readonly run: (event: KeyboardEvent) => void;
}

// A binding after its hotkey passed the type check.
type Checked = HotkeyOptions & {
  readonly hotkey: string;
  readonly run: (event: KeyboardEvent) => void;
};

// Our Chord type is the contract; TanStack parses the same names at runtime.
const toTanStack = (hotkey: string): HotkeyChord | ReadonlyArray<HotkeyChord> => {
  const split = steps(hotkey) as HotkeyChord[];
  return split.length === 1 ? split[0]! : split;
};

const definition = (binding: Checked): UseHotkeyDefinition => ({
  hotkey: toTanStack(binding.hotkey),
  callback: (event) => binding.run(event),
  options: {
    enabled: binding.enabled ?? true,
    ignoreInputs: binding.whileTyping === undefined ? "auto" : !binding.whileTyping,
    requireReset: binding.repeat === false,
    // TanStack's own warning names options this API doesn't have; ours follows registration.
    conflictBehavior: "allow",
    ...(binding.label === undefined ? {} : { meta: { name: binding.label } })
  }
});

// A TanStack registration, or its view, as the duplicate check and `useHotkeyList` read it.
const mounted = ({ hotkey, options }: Pick<HotkeyRegistration, "hotkey" | "options">): Mounted => ({
  scope: options.scope ?? "global",
  hotkey: typeof hotkey === "string" ? hotkey : hotkey.join(" "),
  label: options.meta?.name,
  enabled: options.enabled !== false
});

const warned = new Set<string>();
let checking = false;
// Preact runs a commit's effects one component after another in a single task, so while two
// siblings swap keys, both hold the same one until the second updates. One check, in a
// microtask after them all, sees where every hook landed.
const checkDuplicates = () => {
  if (checking) return;
  checking = true;
  queueMicrotask(() => {
    checking = false;
    const registrations = [...getHotkeyManager().registrations.state.values()].map(mounted);
    // oxlint-disable-next-line no-console -- the warning is for the builder, in the page's console.
    for (const warning of duplicateWarnings(registrations, warned)) console.warn(warning);
  });
};

function useBindings(bindings: ReadonlyArray<Checked>): void {
  const kept = permitted(bindings);
  useTanStackHotkeys(kept.map(definition));
  useEffect(checkDuplicates, [
    kept.map((binding) => `${binding.hotkey}\n${binding.label}\n${binding.enabled}`).join("\n\n")
  ]);
}

/**
 * Run `run` when the viewer presses `hotkey`, while the calling component is mounted.
 *
 * ```tsx
 * useHotkey("G H", () => patchy.route.set("/"), { label: "Go home" });
 * useHotkey("Mod+K", openSearch, { label: "Search" });
 * ```
 */
export function useHotkey<const S extends string>(
  hotkey: Hotkey<S>,
  run: (event: KeyboardEvent) => void,
  options: HotkeyOptions = {}
): void {
  useBindings([{ ...options, hotkey, run }]);
}

/** Several hotkeys in one call, for lists that change length, such as one per menu item. */
export function useHotkeys<const T extends readonly string[]>(bindings: {
  readonly [I in keyof T]: HotkeyBinding<T[I]>;
}): void {
  useBindings(bindings as ReadonlyArray<Checked>);
}

/**
 * While mounted, only the hotkeys registered inside it fire, for a dialog: the rest of the
 * page's hotkeys, sequences included, wait until it unmounts.
 */
export function HotkeyScope(props: { readonly children: ComponentChildren }): JSX.Element {
  const scope = useId();
  return createElement(HotkeysProvider, { scope, exclusive: true, children: props.children });
}

/** How the viewer's keyboard writes a hotkey: `"⌘ K"` on a Mac, `"Ctrl+K"` elsewhere, `"G H"`. */
export const formatHotkey = (hotkey: string): string => formatForDisplay(toTanStack(hotkey));

/** The keys of each step, for drawing keycaps: `"Mod+K"` is `[["⌘", "K"]]` on a Mac. */
export const hotkeyKeys = (hotkey: string): ReadonlyArray<ReadonlyArray<string>> =>
  steps(hotkey).map((step) => formatForDisplay(step as HotkeyChord, { parts: true }));

export interface ListedHotkey {
  readonly hotkey: string;
  readonly label: string;
}

/**
 * Every labelled, enabled hotkey that is mounted, for a shortcuts sheet behind `"?"`.
 * It includes hotkeys a `HotkeyScope` is holding back, such as the page's under the sheet's own.
 */
export function useHotkeyList(): ReadonlyArray<ListedHotkey> {
  return useHotkeyRegistrations()
    .map(mounted)
    .flatMap(({ hotkey, label, enabled }) =>
      enabled && label !== undefined ? [{ hotkey, label }] : []
    );
}
