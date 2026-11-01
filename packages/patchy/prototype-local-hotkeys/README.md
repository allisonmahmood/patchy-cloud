# Local hotkeys prototype

Prototype, never merged. A tasks patch that puts keys in three places, the page, a dialog and one
element, and the switches that compare each open decision. Every key goes through
`patchy/hotkeys`; the due-date picker's raw listener stands in for a third-party widget.

## Try it

From the checkout root:

```sh
pnpm dev
export PATCHY_STATE_DIR="$PWD/.local/patch-cli"
pnpm patchy init .local/local-hotkeys --purpose "Local hotkeys demo" --json
cp -r packages/patchy/prototype-local-hotkeys/demo/. .local/local-hotkeys/
cd .local/local-hotkeys && pnpm patchy refresh && pnpm patchy dev --json
```

Open the printed `url`. Then:

- **Element keys.** Click the list: ↑ ↓ move, X marks done, Enter renames. In the editor, Enter
  saves and Escape cancels; on the list, Escape is the page's and clears the selection.
- **Dialog keys from a field.** C then T opens Create task. Type in the description, then reach
  P then 5 or A the way the first switch says: ⌘/ (Ctrl+/) opens the sheet, Escape steps out of
  the field, or ⌘⌥ (Ctrl+Alt) chords.
- **Editing keys.** Type in "Add a task", then ⌘A and ⌘Z: they select and undo the text. On the
  list they select every task and undo the last change.
- **Handled keys.** In Create task, open the due-date picker with Enter and press Escape.
- **The sheet.** Press ? on the list, or ⌘/ inside Create task. Press a listed key in the sheet.

The first option of each switch is the design; the others are for comparing, and the editing and
handled-keys switches put back how `patchy/hotkeys` behaved before.
