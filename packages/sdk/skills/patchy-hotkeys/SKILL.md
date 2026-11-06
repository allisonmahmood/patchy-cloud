---
name: patchy-hotkeys
description: Add keyboard shortcuts to a Patchy page, such as Mod+K or G then H sequences, keys for one list or editor, a shortcuts sheet or dialog-only keys; show a hotkey's keys; diagnose a hotkey that doesn't fire.
---

# Hotkeys

Read `../patchy-preact/SKILL.md` first. `patchy/hotkeys` gives tier 1 and 2 Preact pages
keyboard shortcuts. It is Patchy's API, and every key a page handles registers through it,
keys for one element included: it handles typing in fields, dialogs, keyboard layouts and ⌘
versus Ctrl.

```tsx
import { useHotkey } from "patchy/hotkeys";
import { patchy } from "../patchy/_generated/client.js";

useHotkey("G H", () => patchy.route.set("/"), { label: "Go home" });
useHotkey("Mod+K", openSearch, { label: "Search" });
useHotkey("Escape", closePanel, { enabled: panelOpen });
useHotkey("Enter", saveTitle, { within: titleField });
```

## Writing a hotkey

- A chord is keys joined by `+`: `"Mod+K"`, `"?"`, `"Escape"`, `"Alt+ArrowUp"`. `Mod` is ⌘
  on a Mac and Ctrl elsewhere, and is how a chord writes either. Modifiers come in the
  order Mod, Alt, Shift. A letter matches either case and never implies Shift: `"g"` and
  `"G"` are the same key.
- A chord's modifiers match exactly: an extra one held stops it. `"ArrowLeft"` doesn't fire
  with Shift or Alt held, and `"J"` doesn't fire on Shift+J. The Shift a symbol takes to
  type, as for `"?"`, isn't extra.
- Patchy keeps `"Mod+Shift+K"` for its own shortcuts. The type checker refuses it, and one
  that arrives through a cast is skipped with a console warning.
- A sequence is chords separated by single spaces: `"G H"`, `"C T"`. Each step must follow
  the last within a second. A single-key hotkey fires on its own press even when it starts
  a sequence, so `"G"` beside `"G H"` fires on every `G H`.
- The type checker refuses a string that isn't a hotkey, naming the step to fix and what to
  write. A hotkey built from data needs the `Chord` type: `const keys: Chord[] = ["1", "2"]`.
  A table of bindings is `HotkeyBinding<Chord>[]`. `Chord` is one chord, so a table with
  sequences names them: `HotkeyBinding<Chord | "G H" | "G T">[]`.
- `useHotkeys([{ hotkey, run, label }, …])` registers a list in one call, for lists that
  change length.
- Two enabled hotkeys with the same keys in one scope both fire, and the console warns once,
  naming both labels.

## Keyboard layouts

- Write a symbol as the character it types, with a modifier too: `"?"`, `"+"` and `"Mod++"`,
  not `"Shift+/"` or `"Shift+="`. Every ASCII symbol is a key. A letter or a bare symbol
  matches the character the viewer's layout types, so `"?"` fires wherever they type `?`,
  `"+"` fires from the numpad and a German keyboard's `+` key, and each displays as they see
  it.
- A key falls back to its US position when what it typed can't name a shortcut:
  - a non-Latin letter or symbol, or a dead key: the Russian key in J's place fires `"J"`,
    and ⌥- on a Mac, which types `–`, fires `"Alt+-"`;
  - anything on the digit row: AZERTY's `&` key fires `"1"` and `"Mod+1"`;
  - an ASCII symbol typed with Shift: Ctrl+Shift+/ on a US keyboard types `?` and fires
    `"Mod+Shift+/"`;
  - a non-ASCII Latin letter typed with Alt, or with Mod on a punctuation key: ⌥A on a Mac
    types `å` and fires `"Alt+A"`, and German ⌘Ü fires `"Mod+["`.
- Anything else matches only what it typed: a named key, a letter A–Z, an ASCII symbol
  typed without Shift, or German `ü` on its own. So an unshifted symbol with Mod fires only
  on layouts that type it on that key: AZERTY's ⌘= fires `"Mod+="`, never `"Mod+/"` from
  the key in `/`'s US position.

## When it fires

- While the component that registered it is mounted and `enabled` isn't false. A disabled
  hotkey also leaves `useHotkeyList` and the sheet, so tying `enabled` to a button's state
  makes its row come and go. To keep it listed, check the condition in `run` instead.
- Patchy focuses the page when it opens. If the viewer clicks Patchy's own bar or a download
  card, keys go there until they click back into the page.
