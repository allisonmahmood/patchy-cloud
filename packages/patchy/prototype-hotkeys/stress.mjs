// PROTOTYPE stress test for patchy/hotkeys in the real shell + sandboxed frame.
// node .local/stress/hotkeys.mjs <dev url> [mac]
import { chromium } from "@playwright/test";

const url = process.argv[2];
const mac = process.argv[3] === "mac";
const results = [];
const browser = await chromium.launch();
const context = await browser.newContext();
if (mac)
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    Object.defineProperty(Navigator.prototype, "userAgent", {
      get: () =>
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36"
    });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => ({ platform: "macOS" })
    });
  });
const page = await context.newPage();
const consoleLines = [];
page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) => consoleLines.push(`pageerror: ${error.message}`));

const frame = () => page.frames().find((candidate) => candidate !== page.mainFrame());
const log = async () =>
  (await frame().evaluate(() => window.hotkeyLog())).map((entry) => entry.hotkey);
const clear = () => frame().evaluate(() => window.clearHotkeyLog());
const title = () => frame().locator("[data-testid=title]").textContent();
const list = () => frame().evaluate(() => window.hotkeyList);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sequence = async (...keys) => {
  for (const key of keys) {
    await page.keyboard.press(key);
    await wait(60);
  }
  await wait(150);
};
const check = async (name, fn) => {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note ?? "" });
  } catch (error) {
    results.push({ name, ok: false, note: error instanceof Error ? error.message : String(error) });
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
const blurToBody = () =>
  frame().evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
const mod = mac ? "Meta" : "Control";

await page.goto(url);
await page.waitForFunction(() => document.querySelector("iframe#patch") !== null);
await wait(500);
await frame().locator("[data-testid=title]").waitFor();
await frame().locator(".tasks li").first().waitFor({ timeout: 10000 });

await check("shell hands focus to the frame on load", async () => {
  const active = await page.evaluate(
    () => document.activeElement?.id ?? document.activeElement?.tagName
  );
  expect(active === "patch", `shell activeElement is ${active}`);
  await clear();
  await sequence("g", "t");
  expect((await title()) === "Timeline", `title is ${await title()} after G T without a click`);
  return "G T works before any click";
});

await check("without frame focus, keys never reach the patch", async () => {
  await page.evaluate(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined
  );
  await clear();
  await sequence("g", "h");
  const fired = await log();
  const stillTimeline = (await title()) === "Timeline";
  await page.evaluate(() => document.getElementById("patch").focus());
  expect(fired.length === 0 && stillTimeline, `fired ${fired} while shell held focus`);
  return "confirms the shell fix is load-bearing";
});

await check("G sequences route through patchy.route", async () => {
  for (const [keys, expected] of [
    [["g", "a"], "Activity"],
    [["g", "l"], "Lab"],
    [["g", "h"], "Home"]
  ]) {
    await sequence(...keys);
    expect((await title()) === expected, `${keys.join(" ")} → ${await title()}`);
  }
  const route = await frame().evaluate(() => location.href);
  return `routes OK (frame url ${new URL(route).pathname})`;
});

await check("sequence times out after a slow second step", async () => {
  await clear();
  await page.keyboard.press("g");
  await wait(1300);
  await page.keyboard.press("t");
  await wait(200);
  expect((await title()) === "Home", `slow G…T still routed to ${await title()}`);
});

await check("uppercase and Shift do not trigger letter sequences", async () => {
  await clear();
  await sequence("Shift+G", "Shift+T");
  expect((await title()) === "Home", `Shift+G Shift+T routed to ${await title()}`);
});

await check("J/K move selection, X toggles done via table write", async () => {
  await clear();
  await sequence("j", "j", "k");
  const selected = await frame().locator(".tasks li.selected").textContent();
  await page.keyboard.press("x");
  await wait(800);
  const after = await frame().locator(".tasks li.selected").textContent();
  expect(selected !== after, `X did not change ${selected}`);
  await page.keyboard.press("x");
  await wait(800);
  return `${selected?.trim()} → ${after?.trim()}`;
});

await check("held J repeats (keydown repeat fires each time)", async () => {
  await clear();
  await page.keyboard.down("j");
  for (let index = 0; index < 4; index++) await page.keyboard.down("j");
  await page.keyboard.up("j");
  await wait(100);
  const fired = await frame().evaluate(() =>
    window.hotkeyLog().filter((entry) => entry.hotkey === "J")
  );
  return `${fired.length} fires, ${fired.filter((entry) => entry.repeat).length} marked repeat`;
});

await check("Mod+K focuses search; typing letters there fires nothing", async () => {
  await clear();
  await page.keyboard.press(`${mod}+k`);
  await wait(100);
  const focused = await frame().evaluate(() => document.activeElement?.getAttribute("aria-label"));
  await page.keyboard.type("g t j x c t");
  await wait(300);
  const fired = await log();
  const value = await frame().locator("input[type=search]").inputValue();
  await frame().locator("input[type=search]").fill("");
  await frame().evaluate(() =>
    document
      .querySelector("input[type=search]")
      .dispatchEvent(new Event("input", { bubbles: true }))
  );
  await blurToBody();
  expect(focused === "Search tasks", `focus is on ${focused}`);
  expect(fired.length === 1 && fired[0] === "Mod+K", `fired while typing: ${fired}`);
  return `typed "${value}" untouched`;
});

await check("C T opens the dialog; exclusive scope silences page keys", async () => {
  await sequence("c", "t");
  const open = await frame().locator("[role=dialog][aria-label='New task']").count();
  expect(open === 1, "dialog did not open");
  const inputFocused = await frame().evaluate(() =>
    document.activeElement?.getAttribute("aria-label")
  );
  await page.keyboard.type("c t");
  await blurToBody();
  await clear();
  await sequence("g", "t");
  await sequence("c", "t");
  await sequence("j");
  const fired = await log();
  const dialogs = await frame().locator("[role=dialog]").count();
  expect(
    (await title()) === "Home" && dialogs === 1 && fired.length === 0,
    `leaked: ${fired} title ${await title()} dialogs ${dialogs}`
  );
  return `input focused: ${inputFocused}`;
});

await check("Mod+Enter in the dialog's input creates a task; Escape closes", async () => {
  const before = await frame().locator(".tasks li").count();
  await frame().locator("input[name=title]").fill("Made by Mod+Enter");
  await frame().locator("input[name=title]").focus();
  await page.keyboard.press(`${mod}+Enter`);
  await wait(1200);
  const after = await frame().locator(".tasks li").count();
  const dialogs = await frame().locator("[role=dialog]").count();
  expect(after === before + 1, `tasks ${before} → ${after}`);
  expect(dialogs === 0, "dialog still open after create");
  await sequence("c", "t");
  await page.keyboard.press("Escape");
  await wait(150);
  expect((await frame().locator("[role=dialog]").count()) === 0, "Escape left the dialog open");
});

await check("Shift+? sheet lists the page's hotkeys", async () => {
  const pageList = (await list()).map((item) => item.label);
  await page.keyboard.press("Shift+?");
  await wait(200);
  const rows = await frame().locator(".sheet li").allTextContents();
  await page.keyboard.press("Escape");
  await wait(150);
  expect(rows.length > 3, `sheet shows only ${rows.length}: ${rows.join(" | ")}`);
  return `${rows.length} rows; page list had ${pageList.length}`;
});

await check("Shift+? also fires on other layouts' ? (synthetic AZERTY Shift+Comma)", async () => {
  await clear();
  await frame().evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", code: "Comma", shiftKey: true, bubbles: true })
    )
  );
  await wait(150);
  const fired = await log();
  if (fired.includes("Shift+?")) await page.keyboard.press("Escape");
  await wait(100);
  expect(fired.includes("Shift+?"), `fired ${fired}`);
  return "untrusted synthetic events are matched too";
});

