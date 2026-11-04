import { expect, it } from "vitest";
import type { ListedHotkey } from "./hotkeys.js";
import { narrowest, sections } from "./hotkeySheet.js";

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

it("lists the sheet's own rows after the commands, in whichever section their group puts them", () => {
  const own = [
    { hotkey: "?", label: "Show shortcuts", group: "Navigation" },
    { hotkey: "Mod+/", label: "Show shortcuts", group: "Navigation" }
  ];
  expect(
    sections(
      [
        { hotkey: "C T", label: "Create task", group: "Tasks" },
        { hotkey: "G H", label: "Go home", group: "Navigation" }
      ],
      own
    )
  ).toEqual([
    ["Tasks", [{ hotkey: "C T", label: "Create task", group: "Tasks" }]],
    ["Navigation", [{ hotkey: "G H", label: "Go home", group: "Navigation" }, ...own]]
  ]);
  const ungrouped: ListedHotkey[] = [
    { hotkey: "?", label: "Show shortcuts" },
    { hotkey: "Mod+/", label: "Show shortcuts" }
  ];
  expect(sections([{ hotkey: "J", label: "Next" }], ungrouped)).toEqual([
    [undefined, [{ hotkey: "J", label: "Next" }, ...ungrouped]]
  ]);
  expect(
    sections([{ hotkey: "P 5", label: "Priority 5", group: "Create task" }], ungrouped)
  ).toEqual([
    ["Create task", [{ hotkey: "P 5", label: "Priority 5", group: "Create task" }]],
    ["General", ungrouped]
  ]);
});

it("lists, of the commands sharing keys where focus was, the narrowest, narrowest first", () => {
  // Focus in an editor (depth 7) inside a list (depth 5) on the page (-1).
  expect(
    narrowest([
      { hotkey: "Enter", label: "Open", depth: -1 },
      { hotkey: "Mod+K", label: "Search", depth: -1 },
      { hotkey: "Enter", label: "Open task", depth: 5 },
      { hotkey: "ArrowDown", label: "Next task", depth: 5 },
      { hotkey: "Escape", label: "Close panel", depth: -1 },
      { hotkey: "Enter", label: "Save title", depth: 7 },
      { hotkey: "Escape", label: "Cancel", depth: 7 },
      { hotkey: "Mod+K", label: "Search again", depth: -1 }
    ])
  ).toEqual([
    { hotkey: "Enter", label: "Save title", depth: 7 },
    { hotkey: "Escape", label: "Cancel", depth: 7 },
    { hotkey: "ArrowDown", label: "Next task", depth: 5 },
    { hotkey: "Mod+K", label: "Search", depth: -1 }
  ]);
});