- In a text field, the field keeps its keys, whatever a hotkey's options say. A text field is
  a text `<input>` or `<textarea>` that isn't read-only, a `<select>`, a contenteditable
  element, or an element with `role="textbox"` or `role="searchbox"`. It keeps:
  - every key that types a character, Shift and Alt chords included;
  - an input method's composition and dead keys: while one composes, as for Japanese or
    Chinese, its keys, Enter, Escape and the arrows included, are the input method's;
  - Backspace, Delete, ← → Home and End, with any modifiers;
  - ↑ ↓ Page Up and Page Down, with a modifier, or bare in a field of lines (a `<textarea>` or
    contenteditable);
  - plain Enter in a field of lines;
  - Mod with A, C, X, V, Z or Y, Mod+Shift with Z or V, and in contenteditable Mod with B, I
    or U.
- So a page's `"Mod+A"` "Select all" or `"Mod+Z"` "Undo" needs no guard for fields. From a
  text field, other Mod chords fire, `"Mod+Enter"`, `"Mod+K"` and `"Mod+S"` included,
  and so does Escape. A hotkey `within` a one-line field takes its plain Enter, Escape, ↑ and ↓,
  as a combobox or an inline editor needs; a field of lines keeps its plain Enter. Every other
  key waits.
- A read-only `<input>` or `<textarea>` isn't a text field: single keys fire there. It keeps its
  caret and selection keys, the arrows, Home, End, Page Up and Page Down with or without Shift,
  and Mod with A and C.
- Checkboxes, radios and ranges aren't text fields: single keys fire there, and the control
  keeps Space and the arrow keys. A focused button keeps Enter and Space, a focused link keeps
  Enter, and a focused `role="listbox"`, `menu`, `tree` or non-editable `combobox` keeps its
  arrows, Home and End, and every printable key for typeahead.
- `whileTyping: true` fires on a focused control's own keys, so a button's Enter or a
  checkbox's Space runs the hotkey instead. In text fields it changes nothing.
  `whileTyping: false` makes a hotkey wait in every text field, Mod chords and Escape included,
  even one it is `within`.
- A key something on the page already handled with `preventDefault()`, such as a date picker's
  Escape or a form's own Enter, fires no hotkey and steps no sequence. A widget handles its key
  before Patchy sees it: in a listener on its element, in its own `onKeyDown`, or in the capture
  phase. Keys Patchy took don't count, so `"G"` beside `"G H"` fires on every `G H`.
- A hotkey that fires stops the browser's own action for those keys. Keys the browser keeps,
  such as Mod+T, Mod+W, Mod+N and Mod+L, never reach the page.
- Hotkeys listen on the document, or on their element for `within`, in the bubble phase, and
  one that fires stops the key's propagation there: bubble-phase `window` listeners never see
  it. Listeners that already ran, such as a field's own `onKeyDown` or a `window` capture
  listener, still do. A field that stops a key's propagation keeps every hotkey from seeing it.
- Holding a chord fires it again with each key repeat; `repeat: false` fires it once per
  press. `repeat` only matters for a chord that can be held: a sequence fires once per
  completion.

## Keys for one element

`within: ref` makes a hotkey fire only while focus is on that element or inside it, as CSS
`:focus-within` reads it. Use it for keys that belong to one part of the page: arrows in a list
or a chart, Enter and Escape in an inline editor, Enter in a quick-add field. Write these as
hotkeys, not `onKeyDown`, and don't fake them with `enabled`.

A keyboard list keeps focus on the list and draws the active row from state:

```tsx
import { useRef, useState } from "patchy/preact";
import { useHotkeys } from "patchy/hotkeys";

function TaskList(props: {
  tasks: readonly { id: string; title: string }[];
  open: (id: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const current = props.tasks[active];
  const group = "Tasks";
  useHotkeys([
    {
      hotkey: "ArrowDown",
      run: () => setActive((at) => Math.min(at + 1, props.tasks.length - 1)),
      within: list,
      label: "Next task",
      group
    },
    {
      hotkey: "ArrowUp",
      run: () => setActive((at) => Math.max(at - 1, 0)),
      within: list,
      label: "Previous task",
      group
    },
    {
      hotkey: "Enter",
      run: () => current && props.open(current.id),
      within: list,
      label: "Open task",
      group
    }
  ]);
  return (
    <ul
      ref={list}
      role="listbox"
      tabIndex={0}
      aria-label="Tasks"
      aria-activedescendant={current && `task-${current.id}`}
    >
      {props.tasks.map((task, at) => (
        <li key={task.id} id={`task-${task.id}`} role="option" aria-selected={at === active}>
          {task.title}
        </li>
      ))}
    </ul>
  );
}
```

An inline editor's keys are within its field:

```tsx
const field = useRef<HTMLInputElement>(null);
useHotkey("Enter", save, { within: field, label: "Save title" });
useHotkey("Escape", cancel, { within: field, label: "Cancel" });
return <input ref={field} aria-label="Title" />;
```

