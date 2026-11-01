import { afterEach, expect, it, vi } from "vitest";
import { typecheck } from "../../../test/typescript.js";
import { formatHotkey, hotkeyKeys } from "./hotkeys.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

// TanStack reads the platform from the navigator each time it formats.
const on = (platform: string) => vi.stubGlobal("navigator", { platform, userAgent: "" });

it("accepts chords, sequences, data-built chords and a sheet against the published types", () => {
  const source = `import { HotkeySheet, useHotkey, useHotkeys, type Chord, type HotkeyBinding } from "patchy/hotkeys";
const run = () => {};
useHotkey("Mod+K", run);
useHotkey("?", run);
useHotkey("+", run);
useHotkey("Mod++", run);
useHotkey("G +", run);
const shifted: Chord[] = ["~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "{", "}", "|", ":", '"', "<", ">", "?"];
for (const hotkey of shifted) useHotkey(hotkey, run);
useHotkey("G H", run, { label: "Go home", group: "Navigation" });
useHotkey("Alt+ArrowUp", run);
const digits: Chord[] = ["1", "2"];
useHotkeys(digits.map((hotkey) => ({ hotkey, run })));
for (const hotkey of digits) useHotkey(hotkey, run);
const table: HotkeyBinding<Chord | "G H">[] = [{ hotkey: "Mod+K", run }, { hotkey: "G H", run }];
useHotkeys(table);
HotkeySheet({});
HotkeySheet({ title: "Tracker shortcuts", hotkey: "Mod+/" });
`;
  expect(typecheck({ "consumer.ts": source })).toEqual([]);
});

it("refuses each string that isn't a hotkey, saying what to write instead", () => {
  const refused = {
    "Ctrl+K": "'Ctrl+K' isn't a chord: write 'Mod+K', which is ⌘ on a Mac and Ctrl elsewhere",
    "Control+K": "'Control+K' isn't a chord: write 'Mod+K', which is ⌘ on a Mac and Ctrl elsewhere",
    "Cmd+K": "'Cmd+K' isn't a chord: write 'Mod+K', which is ⌘ on a Mac and Ctrl elsewhere",
    Esc: "'Esc' isn't a chord: write keys like 'Mod+K', 'Escape', '?' or 'G H', modifiers in the order Mod, Alt, Shift",
    "Shift+Mod+K":
      "'Shift+Mod+K' isn't a chord: write keys like 'Mod+K', 'Escape', '?' or 'G H', modifiers in the order Mod, Alt, Shift",
    "Mod+Shift+K": "'Mod+Shift+K' is kept by Patchy for its own shortcuts: choose another chord",
    "Mod+Shift+k": "'Mod+Shift+k' is kept by Patchy for its own shortcuts: choose another chord",
    "G Mod+Shift+K": "'Mod+Shift+K' is kept by Patchy for its own shortcuts: choose another chord",
    "Ctrl+Shift+K": "'Mod+Shift+K' is kept by Patchy for its own shortcuts: choose another chord",
    "Ctrl++": "'Ctrl++' isn't a chord: write 'Mod++', which is ⌘ on a Mac and Ctrl elsewhere",
    "Mod+":
      "'Mod+' isn't a chord: write keys like 'Mod+K', 'Escape', '?' or 'G H', modifiers in the order Mod, Alt, Shift",
    "G  H": "'G  H' isn't a hotkey: separate its steps with one space, as in 'G H'"
  };
  const source = [
    'import { useHotkey } from "patchy/hotkeys";',
    ...Object.keys(refused).map((hotkey) => `useHotkey(${JSON.stringify(hotkey)}, () => {});`)
  ].join("\n");
  // tsc names the file relative to its own working directory.
  const lines = typecheck({ "consumer.ts": source }).map((line) =>
    line.slice(line.indexOf("consumer.ts"))
  );
  expect(lines).toEqual(
    Object.entries(refused).map(
      ([hotkey, message], index) =>
        `consumer.ts(${index + 2},11): error TS2345: Argument of type '${JSON.stringify(hotkey)}' is not assignable to parameter of type '"${message}"'.`
    )
  );
});

it("refuses a sheet's opening hotkey that isn't one, as useHotkey does", () => {
  const source = `import { HotkeySheet } from "patchy/hotkeys";
HotkeySheet({ hotkey: "Ctrl+/" });
`;
  const lines = typecheck({ "consumer.ts": source }).map((line) =>
    line.slice(line.indexOf("consumer.ts"))
  );
  expect(lines).toEqual([
    `consumer.ts(2,15): error TS2322: Type '"Ctrl+/"' is not assignable to type '"'Ctrl+/' isn't a chord: write 'Mod+/', which is ⌘ on a Mac and Ctrl elsewhere"'.`
  ]);
});

it("shows Enter, Space, Backspace and Delete as words off a Mac, and as symbols on one", () => {
  for (const platform of ["Win32", "Linux x86_64"]) {
    on(platform);
    expect(formatHotkey("Mod+Enter")).toBe("Ctrl+Enter");
    expect(formatHotkey("Mod")).toBe("Ctrl");
    expect(hotkeyKeys("Space Shift+Backspace Delete")).toEqual([
      ["Space"],
      ["Shift", "Backspace"],
      ["Delete"]
    ]);
  }
  on("MacIntel");
  expect(formatHotkey("Mod+Enter")).toBe("⌘ ↵");
  expect(formatHotkey("Mod")).toBe("⌘");
  expect(hotkeyKeys("Space Shift+Backspace Delete")).toEqual([["␣"], ["⇧", "⌫"], ["⌦"]]);
});

it("checks what formatHotkey and hotkeyKeys show, allowing modifiers alone and listed hotkeys", () => {
  const source = `import { formatHotkey, hotkeyKeys, useHotkeyList, type Chord } from "patchy/hotkeys";
formatHotkey("Mod+K");
formatHotkey("G H");
formatHotkey("Mod");
formatHotkey("Mod+Shift");
hotkeyKeys("Mod+Alt+Shift");
hotkeyKeys("Alt+ArrowUp ?");
const digits: Chord[] = ["1", "2"];
for (const hotkey of digits) formatHotkey(hotkey);
for (const { hotkey } of useHotkeyList()) hotkeyKeys(hotkey);
formatHotkey("Mod+Entr");
hotkeyKeys("Ctrl+K");
`;
  const lines = typecheck({ "consumer.ts": source }).map((line) =>
    line.slice(line.indexOf("consumer.ts"))
  );
  expect(lines).toEqual([
    `consumer.ts(11,14): error TS2345: Argument of type '"Mod+Entr"' is not assignable to parameter of type '"'Mod+Entr' isn't a chord: write keys like 'Mod+K', 'Escape', '?' or 'G H', modifiers in the order Mod, Alt, Shift"'.`,
    `consumer.ts(12,12): error TS2345: Argument of type '"Ctrl+K"' is not assignable to parameter of type '"'Ctrl+K' isn't a chord: write 'Mod+K', which is ⌘ on a Mac and Ctrl elsewhere"'.`
  ]);
});
