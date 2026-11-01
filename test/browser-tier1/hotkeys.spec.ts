import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import type { Instance } from "./instance.js";

// packages/patchy/src/hotkeys.test.ts and hotkeyRules.test.ts own the types and the warnings'
// words. These pages prove what only a browser shows: real key events reaching patchy/hotkeys in
// the published frame, in fields, controls, a scope, an input method's composition, other layouts
// and on a Mac, a held key across a remount, the conflict warning waiting until every hook's
// update has landed, and the sheet behaving as a dialog.
test.skip(({ browserName }) => browserName !== "chromium", "The SDK targets Chromium desktop.");
const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
const source = `import { render, useEffect, useState } from "patchy/preact";
import { createClient } from "patchy/client";
import { HotkeyScope, formatHotkey, useHotkey, useHotkeyList } from "patchy/hotkeys";

const client = createClient({ tables: {}, files: {} });
const fired: string[] = [];
const log = (name: string) => () => { fired.push(name); };
// Keys that reach the window while an input method composes, and whether anything prevented them.
// Safari's keydown that commits a composition comes after compositionend, with keyCode 229.
const composing: string[] = [];
window.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) composing.push(\`\${event.key} \${event.defaultPrevented ? "prevented" : "untouched"}\`);
});
Object.assign(window, { fired, composing });

function Shortcuts(props: { close: () => void }) {
  useHotkey("Escape", props.close, { label: "Close shortcuts" });
  useHotkey("G H", log("sheet G H"));
  return <ul id="listed">{useHotkeyList().map((item) => <li>{item.label}: {item.hotkey}</li>)}</ul>;
}

function App() {
  const [route, setRoute] = useState("");
  const [sheet, setSheet] = useState(false);
  useEffect(() => client.route.subscribe(setRoute), []);
  useHotkey("G H", () => { fired.push("page G H"); void client.route.set("/home"); }, { label: "Go home" });
  useHotkey("L", log("L"), { label: "Next" });
  useHotkey("Mod+Enter", log("Mod+Enter"), { label: "Send" });
  useHotkey("?", () => setSheet(true), { label: "Show shortcuts" });
  useHotkey("J", log("J"));
  useHotkey("Space", log("Space"));
  useHotkey("ArrowRight", log("ArrowRight"));
  useHotkey("ArrowDown", log("ArrowDown"));
  useHotkey("Mod+=", log("Mod+="));
  useHotkey("Mod+/", log("Mod+/"));
  useHotkey("Mod+Shift+/", log("Mod+Shift+/"));
  useHotkey("+", log("+"));
  useHotkey("Mod++", log("Mod++"));
  useHotkey("Escape", log("Escape"));
  return <main>
    <p id="route">{route}</p>
    <p id="mod-k">{formatHotkey("Mod+K")}</p>
    <input id="text" aria-label="Text" />
    <input id="checkbox" type="checkbox" aria-label="Checkbox" />
    <input id="radio-a" type="radio" name="choice" aria-label="Radio A" />
    <input id="radio-b" type="radio" name="choice" aria-label="Radio B" />
    <input id="range" type="range" aria-label="Range" />
    {sheet && <HotkeyScope><Shortcuts close={() => setSheet(false)} /></HotkeyScope>}
  </main>;
}
render(<App />, document.getElementById("app")!);
`;

// Two siblings swap K and L in one update; a third binding K later is a real duplicate.
const conflicts = `import { render, useState } from "patchy/preact";
import { useHotkey, useHotkeyList } from "patchy/hotkeys";

const warnings: string[] = [];
console.warn = (message: string) => { warnings.push(message); };
Object.assign(window, { warnings });

function Binding(props: { hotkey: "K" | "L"; label: string }) {
  useHotkey(props.hotkey, () => {}, { label: props.label });
  return null;
}

function App() {
  const [swapped, setSwapped] = useState(false);
  const [third, setThird] = useState(false);
  useHotkey("S", () => setSwapped(true));
  useHotkey("D", () => setThird(true));
  return <main>
    <Binding hotkey={swapped ? "L" : "K"} label="First" />
    <Binding hotkey={swapped ? "K" : "L"} label="Second" />
    {third && <Binding hotkey="K" label="Third" />}
    <ul id="listed">{useHotkeyList().map((item) => <li>{item.label}: {item.hotkey}</li>)}</ul>
  </main>;
}
render(<App />, document.getElementById("app")!);
`;

