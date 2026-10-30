// @effect-diagnostics globalConsole:off — Page code has no Effect runtime; warnings are for the builder's console.
/**
 * Keyboard shortcuts for Patchy pages.
 *
 * Patchy's own API. Pages write `"Mod+K"`, `"?"` or `"G H"` and never see TanStack Hotkeys,
 * which does the matching underneath; an upstream change is absorbed here, not in patches.
 */
import { createHotkeyBindings, prepareHotkeyDefinitions } from "@tanstack/hotkeys/adapter";
import {
  HotkeysProvider,
  formatForDisplay,
  getHotkeyManager,
  useDefaultHotkeysOptions,
  useHotkeyRegistrations,
  type HotkeyChord,
  type HotkeyRegistration,
  type UseHotkeyDefinition
} from "@tanstack/preact-hotkeys";
import { Fragment, createElement, type ComponentChildren, type JSX } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { duplicateWarnings, permitted, steps, type Mounted } from "./hotkeyRules.js";
import { addSheetStyles, sections } from "./hotkeySheet.js";

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
  /** The heading `HotkeySheet` lists it under. Ungrouped hotkeys are listed under General. */
  readonly group?: string;
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
    ...(binding.label === undefined ? {} : { meta: { name: binding.label, group: binding.group } })
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

