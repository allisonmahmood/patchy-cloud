---
name: patchy-hotkeys
description: Add keyboard shortcuts to a Patchy page, such as Mod+K or G then H sequences, a shortcuts sheet or dialog-only keys; show a hotkey's keys; diagnose a hotkey that doesn't fire.
---

# Hotkeys

Read `../patchy-preact/SKILL.md` first. `patchy/hotkeys` gives tier 1 and 2 Preact
pages keyboard shortcuts. It is Patchy's API: don't import another hotkey package
or add `keydown` listeners for shortcuts.

```tsx
import { useHotkey } from "patchy/hotkeys";
import { patchy } from "../patchy/_generated/client.js";

useHotkey("G H", () => patchy.route.set("/"), { label: "Go home" });
useHotkey("Mod+K", openSearch, { label: "Search" });
useHotkey("Escape", closePanel, { enabled: panelOpen });
```

## Writing a hotkey

- A chord is keys joined by `+`: `"Mod+K"`, `"?"`, `"Escape"`, `"Alt+ArrowUp"`.
  `Mod` is ⌘ on a Mac and Ctrl elsewhere; `Control` is Ctrl everywhere. Modifiers
  come in the order Mod or Control, Alt, Shift. A letter matches either case and
  never implies Shift: `"g"` and `"G"` are the same key.
- Write a symbol as the character it types, `"?"` rather than `"Shift+/"`: it then
  fires on every keyboard layout and displays as the viewer sees it.
- A sequence is chords separated by single spaces: `"G H"`, `"C T"`. Each step must
  follow the last within a second. A single-key hotkey fires on its own press even when
  it starts a sequence, so `"G"` beside `"G H"` fires on every `G H`.
- On Windows and Linux `Mod` is Control, so `"Mod+K"` and `"Control+K"` are the same
  chord there and both fire.
- The type checker rejects a string that isn't a hotkey and names the step to fix.
  A hotkey built from data needs the `Chord` type: `const keys: Chord[] = ["1", "2"]`.
- `useHotkeys([{ hotkey, run, label }, …])` registers a list in one call, for lists
  that change length.

## When it fires

- While the component that registered it is mounted, and `enabled` isn't false.
- Patchy focuses the page when it opens. If the viewer clicks Patchy's own bar or a
  download card, keys go there until they click back into the page.
- While the viewer types in a field, single keys and Shift chords wait; Mod and
  Control chords and Escape fire. `whileTyping: true` or `false` overrides either way.
- A hotkey that fires stops the browser's own action for those keys, so a
  `whileTyping: true` letter isn't typed. Keys the browser keeps, such as Mod+T, Mod+W,
  Mod+N and Mod+L, never reach the page.
- Holding a chord fires it again with each key repeat, which suits `"J"` and `"K"`.
  `repeat: false` fires once per press, for chords that create or send.
- A focused button keeps Enter and Space, and a focused link keeps Enter.

## Dialogs and scopes

Wrap a dialog's content in `<HotkeyScope exclusive>`: while it is mounted only the
hotkeys registered inside it fire, so the page's `"C T"` doesn't open a second
dialog behind it. Without `exclusive`, a scope's hotkeys win over the same hotkey
outside it while it is mounted.

## Showing hotkeys

- `formatHotkey("Mod+K")` is `"⌘ K"` on a Mac and `"Ctrl+K"` elsewhere.
- `hotkeyKeys("G H")` returns each step's keys, `[["G"], ["H"]]`, for drawing keycaps.
- `useHotkeyList()` returns `{ hotkey, label }` for every labelled, enabled hotkey that
  is mounted, including those an exclusive scope holds back, for a shortcuts sheet behind
  `"?"`. Hotkeys of a dialog that isn't open aren't mounted, so they aren't listed.
