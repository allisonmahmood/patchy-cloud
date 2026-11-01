---
name: patchy-hotkeys
description: Add keyboard shortcuts to a Patchy page, such as Mod+K or G then H sequences, a shortcuts sheet or dialog-only keys; show a hotkey's keys; diagnose a hotkey that doesn't fire.
---

# Hotkeys

Read `../patchy-preact/SKILL.md` first. `patchy/hotkeys` gives tier 1 and 2 Preact pages
keyboard shortcuts. It is Patchy's API, and every shortcut registers through it: it
handles typing in fields, dialogs, keyboard layouts and ⌘ versus Ctrl.

```tsx
import { useHotkey } from "patchy/hotkeys";
import { patchy } from "../patchy/_generated/client.js";

useHotkey("G H", () => patchy.route.set("/"), { label: "Go home" });
useHotkey("Mod+K", openSearch, { label: "Search" });
useHotkey("Escape", closePanel, { enabled: panelOpen });
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
- While the viewer types in a text field, single keys, Shift chords and Alt chords wait; Mod
  chords and Escape fire. A text field is a text `<input>` or `<textarea>` that isn't
  read-only, a `<select>`, a contenteditable element, or an element with `role="textbox"` or
  `role="searchbox"`. Checkboxes, radios and ranges aren't text fields: single keys fire
  there, and the control keeps Space and the arrow keys. A focused button keeps Enter and
  Space, and a focused link keeps Enter.
- `whileTyping: true` fires in text fields and on a focused control's own keys, so a button's
  Enter or a checkbox's Space runs the hotkey instead. `whileTyping: false` makes Mod chords
  and Escape wait in text fields too.
- While an input method composes text, as for Japanese or Chinese, no hotkey fires: its
  keys, Enter, Escape and the arrows included, are the input method's.
- A hotkey that fires stops the browser's own action for those keys, so a `whileTyping: true`
  letter isn't typed. Keys the browser keeps, such as Mod+T, Mod+W, Mod+N and Mod+L, never
  reach the page.
- Hotkeys listen on the document, in the bubble phase, and one that fires stops the key's
  propagation there: `window` listeners never see it. Listeners that already ran, such as
  a field's own `onKeyDown`, and other document listeners still do. A field that stops a
  key's propagation keeps every hotkey from seeing it.
- Holding a chord fires it again with each key repeat; `repeat: false` fires it once per
  press. `repeat` only matters for a chord that can be held: a sequence fires once per
  completion.

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

`<HotkeySheet />` renders a `?` button where it is mounted. The button and the `?` key open a
sheet that lists every labelled hotkey, drawn with the company look's tokens. While it is open,
the page's hotkeys wait. Escape, its close button or a tap outside it closes it, and focus goes
back to where it was.

- `title` sets its heading and accessible name, "Keyboard shortcuts" by default. `hotkey` sets
  the key that opens it, `"?"` by default, checked like `useHotkey`'s.
- A hotkey's `group` option lists it under that heading. Groups appear in the order they are
  first registered, and ungrouped hotkeys, the sheet's own included, come last under General.
  With no groups at all, the sheet is one list.
- Its parts have `hotkey-*` classes, styled inside `@layer patchy-hotkeys`, so the patch's own
  unlayered CSS restyles any of them.
- A different sheet is built from `useHotkeyList` and `hotkeyKeys` inside a `HotkeyScope`.

## Showing hotkeys

- `formatHotkey("Mod+K")` is `"⌘ K"` on a Mac and `"Ctrl+K"` elsewhere.
- `hotkeyKeys("G H")` returns each step's keys, `[["G"], ["H"]]`, for drawing keycaps.
- A Mac shows Enter, Space, Backspace and Delete as ↵ ␣ ⌫ ⌦. Elsewhere they are words:
  `formatHotkey("Mod+Enter")` is `"⌘ ↵"` on a Mac and `"Ctrl+Enter"` elsewhere.
- Both take a hotkey, checked like `useHotkey`'s, or modifiers alone, such as `"Mod"` or
  `"Mod+Shift"`, for a hint like "⌘ scroll". A value typed as plain `string`, such as a
  `useHotkeyList` row's `hotkey`, isn't checked. A template such as `` `Mod+${n}` `` is
  checked like a literal, so type the pieces as `Chord` or `Key`.
- `useHotkeyList()` returns `{ hotkey, label, group }` for every labelled, enabled hotkey that
  is mounted, including those a `HotkeyScope` holds back. Hotkeys of a dialog that isn't open
  aren't mounted, so they aren't listed.