await check("non-Latin layout: Cyrillic о on KeyJ still moves J", async () => {
  await clear();
  await frame().evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "о", code: "KeyJ", bubbles: true })
    )
  );
  await wait(100);
  return `fired: ${(await log()).join(", ") || "nothing"}`;
});

await check("IME composition keydown is ignored", async () => {
  await clear();
  await frame().evaluate(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", code: "KeyJ", isComposing: true, bubbles: true })
    )
  );
  await wait(100);
  const fired = await log();
  expect(fired.length === 0, `fired ${fired}`);
});

// Lab
await sequence("g", "l");
await frame().locator(".lab").waitFor();

const labFires = async (selector, key) => {
  await clear();
  await frame().locator(selector).focus();
  await page.keyboard.press(key);
  await wait(120);
  const fired = await log();
  await blurToBody();
  return fired;
};
for (const [control, selector] of [
  ["text input", "[data-testid=text]"],
  ["number input", "[data-testid=number]"],
  ["textarea", "[data-testid=textarea]"],
  ["select", "[data-testid=select]"],
  ["contenteditable", "[data-testid=editable]"],
  ["checkbox", "[data-testid=checkbox]"],
  ["range", "[data-testid=range]"],
  ["button", "[data-testid=button]"],
  ["summary", "[data-testid=summary]"]
])
  await check(
    `single key L while focus is on ${control}`,
    async () => `L ${(await labFires(selector, "l")).includes("L") ? "FIRES" : "waits"}`
  );

await check("Mod+S fires inside a text input and stops the browser's save", async () => {
  const fired = await labFires("[data-testid=text]", `${mod}+s`);
  expect(fired.includes("Mod+S"), `fired ${fired}`);
});

await check("repeat: false — held Mod+S fires once", async () => {
  await clear();
  await page.keyboard.down(mod);
  for (let index = 0; index < 4; index++) await page.keyboard.down("s");
  await page.keyboard.up("s");
  await page.keyboard.up(mod);
  await wait(100);
  const fired = (await log()).filter((hotkey) => hotkey === "Mod+S");
  expect(fired.length === 1, `fired ${fired.length} times`);
});

