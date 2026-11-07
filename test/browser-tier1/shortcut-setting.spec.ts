import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import type { Frame, Page } from "@playwright/test";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open } from "./fixtures.js";
import type { Instance } from "./instance.js";

// The viewer's single-key shortcut setting through Patchy's real shell and broker: the shell names
// a viewer's frame with it, patchy/hotkeys obeys that name, and the shell confirms a change in its
// own dialog. Each engine sets a frame's name for itself, so these also run in Firefox and WebKit.
//
// Playwright's own calls into a page count as a press there, and in the shell above it, for about
// five seconds. A step that needs nothing pressed waits that out without touching the page.
const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
const hotkeys = `import { render } from "patchy/preact";
import { createClient } from "patchy/client";
import { HotkeySheet, useHotkey } from "patchy/hotkeys";

createClient({ tables: {}, files: {} });
const fired: string[] = [];
const log = (name: string) => () => { fired.push(name); };
Object.assign(window, { fired });

function App() {
  useHotkey("A", log("A"), { label: "Assign to me" });
  useHotkey("G H", log("G H"), { label: "Go home" });
  useHotkey("Mod+K", log("Mod+K"), { label: "Find a deal" });
  return <main><h1>Deals</h1><p id="body" tabIndex={-1}>body</p><HotkeySheet /></main>;
}
render(<App />, document.getElementById("app")!);
`;

/** The hotkeys page, bundled against the built patchy package as a single-file page. */
const hotkeysHtml = async () => {
  const bundle = await build({
    stdin: { contents: hotkeys, loader: "tsx", resolveDir: packageRoot, sourcefile: "deals.tsx" },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "patchy/preact",
    define: { "import.meta.env.DEV": "false" }
  });
  const script = bundle.outputFiles[0]!.text.replaceAll("</script", "<\\/script");
  return `<!doctype html><html><head><title>Deals</title></head><body><div id="app"></div><script>${script}</script></body></html>`;
};

const stored = async (instance: Instance, userId = "usr_dev") =>
  (
    await instance.platform.query<{ on: boolean }>(
      "SELECT single_key_shortcuts AS on FROM users WHERE id = $1",
      [userId]
    )
  ).rows[0]?.on;
const store = (instance: Instance, on: boolean, userId = "usr_dev") =>
  instance.platform.query("UPDATE users SET single_key_shortcuts = $1 WHERE id = $2", [on, userId]);

/** Opens a published hotkeys page and waits for it to render. */
const openDeals = async (page: Page, address: string) => {
  expect((await page.goto(address))?.status()).toBe(200);
  const view = page.frameLocator("#patch");
  await expect(view.getByRole("heading", { name: "Deals" })).toBeVisible();
  const frame = page.frames().find((candidate) => candidate.url().includes("/~content/"));
  if (!frame) throw new Error("The hotkeys page did not load.");
  return { frame, view, sheet: view.getByRole("dialog", { name: "Keyboard shortcuts" }) };
};
type Fired = { fired: string[] };
/** The hotkeys fired since the last call, once `expected` have, so a stray one fails the check. */
const firedNext = async (frame: Frame, expected: string[]) => {
  await expect
    .poll(() => frame.evaluate(() => [...(window as unknown as Fired).fired]))
    .toEqual(expected);
  await frame.evaluate(() => (window as unknown as Fired).fired.splice(0));
};
/** Presses the page's keys from its body: A and G H are single-key, Mod+K isn't. */
const pressAll = async (page: Page, frame: Frame) => {
  await frame.locator("#body").focus();
  for (const key of ["a", "g", "h", "Control+k"]) await page.keyboard.press(key);
};
const shellDialog = (page: Page) => page.getByRole("dialog", { name: "Single-key shortcuts" });

/**
 * Asks the shell with the fixture page's raw port, as a patch of any SDK could, now or after
 * `delay` milliseconds of the page's clock.
 */
const ask = (frame: Frame, wire: number, id: string, delay?: number) =>
  frame.evaluate(
    ({ wire, id, delay }) => {
      const send = () =>
        (window as unknown as FixtureWindow).harness.raw({
          v: wire,
          id,
          op: "shortcuts.setting",
          args: {}
        });
      if (delay === undefined) send();
      else setTimeout(send, delay);
    },
    { wire, id, delay }
  );
