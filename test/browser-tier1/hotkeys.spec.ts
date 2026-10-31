import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import type { Instance } from "./instance.js";

// packages/patchy/src/hotkeys.test.ts and hotkeyRules.test.ts own the types and the warnings'
// words. These pages prove what only a browser shows: real key events reaching patchy/hotkeys in
// the published frame, in fields, controls, a scope, other layouts and on a Mac, and the conflict
// warning waiting until every hook's update has landed.
test.skip(({ browserName }) => browserName !== "chromium", "The SDK targets Chromium desktop.");
const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
const source = `import { render, useEffect, useState } from "patchy/preact";
import { createClient } from "patchy/client";
import { HotkeyScope, formatHotkey, useHotkey, useHotkeyList } from "patchy/hotkeys";

const client = createClient({ tables: {}, files: {} });
const fired: string[] = [];
const log = (name: string) => () => { fired.push(name); };
Object.assign(window, { fired });

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
    // The sheet's Escape registers after it renders; the list shows it once it has.
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
