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
- Patchy keeps `"Mod+Shift+K"` for its own shortcuts. The type checker refuses it, and one
  that arrives through a cast is skipped with a console warning.
- A sequence is chords separated by single spaces: `"G H"`, `"C T"`. Each step must follow
  the last within a second. A single-key hotkey fires on its own press even when it starts
  a sequence, so `"G"` beside `"G H"` fires on every `G H`.
- The type checker refuses a string that isn't a hotkey, naming the step to fix and what to
  write. A hotkey built from data needs the `Chord` type: `const keys: Chord[] = ["1", "2"]`.
- `useHotkeys([{ hotkey, run, label }, …])` registers a list in one call, for lists that
  change length.
- Two enabled hotkeys with the same keys in one scope both fire, and the console warns once,
  naming both labels.

## Keyboard layouts

- Write a symbol as the character it types: `"?"`, not `"Shift+/"`. A letter or a bare
  symbol matches the character the viewer's layout types, so `"?"` fires wherever they type
  `?`, and it displays as they see it.
- A key falls back to its US position only when what it typed can't name a shortcut: a
  non-Latin letter, so `"J"` fires from the Russian key in J's place; the digit row, so
  AZERTY's `&` key fires `"1"` and `"Mod+1"`; and a Latin letter on a punctuation key with
  Mod, so German ⌘Ü fires `"Mod+["`.
- Any other symbol with Mod matches only the character the layout types on that key, so it
  fires only on layouts that have it there: AZERTY's ⌘= fires `"Mod+="`, never `"Mod+/"`
  from the key in `/`'s US position.

## When it fires

- While the component that registered it is mounted and `enabled` isn't false.
- Patchy focuses the page when it opens. If the viewer clicks Patchy's own bar or a download
  card, keys go there until they click back into the page.
- While the viewer types in a text field, single keys and Shift chords wait; Mod chords and
  Escape fire. `whileTyping: true` or `false` overrides either way. Checkboxes, radios and
  ranges aren't text fields: single keys fire there, and the control keeps Space and the
  arrow keys.
- A focused button keeps Enter and Space, and a focused link keeps Enter.
- A hotkey that fires stops the browser's own action for those keys, so a `whileTyping: true`
  letter isn't typed. Keys the browser keeps, such as Mod+T, Mod+W, Mod+N and Mod+L, never
  reach the page.
- Holding a chord fires it again with each key repeat; `repeat: false` fires it once per
  press. `repeat` only matters for a chord that can be held: a sequence fires once per
  completion.

## Dialogs and scopes

Wrap a dialog's content in `<HotkeyScope>`. While it is mounted, only the hotkeys registered
inside it fire; the page's own, sequences included, wait until it unmounts, so the page's
`"C T"` doesn't open a second dialog behind it.

## Showing hotkeys

- `formatHotkey("Mod+K")` is `"⌘ K"` on a Mac and `"Ctrl+K"` elsewhere.
- `hotkeyKeys("G H")` returns each step's keys, `[["G"], ["H"]]`, for drawing keycaps.
- `useHotkeyList()` returns `{ hotkey, label }` for every labelled, enabled hotkey that is
  mounted, including those a `HotkeyScope` holds back, for a shortcuts sheet behind `"?"`.
  Hotkeys of a dialog that isn't open aren't mounted, so they aren't listed.