const answer = (frame: Frame, id: string) =>
  frame.evaluate(
    (id) => (window as unknown as FixtureWindow).harness.replies.find((reply) => reply.id === id),
    id
  );

test("Off reaches the patch, so its single-key shortcuts stop while the rest fire, after a new version's reload too", async ({
  page,
  instance
}) => {
  await store(instance, false);
  const html = await hotkeysHtml();
  const patch = await instance.publish("company", html);
  const { frame } = await openDeals(page, patch.address);
  expect(await frame.evaluate(() => window.name)).toBe("patchy:shortcuts=off");
  await pressAll(page, frame);
  await firedNext(frame, ["Mod+K"]);

  const next = await instance.publish("company", html, patch.patchId);
  await expect(page.getByText(/^A new version of .+ is available\.$/)).toBeVisible();
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator("#patch")).toHaveAttribute("data-version-id", next.versionId);
  const reloaded = await openDeals(page, page.url());
  expect(await reloaded.frame.evaluate(() => window.name)).toBe("patchy:shortcuts=off");
  await pressAll(page, reloaded.frame);
  await firedNext(reloaded.frame, ["Mod+K"]);
});

test("the sheet's row opens Patchy's dialog, which changes the setting live; a failure, an empty answer and Escape change nothing", async ({
  page,
  instance
}) => {
  await store(instance, false);
  const patch = await instance.publish("company", await hotkeysHtml());
  const { frame, sheet } = await openDeals(page, patch.address);
  const dialog = shellDialog(page);
  await frame.locator("#body").focus();
  await page.keyboard.press("Control+/");
  await sheet.getByRole("button", { name: "Single-key shortcuts: Off" }).click();

  await test.step("Patchy's dialog takes focus and keeps Tab inside", async () => {
    await expect(dialog).toBeVisible();
    await expect(sheet).toBeHidden();
    const turnOn = dialog.getByRole("button", { name: "Turn on" });
    await expect(turnOn).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(turnOn).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(turnOn).toBeFocused();
  });

  await test.step("a refused save, a 200 without the value and an empty 200 say so, and change nothing", async () => {
    const answers = [
      { status: 503, contentType: "text/html", body: "<p>Settings unavailable</p>" },
      { status: 200, contentType: "application/json", body: "{}" },
      // What a body cut off at the route's size limit leaves.
      { status: 200, contentType: "application/json", body: "" }
    ];
    await page.route("**/api/me/shortcuts", (route) => route.fulfill(answers.shift()!));
    await dialog.getByRole("button", { name: "Turn on" }).click();
    for (const remaining of [2, 1, 0]) {
      await expect(dialog.getByRole("alert")).toHaveText("Couldn't save. Nothing changed.");
      await expect.poll(() => answers.length).toBe(remaining);
      if (remaining > 0) await dialog.getByRole("button", { name: "Try again" }).click();
    }
    expect(await stored(instance)).toBe(false);
    await page.unroute("**/api/me/shortcuts");
  });

  await test.step("Try again saves, and the sheet comes back on its row, now On, with every shortcut live", async () => {
    await dialog.getByRole("button", { name: "Try again" }).click();
    await expect(dialog).toBeHidden();
    await expect(sheet.getByRole("button", { name: "Single-key shortcuts: On" })).toBeFocused();
    expect(await stored(instance)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await pressAll(page, frame);
    await firedNext(frame, ["A", "G H", "Mod+K"]);
  });

  await test.step("a reload keeps it", async () => {
    const reloaded = await openDeals(page, patch.address);
    expect(await reloaded.frame.evaluate(() => window.name)).toBe("patchy:shortcuts=on");
  });

  await test.step("Escape cancels, focus goes back to the frame and the setting stays", async () => {
    const { frame: current, sheet: open } = await openDeals(page, patch.address);
    await current.locator("#body").focus();
    await page.keyboard.press("Control+/");
    await open.getByRole("button", { name: "Single-key shortcuts: On" }).click();
    await expect(dialog.getByRole("button", { name: "Turn off" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open.getByRole("button", { name: "Single-key shortcuts: On" })).toBeFocused();
    expect(await stored(instance)).toBe(true);
  });
});

test("a dialog needs a press: none, one already open, or the press a Cancel answered shows nothing, and a later press does", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  const dialog = shellDialog(page);

  await test.step("with nothing pressed, a question gets the setting as it is", async () => {
    await ask(frame, instance.wire, "unpressed", 6_000);
    // Nothing touches the page while the press that evaluate counts as lapses.
    await sleep(7_000);
    expect(await answer(frame, "unpressed")).toMatchObject({ kind: "result", value: true });
    await expect(dialog).toHaveCount(0);
  });

  await test.step("one dialog at a time", async () => {
    await ask(frame, instance.wire, "first");
    await expect(dialog).toBeVisible();
    await ask(frame, instance.wire, "second");
    await expect.poll(() => answer(frame, "second")).toMatchObject({ value: true });
    await expect(dialog).toHaveCount(1);
  });

  await test.step("a script's click in the dialog changes nothing", async () => {
    await page.evaluate(() =>
      [...document.querySelectorAll("dialog button")]
        .find((button) => button.textContent === "Turn off")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    await expect(dialog).toBeVisible();
    expect(await stored(instance)).toBe(true);
  });

  await test.step("Cancel answers the setting as it was, and asking again on that press shows nothing", async () => {
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => answer(frame, "first")).toMatchObject({ value: true });
    await sleep(1_500);
    await ask(frame, instance.wire, "again");
    await expect.poll(() => answer(frame, "again")).toMatchObject({ value: true });
    await expect(dialog).toHaveCount(0);
  });

  await test.step("once that press has lapsed, a new one opens it", async () => {
    await sleep(6_500);
    await ask(frame, instance.wire, "later");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Turn off" }).click();
    await expect.poll(() => answer(frame, "later")).toMatchObject({ value: false });
    expect(await stored(instance)).toBe(false);
  });
});

test("the account menu's switch turns them off and on, back on the same page", async ({
  page,
  instance
}) => {
  const patch = await instance.publish("company", await hotkeysHtml());
  const row = page.locator("#account-menu").getByRole("switch", { name: "Single-key shortcuts" });
  await page.goto(`${instance.origin}/patches?tab=pages`);
  for (const [checked, receipt, on] of [
    ["true", "Turned off single-key shortcuts", false],
    ["false", "Turned on single-key shortcuts", true]
  ] as const) {
    await page.locator(".app-account").click();
    await expect(row).toHaveAttribute("aria-checked", checked);
    await row.click();
    await expect(page).toHaveURL(`${instance.origin}/patches?tab=pages`);
    await expect(page.locator(".app-receipt")).toHaveText(receipt);
    expect(await stored(instance)).toBe(on);
  }
  await page.locator(".app-account").click();
  await expect(row).toHaveAttribute("aria-checked", "true");
  await store(instance, false);
  const { frame } = await openDeals(page, patch.address);
  expect(await frame.evaluate(() => window.name)).toBe("patchy:shortcuts=off");
});

test("a guest's setting is their own", async ({ page, context, instance }) => {
  const patch = await instance.publish("company", await hotkeysHtml());
  await instance.addGuest(patch.patchId, "guest@pine.example");
  await instance.session(context, "guest");
  const { frame, sheet } = await openDeals(page, patch.address);
  expect(await frame.evaluate(() => window.name)).toBe("patchy:shortcuts=on");
  await frame.locator("#body").focus();
  await page.keyboard.press("Control+/");
  await sheet.getByRole("button", { name: "Single-key shortcuts: On" }).click();
  await shellDialog(page).getByRole("button", { name: "Turn off" }).click();
  await expect(sheet.getByRole("button", { name: "Single-key shortcuts: Off" })).toBeFocused();
  expect(await stored(instance, "usr_guest")).toBe(false);
  expect(await stored(instance)).toBe(true);
  await instance.session(context, "owner");
  const owner = await openDeals(page, patch.address);
  expect(await owner.frame.evaluate(() => window.name)).toBe("patchy:shortcuts=on");
});

test("a public patch keeps its shortcuts for a viewer signed in with them off, and its shell has no setting to change", async ({
  page,
  instance
}) => {
  await store(instance, false);
  const patch = await instance.publish("public", await hotkeysHtml());
  const { frame, sheet } = await openDeals(page, patch.address);
  expect(await frame.evaluate(() => window.name)).toBe("");
  await pressAll(page, frame);
  await firedNext(frame, ["A", "G H", "Mod+K"]);
  await page.keyboard.press("?");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: /^Single-key shortcuts/ })).toHaveCount(0);

  // A patch that asks anyway, as under an older shell, is refused.
  const fixture = await open(page, await instance.publish("public"));
  await ask(fixture, instance.wire, "public");
  await expect
    .poll(() => answer(fixture, "public"))
    .toMatchObject({ kind: "error", error: { code: "invalid_request" } });
  await expect(shellDialog(page)).toHaveCount(0);
});

