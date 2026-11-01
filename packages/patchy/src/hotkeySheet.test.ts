import { expect, it } from "vitest";
import { sections } from "./hotkeySheet.js";

it("lists named groups in first-seen order, then the ungrouped last under General", () => {
  expect(
    sections([
      { hotkey: "?", label: "Show shortcuts" },
      { hotkey: "G H", label: "Go home", group: "Navigation" },
      { hotkey: "C T", label: "Create task", group: "Tasks" },
      { hotkey: "Mod+K", label: "Search", group: "General" },
      { hotkey: "G T", label: "Go to timeline", group: "Navigation" }
    ])
  ).toEqual([
    [
      "Navigation",
      [
        { hotkey: "G H", label: "Go home", group: "Navigation" },
        { hotkey: "G T", label: "Go to timeline", group: "Navigation" }
      ]
    ],
    ["Tasks", [{ hotkey: "C T", label: "Create task", group: "Tasks" }]],
    [
      "General",
      [
        { hotkey: "Mod+K", label: "Search", group: "General" },
        { hotkey: "?", label: "Show shortcuts" }
      ]
    ]
  ]);
});

it("lists hotkeys as one list without a heading when none has a group", () => {
  const list = [
    { hotkey: "J", label: "Next" },
    { hotkey: "?", label: "Show shortcuts" }
  ];
  expect(sections(list)).toEqual([[undefined, list]]);
});
