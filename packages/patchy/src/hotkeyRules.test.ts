import { afterEach, expect, it, vi } from "vitest";
import {
  duplicateWarnings,
  fieldKeeps,
  permitted,
  steps,
  type Field,
  type Press
} from "./hotkeyRules.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const run = () => {};

it("skips a hotkey that binds Patchy's chord in any spelling or step, warning once each", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const bindings = [
    { hotkey: "Mod+K", run },
    { hotkey: "Mod+Shift+K", run },
    { hotkey: "G mod+shift+k", run },
    { hotkey: "Shift+Mod+K", run },
    { hotkey: "Mod+Shift+J", run }
  ];
  expect(permitted(bindings).map(({ hotkey }) => hotkey)).toEqual(["Mod+K", "Mod+Shift+J"]);
  expect(permitted(bindings)).toHaveLength(2);
  expect(warn.mock.calls).toEqual([
    [
      'patchy/hotkeys: "Mod+Shift+K" isn\'t registered. Patchy keeps Mod+Shift+K for its own shortcuts; choose another chord.'
    ],
    [
      'patchy/hotkeys: "G mod+shift+k" isn\'t registered. Patchy keeps Mod+Shift+K for its own shortcuts; choose another chord.'
    ],
    [
      'patchy/hotkeys: "Shift+Mod+K" isn\'t registered. Patchy keeps Mod+Shift+K for its own shortcuts; choose another chord.'
    ]
  ]);
});

it("warns once when two enabled hotkeys in one scope and place share a hotkey, naming both", () => {
  const warned = new Set<string>();
  const mounted = [
    { scope: "global", place: "page", hotkey: "Mod+K", label: "Search", enabled: true },
    { scope: "dialog", place: "page", hotkey: "Mod+K", label: "Find in dialog", enabled: true },
    { scope: "global", place: "element 1", hotkey: "Mod+K", label: "Find in list", enabled: true },
    { scope: "global", place: "page", hotkey: "Escape", label: "Close panel", enabled: true },
    { scope: "global", place: "page", hotkey: "Escape", label: "Close menu", enabled: false },
    { scope: "global", place: "page", hotkey: "Mod+K", label: "Open palette", enabled: true },
    { scope: "global", place: "element 1", hotkey: "Enter", label: "Open", enabled: true },
    { scope: "global", place: "element 2", hotkey: "Enter", label: "Save", enabled: true },
    { scope: "global", place: "element 1", hotkey: "Enter", label: "Edit", enabled: true }
  ];
  expect(duplicateWarnings(mounted, warned)).toEqual([
    'patchy/hotkeys: "Search" and "Open palette" both use Mod+K in the same scope, so both fire on each press.',
    'patchy/hotkeys: "Open" and "Edit" both use Enter within the same element, so both fire on each press.'
  ]);
  expect(duplicateWarnings(mounted, warned)).toEqual([]);
  expect(
    duplicateWarnings(
      [
        { scope: "global", place: "page", hotkey: "G H", enabled: true },
        { scope: "global", place: "page", hotkey: "G H", label: "Go home", enabled: true }
      ],
      new Set()
    )
  ).toEqual([
    'patchy/hotkeys: an unlabelled hotkey and "Go home" both use G H in the same scope, so both fire on each press.'
  ]);
});

// A keydown as `fieldKeeps` reads it: off a Mac unless `metaKey` stands in for Mod.
const press = (
  key: string,
  held: Partial<Omit<Press, "key" | "getModifierState">> & { altGraph?: boolean } = {}
): Press => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 0,
  ...held,
  getModifierState: (name) => name === "AltGraph" && held.altGraph === true
});
const kept =
  (field: Field, within: boolean, mac = false, whileTyping?: boolean) =>
  (event: Press) =>
    fieldKeeps(event, field, { within, whileTyping }, mac);

// No option lets a hotkey take these: `whileTyping: true` changes nothing here, and `within` only
// opens a one-line field's own Enter, Escape and arrows.
it("keeps every key that types, composes or edits with a text field, within it or not", () => {
  const typing = [
    press("a"),
    press("A", { shiftKey: true }),
    press("5"),
    press(" "),
    press("?", { shiftKey: true }),
    press("å", { altKey: true }),
    press("a", { altKey: true }),
    press("@", { ctrlKey: true, altKey: true, altGraph: true })
  ];
  const composing = [
    press("Process", { isComposing: true }),
    press("Enter", { isComposing: true }),
    press("Escape", { isComposing: true }),
    press("ArrowDown", { keyCode: 229 }),
    press("Dead"),
    press("Unidentified")
  ];
  const editing = [
    press("Backspace"),
    press("Backspace", { ctrlKey: true }),
    press("Delete", { altKey: true }),
    press("ArrowLeft"),
    press("ArrowRight", { ctrlKey: true, shiftKey: true }),
    press("Home", { shiftKey: true }),
    press("End"),
    press("ArrowUp", { shiftKey: true }),
    press("ArrowDown", { ctrlKey: true }),
    press("PageUp", { altKey: true }),
    press("a", { ctrlKey: true }),
    press("c", { ctrlKey: true }),
    press("x", { ctrlKey: true }),
    press("v", { ctrlKey: true }),
    press("z", { ctrlKey: true }),
    press("y", { ctrlKey: true }),
    press("Z", { ctrlKey: true, shiftKey: true }),
    press("V", { ctrlKey: true, shiftKey: true }),
    // A Russian layout's Ctrl+ф, on A's key, selects all too.
    { ...press("ф", { ctrlKey: true }), code: "KeyA" }
  ];
  for (const field of ["line", "lines", "rich"] as const)
    for (const within of [false, true])
      for (const whileTyping of [undefined, true])
        expect(
          [...typing, ...composing, ...editing].filter(
            (event) => !kept(field, within, false, whileTyping)(event)
          )
        ).toEqual([]);
});

