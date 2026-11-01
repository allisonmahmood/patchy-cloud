// @effect-diagnostics globalConsole:off — Page code has no Effect runtime; warnings are for the builder's console.
/**
 * Keyboard shortcuts for Patchy pages.
 *
 * Patchy's own API. Pages write `"Mod+K"`, `"?"` or `"G H"` and never see TanStack Hotkeys,
 * which does the matching underneath; an upstream change is absorbed here, not in patches.
 */
import { detectPlatform } from "@tanstack/hotkeys";
import {
  createHotkeyBindings,
  prepareHotkeyDefinitions,
  type AdapterHotkeyDefinition
} from "@tanstack/hotkeys/adapter";
import {
  HotkeysProvider,
  formatForDisplay,
  getHotkeyManager,
  useDefaultHotkeysOptions,
  useHotkeyRegistrations,
  type HotkeyChord,
  type HotkeyRegistration
} from "@tanstack/preact-hotkeys";
import { Fragment, createElement, type ComponentChildren, type JSX } from "preact";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  duplicateWarnings,
  editsText,
  focusedTextField,
  permitted,
  steps,
  typesText,
  type Mounted
} from "./hotkeyRules.js";
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
// Every ASCII symbol. TanStack reads a trailing `+` as the key, so `"+"` and `"Mod++"` parse.
type Punctuation =
  | "!"
  | '"'
  | "#"
  | "$"
  | "%"
  | "&"
  | "'"
  | "("
  | ")"
  | "*"
  | "+"
  | ","
  | "-"
  | "."
  | "/"
  | ":"
  | ";"
  | "<"
  | "="
  | ">"
  | "?"
  | "@"
  | "["
  | "\\"
  | "]"
  | "^"
  | "_"
  | "`"
  | "{"
  | "|"
  | "}"
  | "~";

/** A key as written in a hotkey. Letters match either case; a symbol is the character it types. */
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
// A space too many would otherwise read as an empty step.
type Problem<S extends string> = S extends `${string}  ${string}` | ` ${string}` | `${string} `
  ? `'${S}' isn't a hotkey: separate its steps with one space, as in 'G H'`
  : FirstRefusal<Steps<S>>;

/**
 * A chord such as `"Mod+K"` or `"?"`, or a sequence of chords separated by single spaces,
 * such as `"G H"`. A string that isn't one becomes an error naming the step to fix.
 */
export type Hotkey<S extends string> = [Problem<S>] extends [never] ? S : Problem<S>;