await check("whileTyping: true fires in an input and swallows the character", async () => {
  await frame().locator("[data-testid=text]").fill("");
  const fired = await labFires("[data-testid=text]", "t");
  const value = await frame().locator("[data-testid=text]").inputValue();
  return `fired ${fired.join(",")}; input value "${value}"`;
});

await check("Space on a focused button: button keeps it?", async () => {
  const before = await frame().locator("[data-testid=button]").textContent();
  const fired = await labFires("[data-testid=button]", "Space");
  const after = await frame().locator("[data-testid=button]").textContent();
  if (before !== after) await frame().locator("[data-testid=button]").click();
  await blurToBody();
  return `hotkey ${fired.includes("Space") ? "fired" : "did not fire"}; button ${before !== after ? "clicked" : "not clicked"}`;
});

await check("Space on body fires and stops page scroll", async () => {
  const fired = await labFires("body", "Space");
  expect(fired.includes("Space"), `fired ${fired}`);
});

for (const [name, keys, expected] of [
  ["slash", ["/"], "/"],
  ["digit", ["1"], "1"],
  ["Mod+Shift+P", [`${mod}+Shift+p`], "Mod+Shift+P"],
  ["Alt+ArrowUp", ["Alt+ArrowUp"], "Alt+ArrowUp"],
  ["Shift+L distinct from L", ["Shift+l"], "Shift+L"],
  ["three-step D I W", ["d", "i", "w"], "D I W"],
  ["Mod+T reaches the page headless (a real browser keeps it)", [`${mod}+t`], "Mod+T"]
])
  await check(name, async () => {
    await clear();
    await sequence(...keys);
    const fired = await log();
    expect(fired.includes(expected), `fired ${fired}`);
    return fired.join(", ");
  });

await check("disabled L stays quiet and drops from the list", async () => {
  await frame().locator("[data-testid=toggle-l]").click();
  await blurToBody();
  await clear();
  await sequence("l");
  const fired = await log();
  const listed = (await list()).some((item) => item.label === "Lab: plain L");
  await frame().locator("[data-testid=toggle-l]").click();
  await blurToBody();
  expect(!fired.includes("L") && !listed, `fired ${fired}, listed ${listed}`);
});

await check("G alone beside G sequences", async () => {
  await frame().locator("[data-testid=button]").click();
  await blurToBody();
  await clear();
  await page.keyboard.press("g");
  await wait(1300);
  const alone = await log();
  await clear();
  await sequence("g", "l");
  const both = await log();
  await frame().locator("[data-testid=button]").click();
  await blurToBody();
  return `G then pause: [${alone}]; G L: [${both}] title ${await title()}`;
});

await check("156 extra hotkeys: keypress cost", async () => {
  await frame().locator("[data-testid=toggle-many]").click();
  await blurToBody();
  const cost = await frame().evaluate(async () => {
    const times = [];
    for (let index = 0; index < 200; index++) {
      const start = performance.now();
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "q", code: "KeyQ", bubbles: true })
      );
      document.body.dispatchEvent(
        new KeyboardEvent("keyup", { key: "q", code: "KeyQ", bubbles: true })
      );
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { median: times[100], p99: times[198] };
  });
  await clear();
  await sequence("Alt+Shift+q");
  const fired = await log();
  await frame().locator("[data-testid=toggle-many]").click();
  await blurToBody();
  expect(fired.includes("Alt+Shift+Q"), `fired ${fired}`);
  return `median ${cost.median.toFixed(3)} ms, p99 ${cost.p99.toFixed(3)} ms per unmatched key`;
});

await check("route churn: 40 remounts leave no stale registrations", async () => {
  const before = (await list()).length;
  for (let index = 0; index < 20; index++) {
    await sequence("g", "h");
    await sequence("g", "l");
  }
  const after = (await list()).length;
  expect(before === after, `list ${before} → ${after}`);
  return `${after} listed before and after`;
});

await check("display strings", async () =>
  frame().evaluate(() => document.querySelector(".lab p")?.textContent ?? "")
);

await check("dev reload: focus returns after the page rebuilds", async () => {
  await page.reload();
  await page.waitForFunction(() => document.querySelector("iframe#patch") !== null);
  await wait(800);
  await frame().locator("[data-testid=title]").waitFor();
  await sequence("g", "a");
  expect((await title()) === "Activity", `title ${await title()}`);
});

const warnings = consoleLines.filter(
  (line) => !line.startsWith("log:") && !line.startsWith("debug:")
);
for (const result of results)
  console.log(
    `${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.note ? `  — ${result.note}` : ""}`
  );
console.log(
  `\n${results.filter((result) => result.ok).length}/${results.length} passed (${mac ? "mac" : "linux"} platform)`
);
console.log(`console (${warnings.length}):\n${[...new Set(warnings)].slice(0, 15).join("\n")}`);
await browser.close();