test.describe("tier 2", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Tier 2 targets Chromium desktop.");

  test("while the starting cover is up, a question gets the setting as it is", async ({
    page,
    instance
  }) => {
    const server = await build({
      stdin: {
        contents: `import { query, createGuest, t } from "patchy/server";
const ping = query({ args: {}, result: t.text(), handler: () => "pong" });
export default createGuest({ rows: { ping } });`,
        resolveDir: packageRoot,
        sourcefile: "shortcuts-server.ts"
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      conditions: ["development"]
    });
    const patch = await instance.publish(
      "company",
      instance.html,
      undefined,
      {
        tier: 2,
        files: {},
        handlers: { "rows.ping": { kind: "query", args: {}, result: { kind: "text" } } }
      },
      { server: server.outputFiles[0]!.text }
    );
    instance.holdStreamFrames(true);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    const frame = await open(page, patch);
    const cover = page.getByRole("dialog", { name: "Starting your tools" });
    await page.clock.fastForward(2_000);
    await expect(cover).toBeVisible();
    await ask(frame, instance.wire, "starting");
    await expect.poll(() => answer(frame, "starting")).toMatchObject({ value: true });
    await expect(shellDialog(page)).toHaveCount(0);
    instance.holdStreamFrames(false);
    await expect(cover).toBeHidden();
    await page.clock.resume();
    await ask(frame, instance.wire, "ready");
    await expect(shellDialog(page)).toBeVisible();
  });
});