export interface HotkeyOptions {
  /** What the hotkey does, in the viewer's words. Labelled hotkeys appear in `useHotkeyList`. */
  readonly label?: string;
  /** The heading `HotkeySheet` lists it under. Ungrouped hotkeys are listed under General. */
  readonly group?: string;
  /** While false, the hotkey stays mounted but doesn't fire or list. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Fire while the viewer types in a text field, and on the keys a focused control uses, such
   * as a button's Enter. By default Mod chords and Escape do; other keys wait.
   */
  readonly whileTyping?: boolean;
  /**
   * Holding a chord's keys fires it again with each key repeat. Set false to fire once per
   * press. A sequence fires once per completion either way. Defaults to true.
   */
  readonly repeat?: boolean;
  /**
   * Fire only while focus is inside this element, or on it, as CSS `:focus-within` reads it.
   * The narrowest place wins: an element's key beats the same key in a dialog or on the page,
   * which fire when focus is elsewhere. Pass the element's ref; until it renders, the hotkey
   * doesn't register.
   */
  readonly within?: { readonly current: HTMLElement | null };
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

/**
 * Prototype only: what the local-hotkeys demo switches to compare behaviours. Each is on in
 * the design; off is how `patchy/hotkeys` behaved before. Not part of the API.
 */
export const prototypeSwitches: {
  editingKeysStayInFields: boolean;
  standDownWhenHandled: boolean;
  sheetLists: "here" | "everything";
} = { editingKeysStayInFields: true, standDownWhenHandled: true, sheetLists: "here" };

type Within = NonNullable<HotkeyOptions["within"]>;

// A binding's place in its hook: the latest binding, and a `run` that stays the same function
// across renders, so the sheet can run what it lists.
interface Slot {
  binding: Checked;
  readonly run: (event: KeyboardEvent) => void;
}
// From the metadata TanStack keeps for a labelled registration back to its slot. TanStack keeps
// an older metadata object while a newer one is equal to it; both lead to the same slot.
const slots = new WeakMap<object, Slot>();

// Keys Patchy consumed itself, so a second hotkey on the same key still fires.
const consumed = new WeakSet<Event>();
const mac = typeof navigator !== "undefined" && detectPlatform() === "mac";

/**
 * Whether a matched chord leaves the key alone. TanStack's typing rule has already held back
 * keys that type in a field inside the hotkey's element; these hold whatever the options say.
 */
const standsDown = (event: KeyboardEvent, binding: Checked): boolean => {
  // Something on the page handled the key first: a widget's own handler, or a field's.
  if (prototypeSwitches.standDownWhenHandled && event.defaultPrevented && !consumed.has(event))
    return true;
  const field = focusedTextField(document);
  if (field === undefined) return false;
  if (prototypeSwitches.editingKeysStayInFields && editsText(event, field, mac)) return true;
  // A key that types reaches a hotkey `within` the field itself, which TanStack doesn't hold back.
  return binding.whileTyping !== true && typesText(event);
};

const definition = (slot: Slot): AdapterHotkeyDefinition<Within> => {
  const binding = slot.binding;
  const sequence = steps(binding.hotkey).length > 1;
  const meta =
    binding.label === undefined ? undefined : { name: binding.label, group: binding.group };
  if (meta) slots.set(meta, slot);
  return {
    hotkey: toTanStack(binding.hotkey),
    callback: (event) => {
      // Patchy consumes a chord itself, once it knows the key is the hotkey's to take. TanStack
      // consumes a sequence's steps, so each one it advances on stays untyped.
      if (!sequence) {
        if (standsDown(event, binding)) return;
        consumed.add(event);
        event.preventDefault();
        event.stopPropagation();
      }
      // Each repeat of a held key is kept from the page either way. Whether this keydown is one
      // is the event's to say: TanStack's `requireReset` is per registration, and a component
      // that remounts while the key is held registers afresh.
      if (binding.repeat === false && event.repeat) return;
      binding.run(event);
    },
    options: {
      enabled: binding.enabled ?? true,
      ignoreInputs:
        sequence && steps(binding.hotkey).some(editingStep)
          ? true
          : binding.whileTyping === undefined
            ? "auto"
            : !binding.whileTyping,
      ...(sequence ? {} : { preventDefault: false, stopPropagation: false }),
      // TanStack's own warning names options this API doesn't have; ours follows registration.
      conflictBehavior: "allow",
      ...(binding.within === undefined ? {} : { target: binding.within }),
      ...(meta === undefined ? {} : { meta })
    }
  };
};

// A sequence step that could edit text. A sequence with one waits in text fields, since TanStack
// consumes its steps before Patchy could stand down.
const editingStep = (step: string) =>
  /(^|\+)(Backspace|Delete|Arrow\w+|Home|End|Page\w+)$/.test(step) ||
  /^Mod\+(Shift\+)?[ACXVZYBIU]$/i.test(step);

let places = 0;
const placeIds = new WeakMap<object, string>();
// The page, or an id for the element a hotkey listens on.
const placeOf = (target: HotkeyRegistration["target"]) => {
  if (isPageLevel(target)) return "page";
  let id = placeIds.get(target);
  if (id === undefined) placeIds.set(target, (id = `element ${++places}`));
  return id;
};
const isPageLevel = (target: HotkeyRegistration["target"]): target is Document | Window =>
  !(target instanceof HTMLElement);

// A TanStack registration, or its view, as the duplicate check and `useHotkeyList` read it.
const mounted = ({
  hotkey,
  options,
  target
}: Pick<HotkeyRegistration, "hotkey" | "options" | "target">): Mounted => ({
  scope: options.scope ?? "global",
  place: placeOf(target),
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
// same registrations in place, so it doesn't restart a sequence. A `within` ref is read in the
// same layout effect, after Preact has set it. `scope` puts the hotkeys in a scope of Patchy's
// own instead of the enclosing `HotkeyScope`'s.
function useBindings(bindings: ReadonlyArray<Checked>, scope?: string): void {
  const kept = permitted(bindings);
  // A `HotkeyScope` above puts its scope here.
  const enclosing = useDefaultHotkeysOptions().hotkey?.scope;
  const [registered] = useState(createHotkeyBindings);
  const held = useRef<Slot[]>([]);
  useLayoutEffect(() => {
    const slots = kept.map((binding, index) => {
      const slot = (held.current[index] ??= {
        binding,
        run: (event) => slot.binding.run(event)
      });
      slot.binding = binding;
      return slot;
    });
    held.current.length = slots.length;
    const placed = scope ?? enclosing;
    registered.update(
      prepareHotkeyDefinitions(slots.map(definition), {
        ...(placed === undefined ? {} : { defaults: { scope: placed } }),
        resolveTarget: (within: Within) => within.current
      })
    );
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

// The shortcuts sheet's opener listens in this scope, which every `HotkeyScope` lets through, so
// the sheet opens over a dialog and lists the dialog's keys.
const sheetOpener = "patchy-hotkey-sheet";

/**
 * While mounted, only the hotkeys registered inside it fire, for a dialog: the rest of the
 * page's hotkeys, sequences included, wait until it unmounts. The shortcuts sheet still opens.
 */
export function HotkeyScope(props: { readonly children: ComponentChildren }): JSX.Element {
  const scope = useId();
  const parent = useDefaultHotkeysOptions().hotkey?.scope;
  // TanStack's provider holds its scope in a passive effect, whose cleanup Preact 11 runs after
  // the next paint, so the page's hotkeys would stay held for a frame after the scope unmounts.
  // A layout effect holds them from the commit that mounts the scope to the one that removes it.
  useLayoutEffect(
    () => getHotkeyManager().activateScope(scope, { exclusive: { allow: [sheetOpener] }, parent }),
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
 * It includes hotkeys a `HotkeyScope` is holding back, such as the page's under the sheet's own,
 * and those `within` an element that doesn't have focus.
 */
export function useHotkeyList(): ReadonlyArray<ListedHotkey> {
  return useHotkeyRegistrations().flatMap((registration) => {
    const { hotkey, label, enabled } = mounted(registration);
    const group = registration.options.meta?.group;
    if (!enabled || label === undefined) return [];
    return [group === undefined ? { hotkey, label } : { hotkey, label, group }];
  });
}

interface Row extends ListedHotkey {
  readonly run: (event: KeyboardEvent) => void;
  readonly scope: string;
  readonly target: HotkeyRegistration["target"];
}

/**
 * The sheet's rows. `here` is what fires where the viewer was: not held back by a dialog, on the
 * page or `within` an element focus was in, and of two with the same keys, the narrower one.
 * `list` is `here`, or every labelled hotkey under `prototypeSwitches.sheetLists`. `live` is
 * `here` without the sheet's own opener.
 */
const sheetRows = (
  registrations: ReadonlyArray<Pick<HotkeyRegistration, "hotkey" | "options" | "target">>,
  from: { readonly focus: Element | null; readonly heldBack: ReadonlySet<string> },
  own: string | undefined
) => {
  const all: Row[] = [];
  const narrowest = new Map<string, Row>();
  for (const registration of registrations) {
    const { hotkey, label, enabled, scope } = mounted(registration);
    const meta = registration.options.meta;
    const slot = meta === undefined ? undefined : slots.get(meta);
    if (!enabled || label === undefined || slot === undefined || scope === own) continue;
    const { target } = registration;
    const group = meta?.group;
    const row: Row = {
      hotkey,
      label,
      run: slot.run,
      scope,
      target,
      ...(group === undefined ? {} : { group })
    };
    all.push(row);
    if (from.heldBack.has(scope)) continue;
    if (!isPageLevel(target) && !target.contains(from.focus)) continue;
    const other = narrowest.get(hotkey);
    const narrower =
      other === undefined ||
      (!isPageLevel(target) && (isPageLevel(other.target) || other.target.contains(target)));
    if (narrower) narrowest.set(hotkey, row);
  }
  const here = all.filter((row) => narrowest.get(row.hotkey) === row);
  return {
    list: prototypeSwitches.sheetLists === "here" ? here : all,
    live: here.filter((row) => row.scope !== sheetOpener && row.hotkey !== "Escape")
  };
};

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
// the dialog's own close event late, after the next key, so nothing waits on it. It opens and
// closes in a layout effect, in the commits that switch its scope on and off: Preact 11 runs a
// passive cleanup after the dialog has left the page, and a dialog closed then returns focus
// nowhere.
function Sheet(props: { readonly title: string; readonly onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const title = useId();
  const own = useDefaultHotkeysOptions().hotkey?.scope;
  // Where the viewer was, read as the sheet first renders: before it takes focus, and before
  // its own scope holds anything back.
  const [from] = useState(() => ({
    focus: document.activeElement,
    heldBack: new Set(getHotkeyManager().scopes.state.suspended)
  }));
  const { list, live } = sheetRows(useHotkeyRegistrations(), from, own);
  // The keys that work where the viewer was work here too: one closes the sheet, which puts focus
  // back, and does what it does there. Escape stays the sheet's.
  useBindings(
    live.map((row) => ({
      hotkey: row.hotkey,
      run: (event: KeyboardEvent) => {
        props.onClose();
        row.run(event);
      }
    }))
  );
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
  /**
   * The hotkey that opens it, listed as "Show shortcuts". Defaults to `"?"`, with Mod+/ too, which
   * opens it from a text field.
   */
  readonly hotkey?: Hotkey<S>;
}

/**
 * A `?` button where it is mounted, and a sheet that it and `hotkey` open, inside dialogs too. The
 * sheet lists the labelled hotkeys that work where focus was, under their groups, and pressing
 * one closes it and runs it there; other hotkeys wait while it is open. Escape, its close button
 * and a click outside it close it, and focus goes back. It draws in the company look with
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
  useLayoutEffect(() => getHotkeyManager().activateScope(sheetOpener), []);
  // In the opener's scope, which every `HotkeyScope` lets through. Mod+/ opens it from a text
  // field, where ? is typed; it isn't listed, so the sheet shows one way in.
  const toggle = () => setOpen((was) => !was);
  useBindings(
    props.hotkey === undefined
      ? [
          { hotkey: "?", run: toggle, label: "Show shortcuts" },
          { hotkey: "Mod+/", run: toggle }
        ]
      : [{ hotkey: props.hotkey, run: toggle, label: "Show shortcuts" }],
    sheetOpener
  );
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
