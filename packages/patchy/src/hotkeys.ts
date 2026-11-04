// @effect-diagnostics globalConsole:off globalTimers:off — Page code has no Effect runtime; warnings are for the builder's console.
/**
 * Keyboard shortcuts for Patchy pages.
 *
 * Patchy's own API. Pages write `"Mod+K"`, `"?"` or `"G H"` and never see TanStack Hotkeys,
 * which does the matching underneath; an upstream change is absorbed here, not in patches.
 */
import {
  createHotkeyBindings,
  prepareHotkeyDefinitions,
  type AdapterHotkeyDefinition
} from "@tanstack/hotkeys/adapter";
import {
  HotkeysProvider,
  detectPlatform,
  formatForDisplay,
  getHotkeyManager,
  parseHotkey,
  useDefaultHotkeysOptions,
  useHotkeyRegistrations,
  type HotkeyChord,
  type HotkeyRegistrationView
} from "@tanstack/preact-hotkeys";
import { Fragment, createElement, createPortal, type ComponentChildren, type JSX } from "preact";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  duplicateWarnings,
  fieldKeeps,
  focusedField,
  permitted,
  steps,
  type Mounted
} from "./hotkeyRules.js";
import { addSheetStyles, narrowest, sections, type Placed } from "./hotkeySheet.js";

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

// Modifiers alone, for a hint such as "⌘ scroll".
type Modifiers = "Mod" | "Alt" | "Shift" | "Mod+Alt" | "Mod+Shift" | "Alt+Shift" | "Mod+Alt+Shift";

// What the display helpers take: a hotkey, modifiers alone, or a string that isn't a literal,
// such as a `useHotkeyList` row's. A literal that is none of these names the step to fix.
type Shown<S extends string> = string extends S ? S : S extends Modifiers ? S : Hotkey<S>;