test.describe("an older version's note", () => {
  const note = (page: Page) =>
    page.getByRole("status").filter({
      hasText: "This patch's single-key shortcuts still work until it's updated."
    });
  // Built with patchy/hotkeys by a CLI from before the setting: it recorded no shortcutSetting.
  const older = { sdkImports: ["patchy/preact", "patchy/hotkeys"] };

  test("shows to a viewer with them off, until they dismiss it for that patch", async ({
    page,
    instance
  }) => {
    await store(instance, false);
    const html = await hotkeysHtml();
    const first = await instance.publish("company", html, undefined, older);
    const second = await instance.publish("company", html, undefined, older);
    await openDeals(page, first.address);
    await expect(note(page)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(note(page)).toHaveCount(0);
    await expect(page.locator("#patch")).toBeFocused();
    await openDeals(page, first.address);
    await expect(page.locator("#patch")).toBeVisible();
    await expect(note(page)).toHaveCount(0);
    // Dismissed for that patch only.
    await openDeals(page, second.address);
    await expect(note(page)).toBeVisible();
    // Never for a viewer with them on.
    await store(instance, true);
    await openDeals(page, second.address);
    await expect(note(page)).toHaveCount(0);
  });

  test("doesn't show on a version that obeys the setting, or one from before patchy/hotkeys", async ({
    page,
    instance
  }) => {
    await store(instance, false);
    const html = await hotkeysHtml();
    const patch = await instance.publish("company", html, undefined, older);
    await openDeals(page, patch.address);
    await expect(note(page)).toBeVisible();
    await instance.publish("company", html, patch.patchId, { ...older, shortcutSetting: 1 });
    await openDeals(page, patch.address);
    await expect(note(page)).toHaveCount(0);

    const before = await instance.publish("company", html, undefined, older);
    await instance.platform.query("UPDATE patch_versions SET release = '0.32.0' WHERE id = $1", [
      before.versionId
    ]);
    await openDeals(page, before.address);
    await expect(note(page)).toHaveCount(0);
  });
});
