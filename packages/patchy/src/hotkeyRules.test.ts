import { afterEach, expect, it, vi } from "vitest";
import { duplicateWarnings, permitted, steps } from "./hotkeyRules.js";

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

it("warns once when two enabled hotkeys in one scope share a hotkey, naming both", () => {
  const warned = new Set<string>();
  const mounted = [
    { scope: "global", hotkey: "Mod+K", label: "Search", enabled: true },
    { scope: "dialog", hotkey: "Mod+K", label: "Find in dialog", enabled: true },
    { scope: "global", hotkey: "Escape", label: "Close panel", enabled: true },
    { scope: "global", hotkey: "Escape", label: "Close menu", enabled: false },
    { scope: "global", hotkey: "Mod+K", label: "Open palette", enabled: true }
  ];
  expect(duplicateWarnings(mounted, warned)).toEqual([
    'patchy/hotkeys: "Search" and "Open palette" both use Mod+K in the same scope, so both fire on each press.'
  ]);
  expect(duplicateWarnings(mounted, warned)).toEqual([]);
  expect(
    duplicateWarnings(
      [
        { scope: "global", hotkey: "G H", enabled: true },
        { scope: "global", hotkey: "G H", label: "Go home", enabled: true }
      ],
      new Set()
    )
  ).toEqual([
    'patchy/hotkeys: an unlabelled hotkey and "Go home" both use G H in the same scope, so both fire on each press.'
  ]);
});

it("splits a sequence into steps and gives a lone trailing letter its capital", () => {
  expect(steps("g  h")).toEqual(["G", "H"]);
  expect(steps("Mod+k")).toEqual(["Mod+K"]);
  expect(steps("Alt+ArrowUp ?")).toEqual(["Alt+ArrowUp", "?"]);
});