export interface HotkeyOptions {
  /** What the hotkey does, in the viewer's words. Labelled hotkeys appear in `useHotkeyList`. */
  readonly label?: string;
  /** The heading `HotkeySheet` lists it under. Ungrouped hotkeys are listed under General. */
  readonly group?: string;
  /** While false, the hotkey stays mounted but doesn't fire or list. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Fire on the keys a focused control uses, such as a button's Enter or a checkbox's Space. In
   * text fields it changes nothing: by default Mod chords and Escape fire there and other keys
   * wait, and false holds Mod chords and Escape back too.
   */
  readonly whileTyping?: boolean;
  /**
   * Holding a chord's keys fires it again with each key repeat. Set false to fire once per
   * press. A sequence fires once per completion either way. Defaults to true.
   */
  readonly repeat?: boolean;
  /**
   * Fire only while focus is on this element or inside it, as CSS `:focus-within` reads it, for
   * keys that belong to one part of the page: arrows in a list, Enter in an inline editor. The
   * narrowest place wins: an element's hotkey beats the same keys in a dialog or on the page,
   * and a key it doesn't take goes on to them. Pass the element's ref; until the element
   * renders, the hotkey isn't registered. The ref is read after each render of the component
   * that registers the hotkey, so an element that changes because only a child re-rendered is
   * picked up at this component's next render.
   */
  readonly within?: { readonly current: Element | null };
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

type Within = NonNullable<HotkeyOptions["within"]>;

// Our Chord type is the contract; TanStack parses the same names at runtime.
const toTanStack = (hotkey: string): HotkeyChord | ReadonlyArray<HotkeyChord> => {
  const split = steps(hotkey) as HotkeyChord[];
  return split.length === 1 ? split[0]! : split;
};

// Keys Patchy took. One something else already prevented stands every hotkey down; one Patchy
// took doesn't, so `G` beside `G H` fires on every `G H`.
const consumed = new WeakSet<Event>();

/**
 * Whether a hotkey listening on `target` may take this key: not one something else already
 * handled, and not one the focused field keeps. A key it may take is marked as Patchy's. Chords
 * ask in their callback; TanStack asks for each sequence step, as `allowStep`.
 */
const takes = (event: KeyboardEvent, target: EventTarget | null): boolean => {
  if (event.defaultPrevented && !consumed.has(event)) return false;
  const focused = focusedField(document);
  if (
    focused !== undefined &&
    fieldKeeps(event, focused.field, target === focused.element, detectPlatform() === "mac")
  )
    return false;
  consumed.add(event);
  return true;
};

// From the metadata TanStack keeps for a labelled registration to the binding's `run` as last
// rendered, so the sheet can run what it lists. TanStack keeps an older metadata object while a
// newer one is equal to it; both lead to the same `run`.
const runs = new WeakMap<object, (event: KeyboardEvent) => void>();

// What a binding registers. Its callback runs `current()`, the binding as last rendered, so a
// render that changes only `run` or `repeat` leaves the registration as it is. `shape` names
// every field read here besides those two and `within`, whose element is compared on its own.
const definition = (binding: Checked, current: () => Checked): AdapterHotkeyDefinition<Within> => {
  const sequence = steps(binding.hotkey).length > 1;
  const meta =
    binding.label === undefined ? undefined : { name: binding.label, group: binding.group };
  if (meta !== undefined) runs.set(meta, (event) => current().run(event));
  return {
    hotkey: toTanStack(binding.hotkey),
    callback: (event) => {
      // Patchy consumes a chord itself, once it knows the key is the hotkey's to take; TanStack's
      // own consume would come too late to leave a key to a field. TanStack consumes a sequence's
      // steps, each after asking `takes`.
      if (!sequence) {
        if (!takes(event, event.currentTarget)) return;
        event.preventDefault();
        event.stopPropagation();
      }
      // Each repeat of a held key is kept from the page either way. Whether this keydown is one
      // is the event's to say: TanStack's `requireReset` is per registration, and a component
      // that remounts while the key is held registers afresh.
      const { run, repeat } = current();
      if (repeat === false && event.repeat) return;
      run(event);
    },
    options: {
      enabled: binding.enabled ?? true,
      ignoreInputs: binding.whileTyping === undefined ? "auto" : !binding.whileTyping,
      ...(sequence ? { allowStep: takes } : { preventDefault: false, stopPropagation: false }),
      // TanStack's own warning names options this API doesn't have; ours follows registration.
      conflictBehavior: "allow",
      ...(binding.within === undefined ? {} : { target: binding.within }),
      ...(meta === undefined ? {} : { meta })
    }
  };
};

// Everything `definition` registers apart from the callback and the element. While it and the
// element hold, so does each registration.
const shape = (bindings: ReadonlyArray<Checked>): string =>
  JSON.stringify(
    bindings.map(({ hotkey, label, group, enabled, whileTyping }) => [
      hotkey,
      label,
      group,
      enabled,
      whileTyping
    ])
  );

type Target = HotkeyRegistrationView["target"];

let places = 0;
const placeNames = new WeakMap<Element, string>();
// The page, or a name for the element a hotkey is `within`.
const placeOf = (target: Target): string => {
  if (!(target instanceof Element)) return "page";
  let name = placeNames.get(target);
  if (name === undefined) placeNames.set(target, (name = `element ${++places}`));
  return name;
};

// A TanStack registration, or its view, as the duplicate check, `useHotkeyList` and the sheet read it.
const mounted = ({
  hotkey,
  options,
  target
}: Pick<HotkeyRegistrationView, "hotkey" | "options" | "target">): Mounted => ({
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
// next paint and, on Preact 11, outlive the component until that paint. Each commit reads the
// `within` refs, which Preact has set by then. A commit that changes a binding's shape or element
// updates the same registrations in place, so it doesn't restart a sequence; one that doesn't,
// such as a whiteboard's on each collaborator's move, leaves them alone, since TanStack parses
// every hotkey again on each update. `scope` puts the hotkeys in a scope of Patchy's own instead
// of the enclosing `HotkeyScope`'s.
function useBindings(bindings: ReadonlyArray<Checked>, scope?: string): void {
  const kept = permitted(bindings);
  // A `HotkeyScope` above puts its scope here.
  const enclosing = useDefaultHotkeysOptions().hotkey?.scope;
  const placed = scope ?? enclosing;
  const [registered] = useState(createHotkeyBindings);
  const latest = useRef(kept);
  const last = useRef<{ readonly shape: string; readonly elements: ReadonlyArray<unknown> }>(
    undefined
  );
  useLayoutEffect(() => {
    latest.current = kept;
    const now = {
      shape: JSON.stringify([placed, shape(kept)]),
      elements: kept.map((binding) => binding.within?.current)
    };
    const before = last.current;
    if (
      before?.shape === now.shape &&
      before.elements.every((element, index) => element === now.elements[index])
    )
      return;
    last.current = now;
    registered.update(
      prepareHotkeyDefinitions(
        kept.map((binding, index) => definition(binding, () => latest.current[index]!)),
        {
          ...(placed === undefined ? {} : { defaults: { scope: placed } }),
          resolveTarget: (within: Within) => within.current
        }
      )
    );
    checkDuplicates();
  });
  useLayoutEffect(() => () => registered.destroy(), [registered]);
}

/**
 * Run `run` when the viewer presses `hotkey`, while the calling component is mounted.
 *
 * ```tsx
 * useHotkey("G H", () => patchy.route.set("/"), { label: "Go home" });
 * useHotkey("Mod+K", openSearch, { label: "Search" });
 * useHotkey("Enter", save, { within: field });
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

// The shortcuts sheet's openers listen in this scope, which every `HotkeyScope` lets through, so
// the sheet opens over a dialog and lists the dialog's commands.
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

// Their symbols, ↵ ␣ ⌫ ⌦ ⇥, are a Mac's; elsewhere these keys read as words, as in "Ctrl+Enter".
const words = {
  Enter: "Enter",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab"
};

const display = () => {
  const platform = detectPlatform();
  return platform === "mac" ? { platform } : { platform, keyLabels: words };
};

/**
 * How the viewer's keyboard writes a hotkey: `"⌘ K"` on a Mac, `"Ctrl+K"` elsewhere, `"G H"`.
 * Modifiers alone, such as `"Mod"`, are written too, for a hint like "⌘ scroll".
 */
export function formatHotkey<const S extends string>(hotkey: Shown<S>): string {
  return formatForDisplay(toTanStack(hotkey), display());
}

/** The keys of each step, for drawing keycaps: `"Mod+K"` is `[["⌘", "K"]]` on a Mac. */
export function hotkeyKeys<const S extends string>(
  hotkey: Shown<S>
): ReadonlyArray<ReadonlyArray<string>> {
  return steps(hotkey).map((step) =>
    formatForDisplay(step as HotkeyChord, { ...display(), parts: true })
  );
}

export interface ListedHotkey {
  readonly hotkey: string;
  readonly label: string;
  /** Its `group` option, when it has one. */
  readonly group?: string;
}

/**
 * Every labelled, enabled hotkey that is mounted, for a shortcuts sheet of the page's own. It
 * includes hotkeys a `HotkeyScope` is holding back, such as the page's under a dialog's, and
 * those `within` an element that doesn't have focus.
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
        createElement(
          "kbd",
          { class: /^[^ -~]$/.test(key) ? "hotkey-key hotkey-symbol" : "hotkey-key" },
          key
        )
      )
    ])
  );

/** A command the sheet lists: a labelled hotkey that works where focus was, and its `run`. */
interface Command extends ListedHotkey {
  readonly run: (event: KeyboardEvent) => void;
}

// What the text selection was in the focused element: a text field's range, or the page's.
type Selected =
  | {
      readonly start: number;
      readonly end: number;
      readonly direction: "forward" | "backward" | "none";
    }
  | {
      readonly anchor: Node;
      readonly anchorOffset: number;
      readonly focus: Node;
      readonly focusOffset: number;
    };

/** Where the viewer was as the sheet opened: what had focus, its selection, its dialog. */
interface From {
  readonly focus: Element | null;
  readonly selection: Selected | undefined;
  readonly dialog: Element | null;
  /** The scopes held back before the sheet's own: the page's, under a dialog. */
  readonly heldBack: ReadonlySet<string>;
}

const selectionOf = (focus: Element | null): Selected | undefined => {
  if (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement) {
    const { selectionStart: start, selectionEnd: end, selectionDirection } = focus;
    return start === null || end === null
      ? undefined
      : { start, end, direction: selectionDirection ?? "none" };
  }
  // Only a selection inside it: putting back one elsewhere, as in an editor beside a toolbar
  // button, would take focus from the button.
  const selection = document.getSelection();
  return focus !== null &&
    selection?.anchorNode &&
    selection.focusNode &&
    focus.contains(selection.anchorNode) &&
    focus.contains(selection.focusNode)
    ? {
        anchor: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focus: selection.focusNode,
        focusOffset: selection.focusOffset
      }
    : undefined;
};

const where = (): From => {
  const focus = document.activeElement;
  return {
    focus,
    selection: selectionOf(focus),
    dialog: focus?.closest("dialog, [role=dialog], [role=alertdialog]") ?? null,
    heldBack: new Set(getHotkeyManager().scopes.state.suspended)
  };
};

const focusable = (element: Element | null): element is HTMLElement | SVGElement =>
  element instanceof HTMLElement || element instanceof SVGElement;

// Focus and the selection back where the viewer was, or `rescue` when that element is gone.
const restore = (from: From): void => {
  const { focus, selection } = from;
  if (!focusable(focus) || !focus.isConnected) return rescue(from);
  focus.focus({ preventScroll: true });
  if (selection === undefined) return;
  if ("start" in selection) {
    if (focus instanceof HTMLInputElement || focus instanceof HTMLTextAreaElement)
      focus.setSelectionRange(selection.start, selection.end, selection.direction);
  } else if (selection.anchor.isConnected && selection.focus.isConnected)
    document
      .getSelection()
      ?.setBaseAndExtent(
        selection.anchor,
        selection.anchorOffset,
        selection.focus,
        selection.focusOffset
      );
};

// While the element the viewer was on is gone and focus fell to the page's body, focus goes to its
// dialog, made focusable for it. With no dialog, it stays on the body, the page's root.
const rescue = (from: From): void => {
  const { focus, dialog } = from;
  const lost = document.activeElement === null || document.activeElement === document.body;
  if (focus?.isConnected || !lost || !focusable(dialog) || !dialog.isConnected) return;
  if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
  dialog.focus({ preventScroll: true });
};

// A keydown for a hotkey's last step, for a command run from its button.
const pressed = (hotkey: string): KeyboardEvent => {
  const { key, ctrl, shift, alt, meta } = parseHotkey(steps(hotkey).at(-1) as HotkeyChord);
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: ctrl,
    shiftKey: shift,
    altKey: alt,
    metaKey: meta,
    cancelable: true
  });
};

// How deep an element sits, for which of two around focus is the narrower.
const depth = (element: Element): number => {
  let count = 0;
  for (let node = element.parentNode; node !== null; node = node.parentNode) count++;
  return count;
};

/**
 * The commands for the current context: the labelled hotkeys that work where the viewer was, so
 * not held back there, on the page or `within` an element around focus, the narrowest for each
 * hotkey. Neither the sheet's own scope nor its openers are commands.
 */
const commandsFor = (
  registrations: ReadonlyArray<HotkeyRegistrationView>,
  from: From,
  own: string | undefined
): Command[] =>
  narrowest(
    registrations.flatMap((registration): Array<Command & Placed> => {
      const { hotkey, label, enabled, scope } = mounted(registration);
      const meta = registration.options.meta;
      const run = meta === undefined ? undefined : runs.get(meta);
      const { target } = registration;
      const element = target instanceof Element ? target : undefined;
      if (
        !enabled ||
        label === undefined ||
        run === undefined ||
        scope === own ||
        scope === sheetOpener ||
        from.heldBack.has(scope) ||
        (element !== undefined && !element.contains(from.focus))
      )
        return [];
      const group = meta?.group;
      const placed = { hotkey, label, run, depth: element === undefined ? -1 : depth(element) };
      return [group === undefined ? placed : { ...placed, group }];
    })
  );

// The sheet's own keys, which no command's run takes while it is open.
const sheetKeys = new Set(["Escape", "Tab", "Shift+Tab"]);

// A modal dialog: the page behind it is inert and Escape asks it to close. Its state is the
// sheet's: the dialog closes as it unmounts, which returns focus to where it was. Chrome fires
// the dialog's own close event late, after the next key, so nothing waits on it. It opens and
// closes in a layout effect, in the commits that switch its scope on and off: Preact 11 runs a
// passive cleanup after the dialog has left the page, and a dialog closed then returns focus
// nowhere.
function Sheet(props: {
  readonly title: string;
  readonly from: From;
  readonly own: ReadonlyArray<ListedHotkey>;
  readonly onClose: () => void;
  readonly onRun: (command: Command, event?: KeyboardEvent) => void;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const commands = commandsFor(
    useHotkeyRegistrations(),
    props.from,
    useDefaultHotkeysOptions().hotkey?.scope
  );
  // A command's keys run it here too, but for the sheet's own: Escape closes it, Tab moves on.
  useBindings(
    commands
      .filter((command) => !sheetKeys.has(command.hotkey))
      .map((command) => ({
        hotkey: command.hotkey,
        run: (event: KeyboardEvent) => props.onRun(command, event)
      }))
  );
  useLayoutEffect(() => {
    const element = dialog.current;
    // Its reset back first in `<head>`, ahead of any stylesheet prepended since it last opened.
    addSheetStyles();
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
      // Tab goes round the sheet's buttons; past the last it would leave the frame for Patchy's bar.
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "Tab") return;
        const stops = [...(dialog.current?.querySelectorAll("button") ?? [])];
        const [first, last] = [stops[0], stops.at(-1)];
        if (document.activeElement !== (event.shiftKey ? first : last)) return;
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
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
        sections<ListedHotkey & { readonly run?: Command["run"] }>(commands, props.own).map(
          ([name, rows]) =>
            createElement(
              "section",
              { class: "hotkey-group", key: name },
              name !== undefined && createElement("h3", null, name),
              createElement(
                "ul",
                null,
                rows.map((row) => {
                  const label = createElement("span", { class: "hotkey-label" }, row.label);
                  const { run } = row;
                  return createElement(
                    "li",
                    { class: "hotkey-row", key: `${row.hotkey}\n${row.label}` },
                    // The sheet's own rows are what opened it, listed so the viewer learns them.
                    run === undefined
                      ? [label, keycaps(row.hotkey)]
                      : createElement(
                          "button",
                          {
                            type: "button",
                            class: "hotkey-command",
                            onClick: () => props.onRun({ ...row, run })
                          },
                          label,
                          keycaps(row.hotkey)
                        )
                  );
                })
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
   * The hotkey that opens it, listed as "Show shortcuts". Defaults to `"?"` and `"Mod+/"`, which
   * opens it from a text field too.
   */
  readonly hotkey?: Hotkey<S>;
  /** The heading its "Show shortcuts" rows list under, after the commands either way. */
  readonly group?: string;
}

// The mounted sheet's way to open, for `openHotkeySheet`.
let openMounted: (() => void) | undefined;

/**
 * Opens the mounted `HotkeySheet` from a control of the page's own, such as a menu item or a
 * dialog's button. It lists the commands where focus is, and focus goes back there when it closes,
 * as with its `?` button.
 */
export function openHotkeySheet(): void {
  if (openMounted) openMounted();
  // oxlint-disable-next-line no-console -- the warning is for the builder, in the page's console.
  else console.warn("patchy/hotkeys: openHotkeySheet() found no <HotkeySheet /> mounted to open.");
}

/**
 * A `?` button where it is mounted, and a sheet that it, `?` and Mod+/ open over the whole page,
 * dialogs included. It lists the commands for the current context: the labelled hotkeys that work
 * where focus was, under their groups. Each is a button, and its keys run it too: the sheet
 * closes, focus and the selection go back, then the command runs, and a polite live region
 * announces its label. Other hotkeys wait while it is open. Escape, its close button and a click
 * outside close it alone. Mount one per page. It draws in the company look, its button one of the
 * look's, or in the page's font and text colour without one. The page's unlayered rules aimed at
 * its `hotkey-*` classes restyle it; element rules in its stylesheets, layered or not, don't
 * reach it.
 *
 * ```tsx
 * <HotkeySheet />
 * <HotkeySheet title="Tracker shortcuts" hotkey="Mod+/" group="Help" />
 * ```
 */
export function HotkeySheet<const S extends string = "?">(props: HotkeySheetProps<S>): JSX.Element {
  const title = props.title ?? "Keyboard shortcuts";
  // Where the viewer was while the sheet is open, and nothing while it is closed.
  const [from, setFrom] = useState<From>();
  // How it last closed, for the commit that removes it: where to put focus back, and what to run.
  const closed = useRef<{
    readonly from: From;
    readonly command?: Command;
    readonly event?: KeyboardEvent;
  }>(undefined);
  const [said, setSaid] = useState<{ readonly label: string; readonly count: number }>();
  const own = (props.hotkey === undefined ? ["?", "Mod+/"] : [props.hotkey]).map((hotkey) => ({
    hotkey,
    label: "Show shortcuts",
    ...(props.group === undefined ? {} : { group: props.group })
  }));
  const close = (command?: Command, event?: KeyboardEvent) => {
    if (from === undefined) return;
    closed.current = {
      from,
      ...(command === undefined ? {} : { command }),
      ...(event === undefined ? {} : { event })
    };
    setFrom(undefined);
  };
  useLayoutEffect(addSheetStyles, []);
  useLayoutEffect(() => getHotkeyManager().activateScope(sheetOpener), []);
  // Reads where the viewer is as it opens, before the sheet takes focus or holds anything back.
  const show = useCallback(() => {
    const opened = where();
    setFrom((open) => open ?? opened);
  }, []);
  useLayoutEffect(() => {
    openMounted = show;
    return () => {
      if (openMounted === show) openMounted = undefined;
    };
  }, [show]);
  // Once the sheet has left the page, focus goes back, then the command runs: its own focus wins.
  useLayoutEffect(() => {
    const last = closed.current;
    if (from !== undefined || last === undefined) return;
    closed.current = undefined;
    restore(last.from);
    const { command } = last;
    if (command === undefined) return;
    command.run(last.event ?? pressed(command.hotkey));
    setSaid((before) => ({ label: command.label, count: (before?.count ?? 0) + 1 }));
    // A command that removed the element leaves focus with its dialog, once the page rendered.
    setTimeout(() => rescue(last.from), 0);
  }, [from]);
  // In the openers' scope, which every `HotkeyScope` lets through. Mod+/ opens it from a text field,
  // where `?` is typed. Pressed again while it is open, either closes it.
  useBindings(
    own.map((row) => ({
      ...row,
      run: () => (from === undefined ? show() : close())
    })),
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
        onClick: show
      },
      "?"
    ),
    // In the page's body, not beside the button: a dialog under a container the page hides at
    // this width would open modal with nothing drawn, and a live region there would say nothing.
    createPortal(
      createElement(
        "div",
        { class: "hotkey-announce", "aria-live": "polite" },
        said && createElement("span", { key: said.count }, said.label)
      ),
      document.body
    ),
    from !== undefined &&
      createPortal(
        createElement(HotkeyScope, {
          children: createElement(Sheet, {
            title,
            from,
            own,
            onClose: () => close(),
            onRun: close
          })
        }),
        document.body
      )
  );
}