- The narrowest place wins: an element's hotkey, then the dialog's, then the page's. A key the
  element doesn't take, because its hotkey is disabled or the key is the field's, goes on to the
  next place out. An element's key also beats a sequence further out that is under way: with
  `"H"` within a list, the page's `"G H"` doesn't take H from the list.
- A key an element's sequence takes as a step, its first included, is no step for a sequence
  further out. With `"H X"` within a panel, the page's `"G H"` doesn't complete on H there; with
  `"G H"` within a chart, the page's `"G T"` can't start there. Chords further out still fire,
  so the page's `"G"` fires on that G.
- `within` follows the DOM, not the component tree: a popup portalled to `<body>` isn't inside
  its trigger.
- A focused `role="listbox"` keeps every printable key for typeahead, `?` included, so the
  page's single-key hotkeys, such as `"C T"` and the sheet's `?`, wait while it has focus;
  hotkeys within it get them, and Mod+/ still opens the sheet. Keep the listbox role: it is
  what screen readers announce as the list.
- The ref can hold any element, SVG included, for a keyboard chart. Preact writes an SVG
  element's attributes as given, so make one focusable with a lowercase `tabindex`:
  `<svg tabindex={0}>`.
- Inside a `HotkeyScope`, an element's hotkeys belong to the dialog.
- Until the element renders, the hotkey isn't registered. The ref is read after each render of
  the component that registers the hotkey, so an element that changes because only a child
  re-rendered is picked up at that component's next render.
- Two enabled hotkeys with the same keys within one element both fire, and the console warns.
  The same keys on the page and on an element don't warn: the element's wins there.

## Dialogs and scopes

Wrap a dialog's content in `<HotkeyScope>`. While it is mounted, only the hotkeys registered
inside it fire; the page's own, sequences included, wait until it unmounts, so the page's
`"C T"` doesn't open a second dialog behind it.

Inside means registered by a component the scope renders. A hotkey registered by the
component that renders `<HotkeyScope>` is outside it, and the scope holds it back like the
page's. Register the dialog's own keys, such as its Escape, in a component within:

```tsx
import { useLayoutEffect, useRef } from "patchy/preact";
import { HotkeyScope, useHotkey } from "patchy/hotkeys";

function Dialog(props: { close: () => void }) {
  return (
    <HotkeyScope>
      <DialogBody close={props.close} />
    </HotkeyScope>
  );
}

function DialogBody(props: { close: () => void }) {
  const title = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => title.current?.focus(), []);
  useHotkey("Escape", props.close, { label: "Close" });
  return (
    <div role="dialog" aria-label="New task">
      <input ref={title} aria-label="Title" />
    </div>
  );
}
```

A dialog opened by a hotkey moves focus into itself from code, as above. A patch's page runs
in a cross-origin frame, where browsers ignore `autofocus`, so typing would otherwise go
nowhere.

The scope already holds the page's hotkeys back, so leave them enabled while a dialog is
open. `useHotkeyList` lists only enabled hotkeys, so a page hotkey disabled for the dialog
also drops off a shortcuts sheet.

A held hotkey doesn't block its keys, so the browser acts on them: with a dialog open,
Ctrl+K reaches the browser's address bar. A hotkey registered inside the scope keeps its
keys from the browser.

### A dialog's keys from its fields

A dialog's single keys, such as `"P 5"` or `"A"`, wait while the viewer types in its fields.
The viewer reaches them through the shortcuts sheet: from a field, Mod+/ opens it over the
dialog, listing the dialog's commands, and a command's keys pressed there run it and put the
caret back. Label a dialog's keys and give them its group, so the sheet lists them. A button in
the dialog that shows its shortcuts calls `openHotkeySheet()`. Mod chords, such as `"Mod+Enter"`
to create, fire from the field directly; don't add chords for the dialog's other keys.

### Native `<dialog>`

A `<dialog>` opened with `showModal()` closes itself on Escape and fires `cancel`. A live
Escape hotkey prevents that: it takes the key, the dialog gets no `cancel` and stays open.
Wrap the dialog in a `HotkeyScope`, so the page's own Escape is held back, and close it one
way:

- Register no Escape inside, and close from `onCancel`, as `HotkeySheet` does.
- Or register Escape inside, and close from its `run`.

```tsx
function Dialog(props: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <HotkeyScope>
      <dialog ref={dialog} aria-label="New task" onCancel={props.close}>
        <button type="button" onClick={props.close}>
          Close
        </button>
      </dialog>
    </HotkeyScope>
  );
}
```

The open state is the parent's: the dialog opens as it mounts and closes as it unmounts,
which returns focus to where it was. Opening and closing in a layout effect keeps focus
returning; a passive effect's cleanup runs after the dialog has left the page.

## The shortcuts sheet