// O opens a panel whose Escape closes it, and N replaces it with another. `arm` sends one key the
// moment the page's DOM next changes, before anything else can run.
const lifecycle = `import { render, useState } from "patchy/preact";
import { useHotkey } from "patchy/hotkeys";

const fired: string[] = [];
const prevented: boolean[] = [];
const arm = (key: string) => {
  const app = document.getElementById("app")!;
  new MutationObserver((_, observer) => {
    observer.disconnect();
    const down = new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true });
    document.dispatchEvent(down);
    document.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));
    prevented.push(down.defaultPrevented);
  }).observe(app, { childList: true, characterData: true, subtree: true });
};
Object.assign(window, { fired, prevented, arm });

function Panel(props: { name: string; close: () => void }) {
  useHotkey("Escape", () => { fired.push(props.name); props.close(); });
  return <p id="panel">{props.name}</p>;
}

function Record(props: { id: number; approve: () => void }) {
  useHotkey("A", () => { fired.push(\`approve \${props.id}\`); props.approve(); }, { repeat: false });
  return <p id="record">{props.id}</p>;
}

function App() {
  const [panel, setPanel] = useState<string>();
  const [record, setRecord] = useState(1);
  useHotkey("O", () => setPanel("first"));
  useHotkey("N", () => setPanel("second"));
  return <main>
    {panel && <Panel key={panel} name={panel} close={() => setPanel(undefined)} />}
    <Record key={record} id={record} approve={() => setRecord(record + 1)} />
  </main>;
}
render(<App />, document.getElementById("app")!);
`;

// The ready-made sheet over a page with grouped, ungrouped and unlabelled hotkeys of its own.
const sheet = `import { render } from "patchy/preact";
import { HotkeySheet, useHotkey } from "patchy/hotkeys";

const fired: string[] = [];
const log = (name: string) => () => { fired.push(name); };
Object.assign(window, { fired });

function App() {
  useHotkey("G H", log("G H"), { label: "Go home", group: "Navigation" });
  useHotkey("C T", log("C T"), { label: "Create task", group: "Tasks" });
  useHotkey("G T", log("G T"), { label: "Go to timeline", group: "Navigation" });
  useHotkey("L", log("L"), { label: "Next" });
  useHotkey("J", log("J"));
  useHotkey("Escape", log("Escape"));
  return <main>
    <button id="search">Search</button>
    <HotkeySheet title="Tracker shortcuts" />
  </main>;
}
render(<App />, document.getElementById("app")!);
`;

