import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

// Keys go to the focused document, so a patch hears them only once the shell hands it focus.
// Nothing here clicks: a click would focus the frame on its own.
const counter = `<!doctype html><html><head><title>Key counter</title></head><body><h1>Key counter</h1><p id="keys">0</p><script>
addEventListener("keydown", () => {
  const keys = document.getElementById("keys");
  keys.textContent = String(Number(keys.textContent) + 1);
});
</script></body></html>`;
const keys = (page: Page) => page.frameLocator("#patch").locator("#keys");

test("a patch hears the keyboard once its frame loads", async ({ page, instance }) => {
  const patch = await instance.publish("company", counter, undefined, {
    tier: 1,
    tables: {},
    files: {}
  });
  // The shell's load follows its frame's.
  await page.goto(patch.address);
  await page.keyboard.press("ArrowDown");
  await expect(keys(page)).toHaveText("1");
});

test("a key pressed before the frame's load event still reaches the patch", async ({
  page,
  instance
}) => {
  const patch = await instance.publish("company", counter, undefined, {
    tier: 1,
    tables: {},
    files: {}
  });
  // A patch can be on screen and listening before its frame's load event, which waits on the
  // patch's last subresource. Withholding that event from the shell holds the gap open.
  await page.addInitScript(() => {
    document.addEventListener(
      "load",
      (event) => {
        if (event.target instanceof HTMLIFrameElement) event.stopImmediatePropagation();
      },
      true
    );
  });
  await page.goto(patch.address);
  await page.keyboard.press("ArrowDown");
  await expect(keys(page)).toHaveText("1");
});

test("shell UI that holds focus before the frame loads keeps it", async ({ page, instance }) => {
  const patch = await instance.publish("company", counter, undefined, {
    tier: 1,
    tables: {},
    files: {}
  });
  const content = Promise.withResolvers<void>();
  await page.route("**/~content/**", async (route) => {
    await content.promise;
    await route.continue();
  });
  await page.goto(patch.address, { waitUntil: "domcontentloaded" });
  // Stands in for Patchy's own UI, such as a download card, focused while the frame loads.
  await page.evaluate(() => {
    const control = Object.assign(document.createElement("button"), { textContent: "Shell" });
    document.body.append(control);
    control.focus();
  });
  content.resolve();
  await page.waitForLoadState("load");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("button", { name: "Shell" })).toBeFocused();
  await expect(keys(page)).toHaveText("0");
});

test("a tier 2 patch hears the keyboard on load and again once its starting cover clears", async ({
  page,
  instance
}) => {
  const server = await build({
    stdin: {
      contents: 'import { createGuest } from "patchy/server"; export default createGuest({});',
      resolveDir: fileURLToPath(new URL("../../packages/patchy", import.meta.url))
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm"
  });
  const patch = await instance.publish(
    "company",
    counter,
    undefined,
    { tier: 2, tables: {}, files: {}, uses: {}, handlers: {} },
    { server: server.outputFiles[0]!.text }
  );
  instance.holdStreamFrames(true);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.goto(patch.address);
  await page.keyboard.press("ArrowDown");
  await expect(keys(page)).toHaveText("1");
  const cover = page.getByRole("dialog", { name: "Starting your tools" });
  await page.clock.fastForward(2_000);
  await expect(cover).toBeFocused();
  await page.clock.resume();
  instance.holdStreamFrames(false);
  await expect(cover).toBeHidden();
  await page.keyboard.press("ArrowDown");
  await expect(keys(page)).toHaveText("2");
});