// Layout effects keep a component's hotkeys live from the commit that mounts it to the one that
// removes it. TanStack's `useHotkeys` uses passive effects, which miss a key pressed before the
// next paint and, on Preact 11, outlive the component until that paint. Each render updates the
// same registrations in place, so it doesn't restart a sequence.
function useBindings(bindings: ReadonlyArray<Checked>): void {
  const kept = permitted(bindings);
  // A `HotkeyScope` above puts its scope here.
  const defaults = useDefaultHotkeysOptions().hotkey;
  const [registered] = useState(createHotkeyBindings);
  useLayoutEffect(() => {
    registered.update(prepareHotkeyDefinitions(kept.map(definition), { defaults }));
  });
  useLayoutEffect(() => () => registered.destroy(), [registered]);
  useLayoutEffect(checkDuplicates, [
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
  const parent = useDefaultHotkeysOptions().hotkey?.scope;
  // TanStack's provider holds its scope in a passive effect, whose cleanup Preact 11 runs after
  // the next paint, so the page's hotkeys would stay held for a frame after the scope unmounts.
  // A layout effect holds them from the commit that mounts the scope to the one that removes it.
  useLayoutEffect(
    () => getHotkeyManager().activateScope(scope, { exclusive: true, parent }),
    [scope, parent]
  );
  // Without a `scope` prop the provider activates nothing; it only puts its hotkeys in ours.
  const defaultOptions = useMemo(() => ({ hotkey: { scope } }), [scope]);
  return createElement(HotkeysProvider, { defaultOptions, children: props.children });
}

/** How the viewer's keyboard writes a hotkey: `"⌘ K"` on a Mac, `"Ctrl+K"` elsewhere, `"G H"`. */
export const formatHotkey = (hotkey: string): string => formatForDisplay(toTanStack(hotkey));

/** The keys of each step, for drawing keycaps: `"Mod+K"` is `[["⌘", "K"]]` on a Mac. */
export const hotkeyKeys = (hotkey: string): ReadonlyArray<ReadonlyArray<string>> =>
  steps(hotkey).map((step) => formatForDisplay(step as HotkeyChord, { parts: true }));

export interface ListedHotkey {
  readonly hotkey: string;
  readonly label: string;
  /** Its `group` option, when it has one. */
  readonly group?: string;
}

/**
 * Every labelled, enabled hotkey that is mounted, for a shortcuts sheet behind `"?"`.
 * It includes hotkeys a `HotkeyScope` is holding back, such as the page's under the sheet's own.
 */
export function useHotkeyList(): ReadonlyArray<ListedHotkey> {
  return useHotkeyRegistrations().flatMap((registration) => {
    const { hotkey, label, enabled } = mounted(registration);
    const group = registration.options.meta?.group;
    if (!enabled || label === undefined) return [];
    return [group === undefined ? { hotkey, label } : { hotkey, label, group }];
  });
}

// Each step's keys as keycaps, with "then" between a sequence's steps.
const keycaps = (hotkey: string) =>
  createElement(
    "span",
    { class: "hotkey-keys" },
    hotkeyKeys(hotkey).flatMap((keys, step) => [
      step > 0 && createElement("span", { class: "hotkey-then" }, "then"),
      // A symbol outside ASCII, such as ⌘, draws larger than a letter.
      ...keys.map((key) =>
        createElement("kbd", { class: /^[^ -~]$/.test(key) ? "hotkey-symbol" : undefined }, key)
      )
    ])
  );

// A modal dialog: the page behind it is inert and Escape asks it to close. Its state is the
// sheet's: the dialog closes as it unmounts, which returns focus to where it was. Chrome fires
// the dialog's own close event late, after the next key, so nothing waits on it.
function Sheet(props: { readonly title: string; readonly onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const title = useId();
  const list = useHotkeyList();
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return createElement(
    "dialog",
    {
      ref: dialog,
      class: "hotkey-sheet-dialog",
      "aria-labelledby": title,
      onCancel: props.onClose,
      // The dialog is the scrim around the card, so a click on the dialog itself is outside it.
      onClick: (event: MouseEvent) => {
        if (event.target === event.currentTarget) props.onClose();
      },
      // The close button is the only stop; Tab would otherwise leave the frame for Patchy's bar.
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        close.current?.focus();
      }
    },
    createElement(
      "div",
      { class: "hotkey-sheet" },
      createElement(
        "div",
        { class: "hotkey-sheet-head" },
        createElement("h2", { id: title }, props.title),
        createElement(
          "button",
          {
            ref: close,
            type: "button",
            class: "hotkey-sheet-close",
            "aria-label": "Close",
            onClick: props.onClose
          },
          keycaps("Escape"),
          createElement("span", { class: "hotkey-sheet-close-word" }, "Close")
        )
      ),
      createElement(
        "div",
        { class: "hotkey-groups" },
        sections(list).map(([name, rows]) =>
          createElement(
            "section",
            { class: "hotkey-group", key: name },
            name !== undefined && createElement("h3", null, name),
            createElement(
              "ul",
              null,
              rows.map((row) =>
                createElement(
                  "li",
                  { class: "hotkey-row", key: `${row.hotkey}\n${row.label}` },
                  createElement("span", { class: "hotkey-label" }, row.label),
                  keycaps(row.hotkey)
                )
              )
            )
          )
        )
      )
    )
  );
}

export interface HotkeySheetProps<S extends string> {
  /** The sheet's heading and accessible name. Defaults to "Keyboard shortcuts". */
  readonly title?: string;
  /** The hotkey that opens it, listed as "Show shortcuts". Defaults to `"?"`. */
  readonly hotkey?: Hotkey<S>;
}

/**
 * A `?` button where it is mounted, and a sheet that it and `hotkey` open, listing every labelled
 * hotkey under its group. While the sheet is open the page's hotkeys wait. Escape, its close
 * button and a click outside it close it, and focus goes back. It draws in the company look with
 * `hotkey-*` classes, in `@layer patchy-hotkeys`, so the page's own CSS restyles it.
 *
 * ```tsx
 * <HotkeySheet />
 * <HotkeySheet title="Tracker shortcuts" hotkey="Mod+/" />
 * ```
 */
export function HotkeySheet<const S extends string = "?">(props: HotkeySheetProps<S>): JSX.Element {
  const title = props.title ?? "Keyboard shortcuts";
  const [open, setOpen] = useState(false);
  useLayoutEffect(addSheetStyles, []);
  // Registered outside the sheet's scope: it fires while the sheet is closed and lists with the page's.
  useBindings([{ hotkey: props.hotkey ?? "?", run: () => setOpen(true), label: "Show shortcuts" }]);
  return createElement(
    Fragment,
    null,
    createElement(
      "button",
      {
        type: "button",
        class: "hotkey-opener",
        "aria-label": title,
        "aria-haspopup": "dialog",
        onClick: () => setOpen(true)
      },
      "?"
    ),
    open &&
      createElement(HotkeyScope, {
        children: createElement(Sheet, { title, onClose: () => setOpen(false) })
      })
  );
}