// The same keys on the page, a list, an editor inside the list, and a dialog; a raw widget that
// handles Escape itself; and fields next to the page's Mod+A and Mod+Z. The window records how
// each key arrived, so a key a hotkey left alone shows untouched.
const local = `import { render, useEffect, useRef, useState } from "patchy/preact";
import { HotkeyScope, HotkeySheet, useHotkey } from "patchy/hotkeys";

const fired: string[] = [];
const log = (name: string) => () => { fired.push(name); };
const arrived: string[] = [];
window.addEventListener("keydown", (event) => {
  if (!["Control", "Meta", "Alt", "Shift"].includes(event.key))
    arrived.push(\`\${event.key} \${event.defaultPrevented ? "prevented" : "untouched"}\`);
});
Object.assign(window, { fired, arrived });

function Editor() {
  const field = useRef<HTMLInputElement>(null);
  useHotkey("Enter", log("editor Enter"), { within: field });
  useHotkey("Escape", log("editor Escape"), { within: field });
  useHotkey("A", log("editor A"), { within: field });
  return <input id="editor" ref={field} aria-label="Editor" />;
}

function List() {
  const list = useRef<HTMLUListElement>(null);
  useHotkey("Enter", log("list Enter"), { within: list });
  useHotkey("ArrowDown", log("list ArrowDown"), { within: list });
  return <ul id="list" ref={list} tabIndex={0}><li><Editor /></li></ul>;
}

// Stands in for a third-party widget: a raw listener that handles Escape.
function Widget() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current!;
    const handle = (event: KeyboardEvent) => { if (event.key === "Escape") event.preventDefault(); };
    element.addEventListener("keydown", handle);
    return () => element.removeEventListener("keydown", handle);
  }, []);
  return <div id="widget" ref={box} tabIndex={0}>widget</div>;
}

function Dialog() {
  const notes = useRef<HTMLTextAreaElement>(null);
  useEffect(() => notes.current?.focus(), []);
  useHotkey("Escape", log("dialog Escape"), { label: "Close", group: "Create task" });
  useHotkey("P 5", log("dialog P 5"), { label: "Priority 5", group: "Create task" });
  return <div role="dialog" aria-label="Create task"><textarea id="notes" ref={notes} aria-label="Notes" /></div>;
}

function App() {
  const [open, setOpen] = useState(false);
  useHotkey("Enter", log("page Enter"), { label: "Open" });
  useHotkey("Escape", log("page Escape"));
  useHotkey("Mod+A", log("page Mod+A"), { label: "Select all" });
  useHotkey("Mod+Z", log("page Mod+Z"));
  useHotkey("Mod+K", log("page Mod+K"));
  // Editing keys that ask for text fields too, which they never get.
  useHotkey("Mod+Backspace", log("page Mod+Backspace"), { whileTyping: true });
  useHotkey("Mod+ArrowLeft", log("page Mod+ArrowLeft"), { whileTyping: true });
  useHotkey("Shift+Home", log("page Shift+Home"), { whileTyping: true });
  useHotkey("O", () => setOpen(true));
  return <main>
    <input id="field" aria-label="Field" />
    <List />
    <Widget />
    <p id="body" tabIndex={-1}>body</p>
    <HotkeySheet />
    {open && <HotkeyScope><Dialog /></HotkeyScope>}
  </main>;
}
render(<App />, document.getElementById("app")!);
`;

