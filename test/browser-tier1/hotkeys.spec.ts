import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import type { Instance } from "./instance.js";

// packages/patchy/src/hotkeys.test.ts and hotkeyRules.test.ts own the types and the warnings'
// words. These pages prove what only a browser shows: real key events reaching patchy/hotkeys in
// the published frame, in fields, controls, a scope, an input method's composition, other layouts
// and on a Mac, a held key across a remount, a re-render's new run, the conflict warning waiting
// until every hook's update has landed, and the sheet behaving as a dialog.
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

// O opens a panel whose Escape closes it, and N replaces it with another. I counts, with a `run`
// that is new each render. `arm` sends one key the moment the page's DOM next changes, before
// anything else can run.
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

function Counter() {
  const [count, setCount] = useState(0);
  useHotkey("I", () => { fired.push(\`count \${count}\`); setCount(count + 1); });
  return <p id="count">{count}</p>;
}

function App() {
  const [panel, setPanel] = useState<string>();
  const [record, setRecord] = useState(1);
  useHotkey("O", () => setPanel("first"));
  useHotkey("N", () => setPanel("second"));
  return <main>
    {panel && <Panel key={panel} name={panel} close={() => setPanel(undefined)} />}
    <Record key={record} id={record} approve={() => setRecord(record + 1)} />
    <Counter />
  </main>;
}
render(<App />, document.getElementById("app")!);
`;

// The ready-made sheet over a page with grouped, ungrouped and unlabelled hotkeys of its own,
// its button in a sidebar the page can hide and its own row in one of the page's groups. A menu
// item of the page's opens it too.
const sheet = `import { render } from "patchy/preact";
import { HotkeySheet, openHotkeySheet, useHotkey } from "patchy/hotkeys";

const fired: string[] = [];
const log = (name: string) => () => { fired.push(name); };
Object.assign(window, { fired });

function App() {
  useHotkey("G H", log("G H"), { label: "Go home", group: "Navigation" });
  useHotkey("C T", log("C T"), { label: "Create task", group: "Tasks" });
  useHotkey("G T", log("G T"), { label: "Go to timeline", group: "Navigation" });
  useHotkey("L", log("L"), { label: "Next" });
  // A step of the sheet's own Tab: listed, run from its button alone while the sheet is open.
  useHotkey("Tab A", log("Tab A"), { label: "Tab then A" });
  useHotkey("J", log("J"));
  useHotkey("Escape", log("Escape"));
  return <main>
    <button id="search">Search</button>
    <button id="menu-shortcuts" onClick={() => openHotkeySheet()}>Shortcuts</button>
    <aside id="sidebar"><HotkeySheet title="Tracker shortcuts" group="Navigation" /></aside>
  </main>;
}
render(<App />, document.getElementById("app")!);
`;

// The sheet on a right-to-left page whose own element rules would restyle it, some long, in a
// media query or in a preflight layer like Tailwind's, with a one-class rule aimed at its keycaps.
// All of it is in <head> before the sheet mounts, as in a built page; `css` adds more after, or
// prepends it.
// `addLook` adds a company look, as a patch's bundle carries one.
const styled = `import { render } from "patchy/preact";
import { HotkeySheet, useHotkey } from "patchy/hotkeys";

const css = (text: string, prepend = false) => {
  const style = document.createElement("style");
  style.textContent = text;
  if (prepend) document.head.prepend(style);
  else document.head.append(style);
};
css(\`
  @layer base {
    kbd { opacity: 0; font-family: monospace; }
    button { text-transform: uppercase; border: 0 solid; }
  }
  body { font-family: Georgia, serif; color: rgb(40, 50, 60); direction: rtl; }
  body * { scroll-margin-bottom: 9px; }
  kbd { display: none; font-size: 4px; direction: ltr; unicode-bidi: bidi-override; }
  @media (min-width: 0px) { html body kbd { display: none; font-size: 4px; } }
  button, html body main button, html body dialog button { padding: 30px; background: rgb(255, 0, 0); }
  dialog, body dialog { border: 9px solid rgb(255, 0, 0); direction: ltr; unicode-bidi: bidi-override; }
  .hotkey-key { color: rgb(1, 2, 3); }
\`);
const addLook = () => css(\`@layer look {
  :root { --look-border: rgb(0, 0, 0); --look-space: 8px; }
  button { min-height: 48px; background: rgb(0, 0, 200); }
  button:hover { background: rgb(0, 0, 100); }
}\`);
Object.assign(window, { addLook, css });

function App() {
  useHotkey("G H", () => {}, { label: "Go home" });
  return <main><HotkeySheet /></main>;
}
render(<App />, document.getElementById("app")!);
`;

// The same keys on the page, a list, an editor inside the list, a chart and a dialog; a raw widget
// that handles Escape and T itself; fields beside page hotkeys that ask for their keys. The window
// records each key that reaches it, so one a hotkey left alone shows untouched.
const local = `import { render, useEffect, useLayoutEffect, useRef, useState } from "patchy/preact";
import { HotkeyScope, HotkeySheet, openHotkeySheet, useHotkey } from "patchy/hotkeys";

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
  useHotkey("ArrowDown", log("editor ArrowDown"), { within: field });
  // Keys that type or edit, which a hotkey within the field never takes.
  useHotkey("A", log("editor A"), { within: field, whileTyping: true });
  useHotkey("Shift+Enter", log("editor Shift+Enter"), { within: field });
  useHotkey("Home", log("editor Home"), { within: field });
  // Waits while typing, though it is within the field it would type in.
  useHotkey("Mod+K", log("editor Mod+K"), { within: field, whileTyping: false });
  return <input id="editor" ref={field} aria-label="Editor" />;
}

function List() {
  const list = useRef<HTMLUListElement>(null);
  useHotkey("Enter", log("list Enter"), { within: list, label: "Open task", group: "Tasks" });
  useHotkey("ArrowDown", log("list ArrowDown"), { within: list, label: "Next task", group: "Tasks" });
  useHotkey("H", log("list H"), { within: list });
  return <ul id="list" ref={list} tabIndex={0}><li><Editor /></li></ul>;
}

function Chart() {
  const chart = useRef<SVGSVGElement>(null);
  useHotkey("G H", log("chart G H"), { within: chart });
  useHotkey("ArrowRight", log("chart ArrowRight"), { within: chart });
  return <svg id="chart" ref={chart} tabindex={0} width="40" height="40" aria-label="Chart"><rect width="40" height="40" /></svg>;
}

// A panel whose own sequence starts with the last step of the page's G H.
function Panel() {
  const panel = useRef<HTMLDivElement>(null);
  useHotkey("H X", log("panel H X"), { within: panel });
  return <div id="panel" ref={panel} tabIndex={0}>panel</div>;
}

function WidgetPart() {
  const part = useRef<HTMLSpanElement>(null);
  useHotkey("L", log("widget part L"), { within: part });
  return <span id="widget-part" ref={part} tabIndex={0}>part</span>;
}

// Stands in for a third-party widget: a raw listener that handles Escape, T and H, around a part
// with a hotkey of its own.
function Widget() {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current!;
    const handle = (event: KeyboardEvent) => {
      if (["Escape", "t", "h"].includes(event.key)) event.preventDefault();
    };
    element.addEventListener("keydown", handle);
    return () => element.removeEventListener("keydown", handle);
  }, []);
  return <div id="widget" ref={box} tabIndex={0}>widget <WidgetPart /></div>;
}

function DatePicker(props: { close: () => void }) {
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => field.current?.focus(), []);
  useHotkey("Escape", props.close, { label: "Close date" });
  return <div role="dialog" aria-label="Pick a date"><input id="date" ref={field} aria-label="Date" /></div>;
}

function CreateTask(props: { close: () => void }) {
  const notes = useRef<HTMLTextAreaElement>(null);
  const [priority, setPriority] = useState(0);
  const [assigned, setAssigned] = useState(false);
  const [notesShown, setNotesShown] = useState(true);
  const [picking, setPicking] = useState(false);
  useLayoutEffect(() => notes.current?.focus(), []);
  const group = "Create task";
  useHotkey("Escape", () => { fired.push("dialog Escape"); props.close(); }, { label: "Close", group });
  useHotkey("P 5", () => { fired.push("dialog P 5"); setPriority(5); }, { label: "Priority 5", group });
  useHotkey("A", () => { fired.push("dialog A"); setAssigned(true); }, { label: "Assign to me", group });
  useHotkey("D", () => setNotesShown(false), { label: "Discard notes", group });
  useHotkey("T", () => setPicking(true), { label: "Pick a date", group });
  useHotkey("G Escape", () => { fired.push("dialog G Escape"); props.close(); }, { label: "Leave", group });
  return <div id="create" role="dialog" aria-label="Create task">
    {notesShown && <textarea id="notes" ref={notes} aria-label="Notes" />}
    <p id="priority">{priority}</p>
    <p id="assigned">{assigned ? "me" : "nobody"}</p>
    <button id="dialog-shortcuts" type="button" onClick={() => openHotkeySheet()}>Shortcuts</button>
    {picking && <HotkeyScope><DatePicker close={() => setPicking(false)} /></HotkeyScope>}
  </div>;
}

// A native modal dialog: everything outside it is inert while it is open.
function Rename(props: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    field.current?.focus();
    return () => element.close();
  }, []);
  useHotkey("S", log("native S"), { label: "Star", group: "Rename" });
  return <dialog id="native" ref={dialog} aria-label="Rename" onCancel={props.close}>
    <input id="native-field" ref={field} aria-label="Name" />
  </dialog>;
}

function App() {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useHotkey("R", () => setRenaming(true));
  useHotkey("Enter", log("page Enter"), { label: "Open", whileTyping: true });
  useHotkey("Escape", log("page Escape"));
  useHotkey("G H", log("page G H"), { label: "Go home" });
  useHotkey("G T", log("page G T"));
  useHotkey("G", log("page G"));
  // Keys that ask for text fields too, which keep them.
  useHotkey("Mod+A", log("page Mod+A"), { label: "Select all", whileTyping: true });
  useHotkey("Mod+Z", log("page Mod+Z"), { whileTyping: true });
  useHotkey("Mod+Backspace", log("page Mod+Backspace"), { whileTyping: true });
  useHotkey("Mod+ArrowLeft", log("page Mod+ArrowLeft"), { whileTyping: true });
  useHotkey("Shift+Home", log("page Shift+Home"), { whileTyping: true });
  useHotkey("ArrowRight", log("page ArrowRight"), { whileTyping: true });
  useHotkey("L", log("page L"), { whileTyping: true });
  useHotkey("Mod+K", log("page Mod+K"));
  useHotkey("C", () => setCreating(true));
  return <main>
    <input id="field" aria-label="Field" />
    <textarea id="text" aria-label="Text" />
    <input id="readonly" aria-label="Read-only" readOnly value="abc" />
    <div id="rich" contentEditable aria-label="Rich">hello world</div>
    <List />
    <Chart />
    <Panel />
    <Widget />
    <p id="body" tabIndex={-1}>body</p>
    <HotkeySheet />
    {creating && <HotkeyScope><CreateTask close={() => setCreating(false)} /></HotkeyScope>}
    {renaming && <HotkeyScope><Rename close={() => setRenaming(false)} /></HotkeyScope>}
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

  await test.step("a hotkey runs its last render's run, though nothing else about it changed", async () => {
    const count = page.frameLocator("#patch").locator("#count");
    for (const expected of ["1", "2", "3"]) {
      await page.keyboard.press("i");
      await expect(count).toHaveText(expected);
    }
    await firedNext(frame, ["count 0", "count 1", "count 2"]);
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

test("the sheet opens by ? or its button, lists by group with its own rows last, runs what it lists and closes like a dialog", async ({
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
      [
        "Navigation",
        ["Go home: G H", "Go to timeline: G T", "Show shortcuts: ?", "Show shortcuts: Ctrl /"]
      ],
      ["Tasks", ["Create task: C T"]],
      ["General", ["Next: L", "Tab then A: Tab A"]]
    ]);
  });

  await test.step("while it is open unlisted hotkeys wait, and Tab goes round its buttons, past a command that starts with Tab", async () => {
    await page.keyboard.press("j");
    const commands = dialog.locator(".hotkey-command");
    await expect(commands).toHaveText([
      "Go homeGthenH",
      "Go to timelineGthenT",
      "Create taskCthenT",
      "NextL",
      "Tab then ATabthenA"
    ]);
    for (const command of await commands.all()) {
      await page.keyboard.press("Tab");
      await expect(command).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(commands.last()).toBeFocused();
    await page.keyboard.press("Tab");
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

  await test.step("with its button in a hidden sidebar, ? opens it in view, and focus goes back", async () => {
    await frame.evaluate(() => {
      document.getElementById("sidebar")!.hidden = true;
    });
    await expect(opener).toBeHidden();
    await view.locator("#search").focus();
    await page.keyboard.press("?");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".hotkey-row").first()).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(view.locator("#search")).toBeFocused();
  });

  await test.step("a menu item of the page's opens it with openHotkeySheet, and focus goes back to the item", async () => {
    const item = view.locator("#menu-shortcuts");
    await item.click();
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(item).toBeFocused();
  });
});

test("a page's element rules don't reach the sheet, which takes the page's font without a look and its button follows one", async ({
  page,
  instance
}) => {
  const patch = await publish(instance, styled);
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const frame = contentFrame(page);
  const view = page.frameLocator("#patch");
  const opener = view.getByRole("button", { name: "Keyboard shortcuts" });
  const dialog = view.getByRole("dialog", { name: "Keyboard shortcuts" });
  const style = (locator: ReturnType<typeof view.locator>, properties: string[]) =>
    locator.evaluate(
      (element, names) =>
        Object.fromEntries(
          names.map((name) => [name, getComputedStyle(element).getPropertyValue(name)])
        ),
      properties
    );

  type Css = { css: (text: string, prepend?: boolean) => void };
  const addCss = (text: string, prepend = false) =>
    frame.evaluate(([added, first]) => (window as unknown as Css).css(added, first), [
      text,
      prepend
    ] as const);

  await test.step("the page's element rules leave it be, layered or not, however long; its one-class rules restyle it", async () => {
    // Prepended ahead of the sheet's reset after it mounted, which the sheet undoes as it opens.
    await addCss(".hotkey-key { padding-left: 23px; }", true);
    await page.keyboard.press("?");
    // Added after the sheet mounted: longer than any weight in element names, or in a layer
    // declared before it.
    await addCss(`
      html body dialog div div section ul li span kbd { display: none; }
      html body dialog div div section ul li span kbd:not(b b b b b b b b b b) { display: none; }
      @layer base { kbd { visibility: hidden; } }
    `);
    const key = dialog.locator(".hotkey-row kbd").first();
    await expect(key).toBeVisible();
    expect(
      await style(key, [
        "font-size",
        "color",
        "opacity",
        "font-family",
        "direction",
        "unicode-bidi",
        "padding-left"
      ])
    ).toEqual({
      "font-size": "12.16px",
      color: "rgb(1, 2, 3)",
      opacity: "1",
      "font-family": "Georgia, serif",
      direction: "rtl",
      "unicode-bidi": "normal",
      "padding-left": "23px"
    });
    expect(
      await style(dialog.locator(".hotkey-sheet-close"), [
        "padding-left",
        "background-color",
        "text-transform"
      ])
    ).toEqual({
      "padding-left": "0px",
      "background-color": "rgba(0, 0, 0, 0)",
      "text-transform": "none"
    });
    // The page is right to left; its rules that turn the dialog or a keycap left to right don't hold.
    expect(await style(dialog, ["border-top-width", "direction", "unicode-bidi"])).toEqual({
      "border-top-width": "0px",
      direction: "rtl",
      "unicode-bidi": "normal"
    });
    // `body *` reaches the page but no part of the sheet or its button.
    expect(await style(view.locator("main"), ["scroll-margin-bottom"])).toEqual({
      "scroll-margin-bottom": "9px"
    });
    const reached = await frame.evaluate(() =>
      [...document.querySelectorAll(".hotkey-opener, .hotkey-sheet-dialog, .hotkey-sheet-dialog *")]
        .filter((element) => getComputedStyle(element).scrollMarginBottom !== "0px")
        .map((element) => element.outerHTML.slice(0, 60))
    );
    expect(reached).toEqual([]);
  });

  await test.step("a page's rule on each of its hotkey-* classes outweighs the reset, even added after it", async () => {
    const names = await frame.evaluate(() => [
      ...new Set(
        [...document.querySelectorAll("[class*='hotkey-']")].flatMap((element) =>
          [...element.classList].filter((name) => name.startsWith("hotkey-"))
        )
      )
    ]);
    expect(names).toEqual(expect.arrayContaining(["hotkey-opener", "hotkey-sheet", "hotkey-key"]));
    await addCss(names.map((name) => `.${name} { scroll-margin-top: 7px; }`).join("\n"));
    const missed = await frame.evaluate(() =>
      [...document.querySelectorAll("[class*='hotkey-']")]
        .filter((element) => getComputedStyle(element).scrollMarginTop !== "7px")
        .map((element) => element.className)
    );
    expect(missed).toEqual([]);
  });

  await test.step("without a look it draws in the page's font and text colour, with a hairline and no shadow", async () => {
    expect(
      await style(dialog.locator(".hotkey-sheet"), [
        "font-family",
        "color",
        "border-top-width",
        "box-shadow"
      ])
    ).toEqual({
      "font-family": "Georgia, serif",
      color: "rgb(40, 50, 60)",
      "border-top-width": "1px",
      "box-shadow": "none"
    });
    await page.keyboard.press("Escape");
    expect(
      await style(opener, ["font-family", "color", "border-top-width", "padding-left"])
    ).toEqual({
      "font-family": "Georgia, serif",
      color: "rgb(40, 50, 60)",
      "border-top-width": "1px",
      "padding-left": "0px"
    });
    const resting = (await style(opener, ["background-color"]))["background-color"];
    await opener.hover();
    await expect
      .poll(async () => (await style(opener, ["background-color"]))["background-color"])
      .not.toBe(resting);
  });

  await test.step("with a look, its button is one of the look's, square, and the sheet takes the look's frame", async () => {
    await frame.evaluate(() => (window as unknown as { addLook: () => void }).addLook());
    await page.mouse.move(0, 0);
    expect(await style(opener, ["background-color"])).toEqual({
      "background-color": "rgb(0, 0, 200)"
    });
    const box = await opener.boundingBox();
    expect([box?.width, box?.height]).toEqual([48, 48]);
    await opener.hover();
    await expect
      .poll(async () => (await style(opener, ["background-color"]))["background-color"])
      .toBe("rgb(0, 0, 100)");
    await opener.click();
    expect(
      await style(dialog.locator(".hotkey-sheet"), ["border-top-width", "box-shadow"])
    ).toEqual({
      "border-top-width": "2px",
      "box-shadow": "rgb(0, 0, 0) 4px 4px 0px 0px"
    });
  });
});

test("local hotkeys: the narrowest place wins, fields keep their keys, handled keys stand down, and the sheet runs a dialog's commands", async ({
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
  const sheet = view.getByRole("dialog", { name: "Keyboard shortcuts" });
  const announced = view.locator(".hotkey-announce");
  // The text of each status region Chromium exposes in the patch's frame, leaving out the ones a
  // modal dialog makes inert.
  const statuses = async () => {
    type Node = {
      nodeId: string;
      ignored: boolean;
      role?: { value: string };
      name?: { value: string };
      childIds?: string[];
    };
    type Tree = { frame: { id: string; url: string }; childFrames?: Tree[] };
    const session = await context.newCDPSession(page);
    const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: Tree };
    const content = (tree: Tree): Tree | undefined =>
      tree.frame.url.includes("/~content/")
        ? tree
        : (tree.childFrames ?? []).map(content).find((found) => found !== undefined);
    const { nodes } = (await session.send("Accessibility.getFullAXTree", {
      frameId: content(frameTree)!.frame.id
    })) as { nodes: Node[] };
    await session.detach();
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const text = (node: Node): string =>
      node.role?.value === "StaticText"
        ? (node.name?.value ?? "")
        : (node.childIds ?? [])
            .map((id) => byId.get(id))
            .map((child) => (child && !child.ignored ? text(child) : ""))
            .join("");
    return nodes.filter((node) => !node.ignored && node.role?.value === "status").map(text);
  };
  // Trusted key events carrying the key and code each layout reports.
  const cdp = await context.newCDPSession(page);
  const press = async (key: string, code: string, keyCode: number, modifiers: number) => {
    const event = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
    await cdp.send("Input.dispatchKeyEvent", { ...event, type: "rawKeyDown" });
    await cdp.send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
  };

  await test.step("an editor inside a list inside the page: each place's Enter and Escape fire only there", async () => {
    await view.locator("#editor").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowDown");
    // Keys that type or edit stay the field's, even for hotkeys within the field itself.
    await page.keyboard.press("a");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Home");
    await expect(view.locator("#editor")).toHaveValue("a");
    // whileTyping: false holds the editor's own Mod+K back, so the page's takes it.
    await page.keyboard.press("Control+k");
    await firedNext(frame, ["editor Enter", "editor Escape", "editor ArrowDown", "page Mod+K"]);
    await view.locator("#list").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await view.locator("#body").focus();
    await page.keyboard.press("Enter");
    await firedNext(frame, ["list Enter", "list ArrowDown", "page Escape", "page Enter"]);
  });

  await test.step("an element's key or sequence step beats the page's sequences, and a key it doesn't take goes on", async () => {
    // The page's G fires on every G, wherever G H is under way.
    await view.locator("#list").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await firedNext(frame, ["page G", "list H"]);
    await view.locator("#chart").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await firedNext(frame, ["page G", "chart G H"]);
    // The panel's H X takes H, so the page's G H under way doesn't complete on it.
    await view.locator("#panel").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await page.keyboard.press("x");
    await firedNext(frame, ["page G", "panel H X"]);
    await view.locator("#chart").focus();
    // The chart's G H takes G, so the page's G T can't start there.
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await page.keyboard.press("ArrowRight");
    await firedNext(frame, ["page G", "chart ArrowRight"]);
    await view.locator("#body").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await firedNext(frame, ["page G", "page G H"]);
  });

  await test.step("text fields keep typing and editing keys whatever a hotkey asks, Mod+K fires, and a read-only field keeps its caret keys", async () => {
    await view.locator("#field").fill("abc");
    await view.locator("#field").focus();
    await frame.evaluate(() => (window as unknown as Arrived).arrived.splice(0));
    for (const key of [
      "Control+a",
      "Control+z",
      "Control+Backspace",
      "Control+ArrowLeft",
      "Shift+Home",
      "l",
      "Enter"
    ])
      await page.keyboard.press(key);
    await page.keyboard.press("Control+k");
    await firedNext(frame, ["page Mod+K"]);
    await arrivedNext([
      "a untouched",
      "z untouched",
      "Backspace untouched",
      "ArrowLeft untouched",
      "Home untouched",
      "l untouched",
      "Enter untouched"
    ]);
    // A field of lines keeps its plain Enter and arrows.
    await view.locator("#text").focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await expect(view.locator("#text")).toHaveValue("\n");
    await arrivedNext(["Enter untouched", "ArrowUp untouched"]);
    await view.locator("#readonly").focus();
    await page.keyboard.press("l");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+k");
    await firedNext(frame, ["page L", "page Mod+K"]);
    await arrivedNext(["ArrowRight untouched", "a untouched"]);
    await view.locator("#body").focus();
    for (const key of ["Control+a", "Control+z", "Control+Backspace", "ArrowRight"])
      await page.keyboard.press(key);
    await firedNext(frame, ["page Mod+A", "page Mod+Z", "page Mod+Backspace", "page ArrowRight"]);
    await frame.evaluate(() => (window as unknown as Arrived).arrived.splice(0));
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

  await test.step("a key a widget already handled neither fires a hotkey nor steps a sequence", async () => {
    await view.locator("#widget").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await view.locator("#body").focus();
    await page.keyboard.press("Escape");
    await firedNext(frame, ["page G", "page Escape"]);
    // A part with a hotkey of its own inside the widget, which handles H after the part's
    // listener has seen it: the page's G H still doesn't complete.
    await view.locator("#widget-part").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("h");
    await view.locator("#body").focus();
    await page.keyboard.press("Escape");
    await firedNext(frame, ["page G", "page Escape"]);
  });

  await test.step("Mod+/ opens the sheet from a field on German and French layouts; AZERTY's = isn't Mod+/", async () => {
    await view.locator("#field").focus();
    // German types / with Shift+7, French with Shift on the key in the US . position.
    for (const [code, keyCode] of [
      ["Digit7", 55],
      ["Period", 190]
    ] as const) {
      await press("/", code, keyCode, 2 | 8);
      await expect(sheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(view.locator("#field")).toBeFocused();
    }
    await press("=", "Slash", 187, 2);
    await expect(sheet).toBeHidden();
    await firedNext(frame, []);
  });

  await test.step("from rich text, the sheet puts focus and the selection back as it closes", async () => {
    const rich = view.locator("#rich");
    await rich.focus();
    await page.keyboard.press("End");
    for (let step = 0; step < 5; step++) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Control+/");
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(rich).toBeFocused();
    expect(
      await frame.evaluate(() => {
        const selection = document.getSelection()!;
        return [String(selection), selection.anchorOffset, selection.focusOffset];
      })
    ).toEqual(["world", 11, 6]);
    await firedNext(frame, []);
  });

  await test.step("from a dialog's field, Mod+/ lists the dialog's commands; P 5 runs by key, and the caret and selection come back", async () => {
    await view.locator("#body").focus();
    await page.keyboard.press("c");
    const notes = view.locator("#notes");
    await expect(notes).toBeFocused();
    await page.keyboard.type("hello world");
    for (let step = 0; step < 5; step++) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Control+/");
    await expect(sheet).toBeVisible();
    const listed = await frame.evaluate(() =>
      [...document.querySelectorAll(".hotkey-group")].map((group) => [
        group.querySelector("h3")?.textContent,
        [...group.querySelectorAll(".hotkey-row")].map(
          (row) =>
            `${row.querySelector(".hotkey-command") ? "button" : "row"} ${row.querySelector(".hotkey-label")?.textContent}`
        )
      ])
    );
    expect(listed).toEqual([
      [
        "Create task",
        [
          "button Close",
          "button Priority 5",
          "button Assign to me",
          "button Discard notes",
          "button Pick a date",
          "button Leave"
        ]
      ],
      ["General", ["row Show shortcuts", "row Show shortcuts"]]
    ]);
    await page.keyboard.press("p");
    await page.keyboard.press("5");
    await expect(sheet).toBeHidden();
    await expect(notes).toBeFocused();
    expect(
      await notes.evaluate((field: HTMLTextAreaElement) => [
        field.value,
        field.selectionStart,
        field.selectionEnd,
        field.selectionDirection
      ])
    ).toEqual(["hello world", 6, 11, "backward"]);
    await expect(view.locator("#priority")).toHaveText("5");
    await expect(announced).toHaveText("Priority 5");
    await expect(announced).toHaveAttribute("aria-live", "polite");
    await firedNext(frame, ["dialog P 5"]);
  });

  await test.step("Tab goes through the sheet's commands, which run by Space or a click", async () => {
    const notes = view.locator("#notes");
    await page.keyboard.press("Control+/");
    await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    const commands = sheet.locator(".hotkey-command");
    for (const index of [0, 1]) {
      await page.keyboard.press("Tab");
      await expect(commands.nth(index)).toBeFocused();
    }
    await page.keyboard.press("Space");
    await expect(sheet).toBeHidden();
    await expect(notes).toBeFocused();
    expect(
      await notes.evaluate((field: HTMLTextAreaElement) => [
        field.selectionStart,
        field.selectionEnd
      ])
    ).toEqual([6, 11]);
    await firedNext(frame, ["dialog P 5"]);
    await page.keyboard.press("Control+/");
    await sheet.locator(".hotkey-command", { hasText: "Assign to me" }).click();
    await expect(sheet).toBeHidden();
    await expect(notes).toBeFocused();
    await expect(view.locator("#assigned")).toHaveText("me");
    await expect(announced).toHaveText("Assign to me");
    await firedNext(frame, ["dialog A"]);
  });

  await test.step("Escape closes only the sheet, even as a command's step, and a dialog's own button opens it", async () => {
    await page.keyboard.press("Control+/");
    await expect(sheet).toBeVisible();
    // G Escape is Leave's, but in the sheet Escape is the sheet's at every step.
    await page.keyboard.press("g");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(view.locator("#create")).toBeVisible();
    await expect(view.locator("#notes")).toBeFocused();
    await view.locator("#dialog-shortcuts").click();
    await expect(sheet.locator(".hotkey-group h3").first()).toHaveText("Create task");
    await page.keyboard.press("Escape");
    await expect(view.locator("#dialog-shortcuts")).toBeFocused();
    await firedNext(frame, []);
  });

  await test.step("a command that opens another dialog keeps the focus it gives", async () => {
    await view.locator("#notes").focus();
    await page.keyboard.press("Control+/");
    await page.keyboard.press("t");
    await expect(view.locator("#date")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(view.locator("#date")).toHaveCount(0);
  });

  await test.step("a command that removes the focused field leaves focus with its dialog", async () => {
    await view.locator("#notes").focus();
    await page.keyboard.press("Control+/");
    await page.keyboard.press("d");
    await expect(view.locator("#notes")).toHaveCount(0);
    await expect(view.locator("#create")).toBeFocused();
    await expect(announced).toHaveText("Discard notes");
    // The dialog's keys work from there.
    await page.keyboard.press("Escape");
    await expect(view.locator("#create")).toHaveCount(0);
    await firedNext(frame, ["dialog Escape"]);
  });
  await test.step("over a native modal dialog, the command's announcement is in the accessibility tree", async () => {
    await view.locator("#body").focus();
    await page.keyboard.press("r");
    const field = view.locator("#native-field");
    await expect(field).toBeFocused();
    await page.keyboard.press("Control+/");
    await expect(sheet).toBeVisible();
    await page.keyboard.press("s");
    await expect(sheet).toBeHidden();
    await expect(field).toBeFocused();
    await firedNext(frame, ["native S"]);
    // A modal dialog makes the rest of the page inert, which only the browser's own tree shows.
    await expect.poll(statuses).toEqual(["Star"]);
    await page.keyboard.press("Escape");
    await expect(view.locator("#native")).toHaveCount(0);
  });
});
