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

it("lists the sheet's own row after the page's hotkeys, in whichever section it sits", () => {
  const own = { hotkey: "?", label: "Show shortcuts" };
  expect(
    sections(
      [
        { ...own, group: "Navigation" },
        { hotkey: "C T", label: "Create task", group: "Tasks" },
        { hotkey: "G H", label: "Go home", group: "Navigation" }
      ],
      own
    )
  ).toEqual([
    ["Tasks", [{ hotkey: "C T", label: "Create task", group: "Tasks" }]],
    [
      "Navigation",
      [
        { hotkey: "G H", label: "Go home", group: "Navigation" },
        { ...own, group: "Navigation" }
      ]
    ]
  ]);
  expect(
    sections([own, { hotkey: "Mod+K", label: "Search" }, { hotkey: "J", label: "Next" }], own)
  ).toEqual([
    [undefined, [{ hotkey: "Mod+K", label: "Search" }, { hotkey: "J", label: "Next" }, own]]
  ]);
});

it("knows its own row when the registration writes its hotkey differently, as `J` for `j`", () => {
  expect(
    sections(
      [
        { hotkey: "J", label: "Show shortcuts", group: "Navigation" },
        { hotkey: "G H", label: "Go home", group: "Navigation" }
      ],
      { hotkey: "j", label: "Show shortcuts" }
    )
  ).toEqual([
    [
      "Navigation",
      [
        { hotkey: "G H", label: "Go home", group: "Navigation" },
        { hotkey: "J", label: "Show shortcuts", group: "Navigation" }
      ]
    ]
  ]);
});