Mount one `<HotkeySheet />` per page. It renders a `?` button where it is mounted. The button,
`?` and Mod+/ open a sheet over the whole page, inside dialogs too, drawn with the company
look's tokens, even where the button sits in a sidebar hidden at the viewer's width. Mod+/
opens it from a text field, where `?` is typed.

The sheet lists the commands for the current context: the labelled hotkeys that work where
focus was. In a dialog, the dialog's; in a list with `within` keys, the list's, then the
page's; where two share keys, the narrower one. Its openers list last, as "Show shortcuts", so a
viewer who finds it once learns Mod+/.

- Each command is a button: Tab moves through them, and Enter, Space or a click runs one.
  Pressing a command's keys while the sheet is open does the same. The sheet closes, focus and
  the text selection go back where they were, caret included, then the command runs. A command
  that moves focus, such as by opening another dialog, keeps it there. A command that removes
  the focused element leaves focus with its dialog, or on the page. A polite live region
  announces the command's label.
- Escape and Tab are the sheet's while it is open, at every step: Escape closes it and Tab
  moves through its buttons. A command whose keys use either, such as `"G Escape"` or
  `"Tab A"`, runs from its button alone there.
- Other hotkeys wait while it is open. Escape, its close button or a tap outside it closes the
  sheet alone, never a dialog under it, and focus goes back to where it was.
- `title` sets its heading and accessible name, "Keyboard shortcuts" by default. `hotkey` sets
  the key that opens it, checked like `useHotkey`'s, in place of `?` and Mod+/.
- A hotkey's `group` option lists it under that heading. Groups appear in the order they are
  first registered, an element's before the page's, and ungrouped hotkeys come last under
  General. With no groups at all, the
  sheet is one list.
- The sheet's own "Show shortcuts" rows list after the commands, wherever they sit. Its `group`
  prop puts them in one of the page's groups, `<HotkeySheet group="Navigation" />`, so grouped
  keys don't leave them a General column of their own.
- `openHotkeySheet()` opens the mounted sheet from a control of the page's own, such as a menu
  item or a dialog's Shortcuts button. It lists the commands where that control is, and focus
  goes back there when it closes, as with the `?` button. A menu that closes on selection takes
  its item away, so focus the menu's trigger before calling it, and focus returns there.
- With the company look, the `?` button is one of the look's buttons, square. Without a look,
  the sheet and button take the page's font and text colour.
- Element rules in the page's stylesheets, layered or not, don't reach the sheet. Its unlayered
  rules with a class, attribute or pseudo-class can, `button:hover` included, and so can layers
  declared after the sheet first mounts; the `?` button also takes the page's layered styles, as
  its own buttons do. Restyle the sheet with unlayered rules aimed at its `hotkey-*` classes,
  and name a state with the class to restyle one: `.hotkey-opener:hover`. The sheet renders in
  the page's `<body>`, outside the patch's root element, so restyle it with selectors that don't
  depend on where it's mounted, such as `.hotkey-sheet …`, and set `--look-*` overrides on
  `:root` or `body`.
- A sheet of your own is a dialog: focus moves into it as it opens, Tab stays inside it, Escape
  closes it, and focus goes back as it closes. Build it from `useHotkeyList` and `hotkeyKeys`
  inside a `HotkeyScope`, in a `<dialog>` opened and closed as under Native `<dialog>`, which
  does all of that except keep Tab inside. Tab past its last control, or Shift+Tab before its
  first, leaves the patch's frame for Patchy's bar, and keys go there: in Chromium, Escape stops
  closing the sheet. So Tab on its last control moves to its first, and Shift+Tab on its first to
  its last. `HotkeySheet` already does all of this, and runs each command from its button or its
  keys; build your own when its listing or look won't do.

## Showing hotkeys

- `formatHotkey("Mod+K")` is `"⌘ K"` on a Mac and `"Ctrl+K"` elsewhere.
- `hotkeyKeys("G H")` returns each step's keys, `[["G"], ["H"]]`, for drawing keycaps.
- A Mac shows Enter, Space, Backspace, Delete and Tab as ↵ ␣ ⌫ ⌦ ⇥. Elsewhere they are words:
  `formatHotkey("Mod+Enter")` is `"⌘ ↵"` on a Mac and `"Ctrl+Enter"` elsewhere.
- Both take a hotkey, checked like `useHotkey`'s, or modifiers alone, such as `"Mod"` or
  `"Mod+Shift"`, for a hint like "⌘ scroll". A value typed as plain `string`, such as a
  `useHotkeyList` row's `hotkey`, isn't checked. A template such as `` `Mod+${n}` `` is
  checked like a literal, so type the pieces as `Chord` or `Key`.
- `useHotkeyList()` returns `{ hotkey, label, group }` for every labelled, enabled hotkey that
  is mounted, including those a `HotkeyScope` holds back and those `within` an element without
  focus. Hotkeys of a dialog that isn't open aren't mounted, so they aren't listed.
