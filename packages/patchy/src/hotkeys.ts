/**
 * PROTOTYPE (prototype/hotkeys): keyboard shortcuts for Patchy pages.
 *
 * Patchy's own API. Pages write `"Mod+K"`, `"?"` or `"G H"` and never see TanStack Hotkeys,
 * which does the matching underneath; an upstream change is absorbed here, not in patches.
 */
import {
  HotkeysProvider,
  formatForDisplay,
  useHotkeyRegistrations,
  useHotkeys as useTanStackHotkeys,
  type HotkeyChord,
  type UseHotkeyDefinition
} from "@tanstack/preact-hotkeys";
import { createElement, type ComponentChildren } from "preact";
import { useId } from "preact/hooks";

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

/**
 * One chord. `Mod` is ⌘ on a Mac and Ctrl elsewhere; `Control` is Ctrl everywhere.
 * Modifiers come in this order: Mod or Control, then Alt, then Shift.
 */
export type Chord = `${"" | "Mod+" | "Control+"}${"" | "Alt+"}${"" | "Shift+"}${Key}`;

type Steps<S extends string> = S extends `${infer Step} ${infer Rest}`
  ? [Step, ...Steps<Rest>]
  : [S];
type FirstBadStep<T extends readonly string[]> = T extends readonly [
  infer Step extends string,
  ...infer Rest extends string[]
]
  ? Step extends Chord
    ? FirstBadStep<Rest>
    : Step
  : never;

/**
 * A chord such as `"Mod+K"` or `"?"`, or a sequence of chords separated by single spaces,
 * such as `"G H"`. A string that isn't one becomes an error naming the step to fix.
 */
export type Hotkey<S extends string> = [FirstBadStep<Steps<S>>] extends [never]
  ? S
  : `"${FirstBadStep<Steps<S>>}" isn't a chord: write keys like "Mod+K", "?" or "G H", modifiers in the order Mod, Alt, Shift`;

export interface HotkeyOptions {
  /** What the hotkey does, in the viewer's words. Labelled hotkeys appear in `useHotkeyList`. */
  readonly label?: string;
  /** While false, the hotkey stays listed but doesn't fire. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Fire while the viewer types in a field. By default single keys and Shift combos wait
   * until the field loses focus; Mod and Control chords and Escape fire anyway.
   */
  readonly whileTyping?: boolean;
  /** Holding a chord's keys fires it again with each key repeat. Set false to fire once per press. Defaults to true. */
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

// One space separates sequence steps; a lone lowercase letter is the same key as its capital.
const toTanStack = (hotkey: string): HotkeyChord | ReadonlyArray<HotkeyChord> => {
  const steps = hotkey
    .trim()
    .split(/\s+/)
    .map((step) =>
      step.replace(
        /(^|\+)([a-z])$/,
        (_, before: string, letter: string) => before + letter.toUpperCase()
      )
    );
  // Our Chord type is the contract; TanStack parses the same names at runtime.
  return (steps.length === 1 ? steps[0] : steps) as HotkeyChord | ReadonlyArray<HotkeyChord>;
};

const definition = (binding: Checked): UseHotkeyDefinition => ({
  hotkey: toTanStack(binding.hotkey),
  callback: (event) => binding.run(event),
  options: {
    enabled: binding.enabled ?? true,
    ignoreInputs: binding.whileTyping === undefined ? "auto" : !binding.whileTyping,
    requireReset: binding.repeat === false,
    ...(binding.label === undefined ? {} : { meta: { name: binding.label } })
  }
});

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
  useTanStackHotkeys([definition({ ...options, hotkey, run })]);
}

/** Several hotkeys in one call, for lists that change length, such as one per menu item. */
export function useHotkeys<const T extends readonly string[]>(bindings: {
  readonly [I in keyof T]: HotkeyBinding<T[I]>;
}): void {
  useTanStackHotkeys((bindings as ReadonlyArray<Checked>).map(definition));
}

/**
 * Hotkeys registered inside a scope fire only while it is mounted, and win over the same
 * hotkey outside it. `exclusive`, for a dialog, silences every hotkey outside the scope.
 */
export function HotkeyScope(props: {
  readonly children: ComponentChildren;
  readonly exclusive?: boolean;
}) {
  const scope = useId();
  return createElement(HotkeysProvider, {
    scope,
    exclusive: props.exclusive ?? false,
    children: props.children
  });
}

/** How the viewer's keyboard writes a hotkey: `"⌘ K"` on a Mac, `"Ctrl+K"` elsewhere, `"G H"`. */
export const formatHotkey = (hotkey: string): string => formatForDisplay(toTanStack(hotkey));

/** The keys of each step, for drawing keycaps: `"Mod+K"` is `[["⌘", "K"]]` on a Mac. */
export const hotkeyKeys = (hotkey: string): ReadonlyArray<ReadonlyArray<string>> => {
  const tanstack = toTanStack(hotkey);
  return (typeof tanstack === "string" ? [tanstack] : tanstack).map((step) =>
    formatForDisplay(step, { parts: true })
  );
};

export interface ListedHotkey {
  readonly hotkey: string;
  readonly label: string;
}

/**
 * Every labelled, enabled hotkey that is mounted, for a shortcuts sheet behind `"?"`.
 * It includes hotkeys an exclusive scope is holding back, such as the sheet's own.
 */
export function useHotkeyList(): ReadonlyArray<ListedHotkey> {
  return useHotkeyRegistrations().flatMap((registration) =>
    registration.status !== "disabled" && registration.options.meta?.name !== undefined
      ? [
          {
            hotkey:
              typeof registration.hotkey === "string"
                ? registration.hotkey
                : registration.hotkey.join(" "),
            label: registration.options.meta.name
          }
        ]
      : []
  );
}