it("keeps a field of lines' up, down, Page Up, Page Down and plain Enter, and rich text's B, I and U", () => {
  const lines = [
    press("ArrowUp"),
    press("ArrowDown"),
    press("PageUp"),
    press("PageDown"),
    press("Enter")
  ];
  for (const within of [false, true]) {
    expect(lines.filter(kept("lines", within))).toEqual(lines);
    expect(lines.filter(kept("rich", within))).toEqual(lines);
  }
  const formatting = ["b", "i", "u"].map((key) => press(key, { ctrlKey: true }));
  expect(formatting.filter(kept("rich", false))).toEqual(formatting);
  // In a plain field, Mod+B is a chord like any other.
  expect(formatting.filter(kept("lines", false))).toEqual([]);
  expect(formatting.filter(kept("line", false))).toEqual([]);
});

it("lets Mod chords and Escape out of a text field, and a one-line field's Enter and arrows to a hotkey within it", () => {
  const out = [
    press("k", { ctrlKey: true }),
    press("Enter", { ctrlKey: true }),
    press("s", { ctrlKey: true }),
    press("/", { ctrlKey: true }),
    press("A", { ctrlKey: true, shiftKey: true }),
    press("Escape"),
    press("Escape", { shiftKey: true })
  ];
  for (const field of ["line", "lines", "rich"] as const)
    for (const within of [false, true]) expect(out.filter(kept(field, within))).toEqual([]);
  const own = [press("Enter"), press("ArrowUp"), press("ArrowDown")];
  expect(own.filter(kept("line", true))).toEqual([]);
  expect(own.filter(kept("line", false))).toEqual(own);
  // Only those, and only bare: other single keys and Shift or Alt chords wait, within or not.
  const waiting = [
    press("Enter", { shiftKey: true }),
    press("ArrowDown", { altKey: true }),
    press("PageDown"),
    press("Tab"),
    press("F2")
  ];
  expect(waiting.filter(kept("line", true))).toEqual(waiting);
  // A field of lines keeps its plain Enter even from a hotkey within it.
  expect([press("Enter")].filter(kept("lines", true))).toHaveLength(1);
});

it("holds every key back from a whileTyping: false hotkey in a text field, even within the field", () => {
  const leaving = [
    press("k", { ctrlKey: true }),
    press("Enter", { ctrlKey: true }),
    press("Escape"),
    press("Enter"),
    press("ArrowDown")
  ];
  for (const field of ["line", "lines", "rich"] as const)
    for (const within of [false, true])
      expect(leaving.filter(kept(field, within, false, false))).toEqual(leaving);
  // A read-only field isn't a text field, so the option leaves its keys as they were.
  expect(kept("read-only", true, false, false)(press("Escape"))).toBe(false);
});

it("reads Mod as ⌘ on a Mac, where Ctrl+A is a chord the field doesn't own", () => {
  expect(kept("line", false, true)(press("a", { metaKey: true }))).toBe(true);
  expect(kept("line", false, true)(press("k", { metaKey: true }))).toBe(false);
  // ⌃A isn't Mod+A on a Mac, so it waits with the other keys that aren't Mod chords.
  expect(kept("line", false, true)(press("a", { ctrlKey: true }))).toBe(true);
  expect(kept("line", false, true)(press("Enter", { ctrlKey: true }))).toBe(true);
  expect(kept("line", false, true)(press("Enter", { metaKey: true }))).toBe(false);
});

it("leaves a read-only field its caret and selection keys and Mod with A and C, and fires the rest", () => {
  const keeps = [
    press("ArrowLeft"),
    press("ArrowRight", { shiftKey: true }),
    press("ArrowUp"),
    press("ArrowDown", { shiftKey: true }),
    press("Home"),
    press("End", { shiftKey: true }),
    press("PageUp"),
    press("PageDown", { shiftKey: true }),
    press("a", { ctrlKey: true }),
    press("c", { ctrlKey: true })
  ];
  const fires = [
    press("l"),
    press("?", { shiftKey: true }),
    press("Enter"),
    press("Escape"),
    press("Backspace"),
    press("k", { ctrlKey: true }),
    press("x", { ctrlKey: true }),
    press("z", { ctrlKey: true }),
    press("ArrowLeft", { ctrlKey: true })
  ];
  for (const within of [false, true]) {
    expect(keeps.filter(kept("read-only", within))).toEqual(keeps);
    expect(fires.filter(kept("read-only", within))).toEqual([]);
  }
});

it("splits a sequence into steps and gives a lone trailing letter its capital", () => {
  expect(steps("g  h")).toEqual(["G", "H"]);
  expect(steps("Mod+k")).toEqual(["Mod+K"]);
  expect(steps("Alt+ArrowUp ?")).toEqual(["Alt+ArrowUp", "?"]);
});