/** Bundles a page's source against the built patchy package and publishes it. */
const publish = async (instance: Instance, tsx: string) => {
  const bundle = await build({
    stdin: { contents: tsx, loader: "tsx", resolveDir: packageRoot, sourcefile: "hotkeys.tsx" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "patchy/preact",
    define: { "import.meta.env.DEV": "false" }
  });
  const script = bundle.outputFiles[0]!.text.replaceAll("</script", "<\\/script");
  return instance.publish(
    "company",
    `<!doctype html><html><head><title>Hotkeys</title></head><body><div id="app"></div><script>${script}</script></body></html>`
  );
};

const contentFrame = (page: Page): Frame => {
  const frame = page.frames().find((candidate) => candidate.url().includes("/~content/"));
  if (!frame) throw new Error("The hotkeys page did not load.");
  return frame;
};
type Fired = { fired: string[] };
/** The hotkeys fired since the last call, once `expected` have, so a stray one fails the check. */
const firedNext = async (frame: Frame, expected: string[]) => {
  await expect
    .poll(() => frame.evaluate(() => [...(window as unknown as Fired).fired]))
    .toEqual(expected);
  await frame.evaluate(() => (window as unknown as Fired).fired.splice(0));
};

test("patchy/hotkeys fires in the published frame across fields, scopes, layouts and a Mac", async ({
  page,
  context,
  instance
}) => {
  const patch = await publish(instance, source);
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const frame = contentFrame(page);
  const view = page.frameLocator("#patch");
  await expect(view.locator("#route")).toHaveText("/");

  await test.step("a G H sequence changes the route, on the first press with no click", async () => {
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await expect(view.locator("#route")).toHaveText("/home");
    await expect(page).toHaveURL(/\/home$/);
    await firedNext(frame, ["page G H"]);
  });

  await test.step("a single key waits in a text field while Mod+Enter fires there", async () => {
    await view.locator("#text").focus();
    await page.keyboard.press("l");
    await page.keyboard.press("Control+Enter");
    await expect(view.locator("#text")).toHaveValue("l");
    await firedNext(frame, ["Mod+Enter"]);
  });

  await test.step("a single key fires on a checkbox, radio or range, which keep Space and arrows", async () => {
    await view.locator("#checkbox").focus();
    await page.keyboard.press("l");
    await page.keyboard.press("Space");
    await expect(view.locator("#checkbox")).toBeChecked();
    await view.locator("#radio-a").focus();
    await page.keyboard.press("l");
    await page.keyboard.press("ArrowDown");
    await expect(view.locator("#radio-b")).toBeChecked();
    await view.locator("#range").focus();
    await page.keyboard.press("l");
    await page.keyboard.press("ArrowRight");
    await expect(view.locator("#range")).toHaveValue("51");
    await firedNext(frame, ["L", "L", "L"]);
  });

  await test.step("a scope holds back the page's hotkeys, sequences included, lists them and lets go as it closes", async () => {
    await view.locator("#route").click();
    await page.keyboard.press("?");
    await expect(view.locator("#listed li")).toHaveCount(5);
    expect((await view.locator("#listed li").allTextContents()).sort()).toEqual([
      "Close shortcuts: Escape",
      "Go home: G H",
      "Next: L",
      "Send: Mod+Enter",
      "Show shortcuts: ?"
    ]);
    await page.keyboard.press("l");
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await firedNext(frame, ["sheet G H"]);
    // A key dispatched as the scope's list leaves the DOM lands before anything else can run, so
    // it reaches the page only if the scope let go in the same commit that removed it.
    await frame.evaluate(() => {
      new MutationObserver((_, observer) => {
        if (document.getElementById("listed")) return;
        observer.disconnect();
        for (const type of ["keydown", "keyup"])
          document.dispatchEvent(
            new KeyboardEvent(type, { key: "l", code: "KeyL", bubbles: true, cancelable: true })
          );
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.keyboard.press("Escape");
    await expect(view.locator("#listed")).toHaveCount(0);
    await firedNext(frame, ["L"]);
  });

  await test.step("other layouts: ? on AZERTY, J on Russian, AZERTY's Mod+= isn't Mod+/, shifted / is", async () => {
    // Trusted key events carrying the key and code each layout reports.
    const cdp = await context.newCDPSession(page);
    const press = async (key: string, code: string, keyCode: number, modifiers: number) => {
      const event = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
      // A Control chord types no text, so it arrives as a raw key down.
      await cdp.send(
        "Input.dispatchKeyEvent",
        modifiers & 2 ? { ...event, type: "rawKeyDown" } : { ...event, type: "keyDown", text: key }
      );
      await cdp.send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
    };
    // AZERTY types ? with Shift on the key in M's US position.
    await press("?", "KeyM", 188, 8);
    // The list shows the sheet's Escape once the sheet is open.
    await expect(view.locator("#listed li")).toHaveCount(5);
    await page.keyboard.press("Escape");
    await expect(view.locator("#listed")).toHaveCount(0);
    // Russian types о on the key in J's US position.
    await press("о", "KeyJ", 74, 0);
    // AZERTY types = on the key in /'s US position; since TanStack/hotkeys#210 it stays =.
    await press("=", "Slash", 187, 2);
    // Ctrl+Shift on the US / key types ?, a shifted ASCII symbol, so the key's position counts.
    await press("?", "Slash", 191, 2 | 8);
    await firedNext(frame, ["J", "Mod+=", "Mod+Shift+/"]);
    // + from US Shift+=, the numpad and German's own + key, then Ctrl on the numpad's.
    await press("+", "Equal", 187, 8);
    await press("+", "NumpadAdd", 107, 0);
    await press("+", "BracketRight", 187, 0);
    await press("+", "NumpadAdd", 107, 2);
    await firedNext(frame, ["+", "+", "+", "Mod++"]);
  });

  await test.step("no hotkey fires on a key an input method is composing, and the page gets the key untouched", async () => {
    const cdp = await context.newCDPSession(page);
    const press = async (key: string, keyCode: number, modifiers: number) => {
      const event = { key, code: key, windowsVirtualKeyCode: keyCode, modifiers };
      await cdp.send("Input.dispatchKeyEvent", { ...event, type: "rawKeyDown" });
      await cdp.send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
    };
    await view.locator("#text").fill("");
    await view.locator("#text").focus();
    await cdp.send("Input.imeSetComposition", { text: "か", selectionStart: 1, selectionEnd: 1 });
    // Escape and Mod chords fire in a text field, so only the composition holds them back.
    await press("Escape", 27, 0);
    await press("Enter", 13, 2);
    await cdp.send("Input.insertText", { text: "か" });
    await expect(view.locator("#text")).toHaveValue("か");
    // Safari's committing Enter, after the composition ended.
    await press("Enter", 229, 2);
    await page.keyboard.press("Escape");
    await firedNext(frame, ["Escape"]);
    expect(
      await frame.evaluate(() => (window as unknown as { composing: string[] }).composing)
    ).toEqual(["Escape untouched", "Enter untouched", "Enter untouched"]);
  });

  await test.step("formatHotkey shows Ctrl here and ⌘ on a Mac, where Mod is ⌘", async () => {
    await expect(view.locator("#mod-k")).toHaveText("Ctrl+K");
    const mac = await context.newPage();
    await mac.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    });
    await mac.goto(patch.address);
    const macView = mac.frameLocator("#patch");
    await expect(macView.locator("#route")).toHaveText("/");
    await expect(macView.locator("#mod-k")).toHaveText("⌘ K");
    await macView.locator("#text").focus();
    await mac.keyboard.press("Control+Enter");
    await mac.keyboard.press("Meta+Enter");
    await firedNext(contentFrame(mac), ["Mod+Enter"]);
    await mac.close();
  });
});

test("a component's hotkeys are live from the commit that mounts it to the one that removes it", async ({
  page,
  instance
}) => {
  const patch = await publish(instance, lifecycle);
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const frame = contentFrame(page);
  const panel = page.frameLocator("#patch").locator("#panel");
  type Lifecycle = Fired & { prevented: boolean[]; arm: (key: string) => void };
  const arm = (key: string) =>
    frame.evaluate((armed) => (window as unknown as Lifecycle).arm(armed), key);
  const prevented = async (expected: boolean[]) => {
    await expect
      .poll(() => frame.evaluate(() => [...(window as unknown as Lifecycle).prevented]))
      .toEqual(expected);
    await frame.evaluate(() => (window as unknown as Lifecycle).prevented.splice(0));
  };

  await test.step("the first key after a panel mounts reaches it", async () => {
    await arm("Escape");
    await page.keyboard.press("o");
    await prevented([true]);
    await firedNext(frame, ["first"]);
    await expect(panel).toHaveCount(0);
  });

  await test.step("the first key after a panel is removed doesn't reach it", async () => {
    await page.keyboard.press("o");
    await expect(panel).toHaveText("first");
    await arm("Escape");
    await page.keyboard.press("Escape");
    await prevented([false]);
    await firedNext(frame, ["first"]);
  });

  await test.step("the first key after a panel is replaced reaches only the new one", async () => {
    await page.keyboard.press("o");
    await expect(panel).toHaveText("first");
    await arm("Escape");
    await page.keyboard.press("n");
    await prevented([true]);
    await firedNext(frame, ["second"]);
    await expect(panel).toHaveCount(0);
  });

  await test.step("repeat: false fires once per press, though the hotkey remounts while it is held", async () => {
    const record = page.frameLocator("#patch").locator("#record");
    await page.keyboard.down("a");
    await expect(record).toHaveText("2");
    // Each further down is a key repeat, as holding A sends.
    await page.keyboard.down("a");
    await page.keyboard.down("a");
    await page.keyboard.up("a");
    await page.keyboard.press("a");
    await expect(record).toHaveText("3");
    await firedNext(frame, ["approve 1", "approve 2"]);
  });
});

test("a conflict warning waits for every hook's update, so siblings swapping keys don't warn", async ({
  page,
  instance
}) => {
  const patch = await publish(instance, conflicts);
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const view = page.frameLocator("#patch");
  // The list follows TanStack's registrations, so it settles only after every hook's update.
  const listed = (expected: string[]) =>
    expect
      .poll(async () => (await view.locator("#listed li").allTextContents()).sort())
      .toEqual(expected);
  const warnings = () =>
    contentFrame(page).evaluate(() => [...(window as unknown as { warnings: string[] }).warnings]);
  await listed(["First: K", "Second: L"]);

  await page.keyboard.press("s");
  await listed(["First: L", "Second: K"]);
  expect(await warnings()).toEqual([]);

  await page.keyboard.press("d");
  await listed(["First: L", "Second: K", "Third: K"]);
  expect(await warnings()).toEqual([
    'patchy/hotkeys: "Second" and "Third" both use K in the same scope, so both fire on each press.'
  ]);
});

test("the sheet opens by ? or its button, lists by group, holds the page's hotkeys and closes like a dialog", async ({
  page,
  instance
}) => {
  const patch = await publish(instance, sheet);
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const frame = contentFrame(page);
  const view = page.frameLocator("#patch");
  const opener = view.getByRole("button", { name: "Tracker shortcuts" });
  const dialog = view.getByRole("dialog", { name: "Tracker shortcuts" });
  const close = dialog.getByRole("button", { name: "Close" });
  await expect(opener).toBeVisible();

  await test.step("? opens it, focus moves in, and it lists each group's hotkeys as keys", async () => {
    await view.locator("#search").focus();
    await page.keyboard.press("?");
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    const listed = await frame.evaluate(() =>
      [...document.querySelectorAll(".hotkey-group")].map((group) => [
        group.querySelector("h3")?.textContent,
        [...group.querySelectorAll(".hotkey-row")].map(
          (row) =>
            `${row.querySelector(".hotkey-label")?.textContent}: ${[...row.querySelectorAll("kbd")].map((key) => key.textContent).join(" ")}`
        )
      ])
    );
    expect(listed).toEqual([
      ["Navigation", ["Go home: G H", "Go to timeline: G T"]],
      ["Tasks", ["Create task: C T"]],
      ["General", ["Show shortcuts: ?", "Next: L"]]
    ]);
  });

  await test.step("while it is open unlisted hotkeys wait, and Tab stays on its close button", async () => {
    await page.keyboard.press("j");
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
  });

  // Each way out releases the page's hotkeys at once, so the first key after it fires; any key
  // pressed while it was open would show here too.
  await test.step("Escape closes it past the page's own Escape, and focus goes back", async () => {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(view.locator("#search")).toBeFocused();
    await page.keyboard.press("j");
    await firedNext(frame, ["J"]);
  });

  await test.step("a listed hotkey pressed in it closes it and runs, once, where focus was", async () => {
    await page.keyboard.press("?");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await expect(dialog).toBeHidden();
    await expect(view.locator("#search")).toBeFocused();
    await firedNext(frame, ["G H"]);
  });

  await test.step("its button opens it, and its close button or a click outside closes it", async () => {
    await opener.click();
    await expect(close).toBeFocused();
    await close.click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await page.keyboard.press("j");
    await firedNext(frame, ["J"]);
    await opener.click();
    await expect(dialog).toBeVisible();
    // The dialog is the scrim around the card; its corner is outside the card.
    await dialog.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await page.keyboard.press("j");
    await firedNext(frame, ["J"]);
  });

  // A key dispatched as the dialog's `open` appears lands before anything else can run, so it
  // reaches the page unless the sheet's scope is already holding the page's hotkeys back.
  await test.step("a key pressed the moment it opens waits too", async () => {
    await frame.evaluate(() => {
      new MutationObserver((_, observer) => {
        if (!document.querySelector("dialog[open]")) return;
        observer.disconnect();
        for (const type of ["keydown", "keyup"])
          document.activeElement?.dispatchEvent(
            new KeyboardEvent(type, { key: "j", code: "KeyJ", bubbles: true, cancelable: true })
          );
      }).observe(document.body, { attributes: true, attributeFilter: ["open"], subtree: true });
    });
    await page.keyboard.press("?");
    await expect(dialog).toBeVisible();
    await firedNext(frame, []);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test("local hotkeys: the narrowest place wins, editing keys stay with the field, handled keys stand down, the sheet runs a dialog's keys", async ({
  page,
  context,
  instance
}) => {
  const patch = await publish(instance, local);
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const frame = contentFrame(page);
  const view = page.frameLocator("#patch");
  await expect(view.locator("#list")).toBeVisible();
  type Arrived = { arrived: string[] };
  const arrivedNext = async (expected: string[]) => {
    expect(await frame.evaluate(() => (window as unknown as Arrived).arrived.splice(0))).toEqual(
      expected
    );
  };

  await test.step("an editor inside a list inside the page: each place's Enter and Escape fire only there", async () => {
    await view.locator("#editor").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    // A key that types stays the field's, even for a hotkey within the field itself.
    await page.keyboard.press("a");
    await expect(view.locator("#editor")).toHaveValue("a");
    await firedNext(frame, ["editor Enter", "editor Escape"]);
    await view.locator("#list").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await firedNext(frame, ["list Enter", "list ArrowDown", "page Escape"]);
    await view.locator("#body").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await firedNext(frame, ["page Enter"]);
  });

  await test.step("in a text field, Mod+A, Mod+Z and the other editing keys stay with it; Mod+K fires", async () => {
    await view.locator("#field").fill("abc");
    await view.locator("#field").focus();
    await frame.evaluate(() => (window as unknown as Arrived).arrived.splice(0));
    for (const key of [
      "Control+a",
      "Control+z",
      "Control+Backspace",
      "Control+ArrowLeft",
      "Shift+Home"
    ])
      await page.keyboard.press(key);
    await page.keyboard.press("Control+k");
    await firedNext(frame, ["page Mod+K"]);
    await arrivedNext([
      "a untouched",
      "z untouched",
      "Backspace untouched",
      "ArrowLeft untouched",
      "Home untouched"
    ]);
    await view.locator("#body").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+Backspace");
    await firedNext(frame, ["page Mod+A", "page Mod+Z", "page Mod+Backspace"]);
  });

  await test.step("on a Mac, ⌘A stays with the field and ⌘K fires", async () => {
    const mac = await context.newPage();
    await mac.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    });
    await mac.goto(patch.address);
    const macView = mac.frameLocator("#patch");
    await macView.locator("#field").focus();
    await mac.keyboard.press("Meta+a");
    await mac.keyboard.press("Meta+k");
    await firedNext(contentFrame(mac), ["page Mod+K"]);
    await macView.locator("#body").focus();
    await mac.keyboard.press("Meta+a");
    await firedNext(contentFrame(mac), ["page Mod+A"]);
    await mac.close();
  });

  await test.step("a key a widget's own handler already handled doesn't fire a hotkey", async () => {
    await view.locator("#widget").focus();
    await page.keyboard.press("Escape");
    await view.locator("#body").focus();
    await page.keyboard.press("Escape");
    await firedNext(frame, ["page Escape"]);
  });

  await test.step("inside a dialog, Mod+/ from a field lists the dialog's keys, and P 5 runs there", async () => {
    await view.locator("#body").focus();
    await page.keyboard.press("o");
    await expect(view.locator("#notes")).toBeFocused();
    await page.keyboard.type("x");
    await page.keyboard.press("Control+/");
    const sheet = view.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();
    expect(await sheet.locator(".hotkey-label").allTextContents()).toEqual([
      "Close",
      "Priority 5",
      "Show shortcuts"
    ]);
    await page.keyboard.press("p");
    await page.keyboard.press("5");
    await expect(sheet).toBeHidden();
    await expect(view.locator("#notes")).toBeFocused();
    await expect(view.locator("#notes")).toHaveValue("x");
    await firedNext(frame, ["dialog P 5"]);
  });
});
