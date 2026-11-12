import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame, Locator, Page } from "@playwright/test";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open } from "./fixtures.js";

// Keys go to the focused document, so a patch hears them only once the shell hands it focus.
// Nothing here clicks the patch: a click would focus its frame on its own.
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

/** Counts the keys the fixture page hears from now on. */
async function keyCounter(frame: Frame) {
  await frame.evaluate(() => {
    const host = window as unknown as { keys: number };
    host.keys = 0;
    addEventListener("keydown", () => host.keys++);
  });
  return () => frame.evaluate(() => (window as unknown as { keys: number }).keys);
}
/**
 * Once the shell has handed focus back to the patch's frame, the next key reaches the patch, so
 * its count is `expected`. It waits for the frame first: a hand-back's second try is a task
 * away, and Chromium runs input ahead of it.
 */
async function nextKeyReaches(page: Page, heard: () => Promise<number>, expected: number) {
  await expect(page.locator("#patch")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect.poll(heard).toBe(expected);
}
// A person's press: a click, or Enter or Space once the button has focus. Enter presses a
// button on keydown and Space on keyup.
const presses = ["click", "Enter", "Space"] as const;
async function press(page: Page, button: Locator, how: (typeof presses)[number]) {
  if (how === "click") return button.click();
  await button.focus();
  await page.keyboard.press(how);
}
const pressed = (how: (typeof presses)[number]) =>
  how === "click" ? "clicked" : `pressed with ${how}`;
/** Stands in for Patchy's own UI, such as another card, holding focus. */
async function shellControl(page: Page) {
  await page.evaluate(() => {
    const control = Object.assign(document.createElement("button"), { textContent: "Shell" });
    document.body.append(control);
    control.focus();
  });
  return page.getByRole("button", { name: "Shell", exact: true });
}
/**
 * Makes the shell's next `frame.focus()` miss, as Firefox's does during the key event that
 * pressed a button, so the hand-back's second try runs in any browser. With `moveTo`, the miss
 * focuses that shell control instead, as a person might before the second try.
 */
const missNextFrameFocus = (page: Page, moveTo?: string) =>
  page.evaluate((moveTo) => {
    const frame = document.querySelector<HTMLIFrameElement>("#patch")!;
    // An own property over the prototype's method, gone after its one call.
    frame.focus = () => {
      Reflect.deleteProperty(frame, "focus");
      if (moveTo !== undefined)
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent === moveTo)
          ?.focus();
    };
  }, moveTo);

test("the next key reaches the patch after the new-version bar's Not now or Hide, clicked or pressed", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  const heard = await keyCounter(frame);
  await page.keyboard.press("ArrowDown");
  await expect.poll(heard).toBe(1);
  const bar = page.getByText(/^A new version of .+ is available\.$/);
  const nextVersion = async () => {
    await instance.publish("company", instance.html, patch.patchId);
    await expect(bar).toBeVisible();
  };
  let expected = 1;
  for (const name of ["Not now", "Hide"] as const) {
    for (const how of presses) {
      await test.step(`${name}, ${pressed(how)}`, async () => {
        await nextVersion();
        await press(page, page.getByRole("button", { name, exact: true }), how);
        await expect(bar).toBeHidden();
        await nextKeyReaches(page, heard, ++expected);
      });
    }
  }

  await test.step("a first try that misses is made again once the press is over", async () => {
    await nextVersion();
    await missNextFrameFocus(page);
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(bar).toBeHidden();
    await nextKeyReaches(page, heard, ++expected);
  });

  await test.step("a press that moves no focus leaves it on the shell control that has it", async () => {
    await nextVersion();
    const control = await shellControl(page);
    // dispatchEvent presses Not now without moving focus to it.
    await page.getByRole("button", { name: "Not now", exact: true }).dispatchEvent("click");
    await expect(bar).toBeHidden();
    await expect(control).toBeFocused();
  });

  await test.step("focus moved to another shell control between the two tries stays there", async () => {
    await nextVersion();
    await missNextFrameFocus(page, "Shell");
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await expect(bar).toBeHidden();
    const control = page.getByRole("button", { name: "Shell", exact: true });
    await expect(control).toBeFocused();
    // Past the second try's task.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
    await expect(control).toBeFocused();
  });
});

test("the next key reaches the patch after a download card's Download, Not now or Dismiss, clicked or pressed", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  const heard = await keyCounter(frame);
  const cards = page.locator(".shell-corner");
  // Over the download limit, the card is a refusal with Dismiss instead of Download and Not now.
  const offer = async (name: string, refused: boolean) => {
    await frame.evaluate(
      ({ name, size }) => {
        void (window as unknown as FixtureWindow).harness.client
          .download(name, new Uint8Array(size))
          .catch(() => {});
      },
      { name, size: refused ? 21 * 1024 * 1024 : 3 }
    );
    const card = cards.getByRole("region", { name, exact: true });
    await expect(card).toBeVisible();
    return card;
  };
  let expected = 0;
  for (const name of ["Download", "Not now", "Dismiss"] as const) {
    for (const how of presses) {
      await test.step(`${name}, ${pressed(how)}`, async () => {
        const card = await offer(`${name} ${how}.bin`, name === "Dismiss");
        const downloaded = name === "Download" ? page.waitForEvent("download") : undefined;
        await press(page, card.getByRole("button", { name, exact: true }), how);
        await downloaded;
        await expect(card).toHaveCount(0);
        await nextKeyReaches(page, heard, ++expected);
      });
    }
  }

  await test.step("a press that moves no focus leaves it on the shell control that has it", async () => {
    const card = await offer("elsewhere.bin", false);
    const control = await shellControl(page);
    // dispatchEvent presses Not now without moving focus to it; Download ignores a script's click.
    await card.getByRole("button", { name: "Not now", exact: true }).dispatchEvent("click");
    await expect(card).toHaveCount(0);
    await expect(control).toBeFocused();
  });
});

test("the next key reaches the patch after the single-key shortcuts dialog closes, by its buttons clicked or pressed, Escape or mid-save", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const dialog = page.getByRole("dialog", {
    name: /^Turn o(n|ff) single-key shortcuts in every patch except public ones\?$/
  });
  const confirm = dialog.getByRole("button", { name: /^Turn o(n|ff)$/ });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  let asked = 0;
  // A fresh load for each, so the press that closed the last dialog needn't lapse first.
  const openDialog = async () => {
    const frame = await open(page, patch);
    const heard = await keyCounter(frame);
    // The dialog opens only on a press, as on a row of the patch's sheet.
    await frame.locator("h1").click();
    await frame.evaluate(
      ({ wire, id }) =>
        (window as unknown as FixtureWindow).harness.raw({
          v: wire,
          id,
          op: "shortcuts.setting",
          args: {}
        }),
      { wire: instance.wire, id: `ask-${++asked}` }
    );
    await expect(dialog).toBeVisible();
    return heard;
  };
  const keyReaches = async (heard: () => Promise<number>) => {
    await expect(dialog).toHaveCount(0);
    await nextKeyReaches(page, heard, 1);
  };
  // Holds the dialog's save at the route until the step lets it through.
  const holdSave = async () => {
    const held = Promise.withResolvers<void>();
    const go = Promise.withResolvers<void>();
    const through = Promise.withResolvers<void>();
    await page.route("**/api/me/shortcuts", async (route) => {
      held.resolve();
      await go.promise;
      await route.continue();
      through.resolve();
    });
    return {
      held: held.promise,
      async release() {
        go.resolve();
        await through.promise;
        await page.unroute("**/api/me/shortcuts");
      }
    };
  };

  for (const [name, button] of [
    ["Turn on or off", confirm],
    ["Cancel", cancel]
  ] as const) {
    for (const how of presses) {
      await test.step(`${name}, ${pressed(how)}`, async () => {
        const heard = await openDialog();
        await press(page, button, how);
        await keyReaches(heard);
      });
    }
  }

  await test.step("Escape", async () => {
    const heard = await openDialog();
    await page.keyboard.press("Escape");
    await keyReaches(heard);
  });

  await test.step("a click on its backdrop leaves it open, and Escape then closes it", async () => {
    const heard = await openDialog();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await keyReaches(heard);
  });

  for (const how of ["click", "Enter", "Space", "Escape"] as const) {
    await test.step(`mid-save, ${how === "Escape" ? "Escape" : `Cancel ${pressed(how)}`}`, async () => {
      const save = await holdSave();
      const heard = await openDialog();
      await confirm.click();
      await save.held;
      if (how === "Escape") await page.keyboard.press("Escape");
      else await press(page, cancel, how);
      await keyReaches(heard);
      await save.release();
    });
  }

  await test.step("a save that answers under the switcher leaves focus in the switcher", async () => {
    const save = await holdSave();
    await openDialog();
    await confirm.click();
    await save.held;
    await page.keyboard.press("ControlOrMeta+Shift+K");
    const search = page
      .getByRole("dialog", { name: "Go to" })
      .getByRole("combobox", { name: "Go to" });
    await expect(search).toBeFocused();
    await save.release();
    await expect(dialog).toHaveCount(0);
    await expect(search).toBeFocused();
  });
});

test("the next key reaches the patch after Dismiss on an older version's note, clicked or pressed", async ({
  page,
  instance
}) => {
  // A viewer with single-key shortcuts off sees the note on a version built before the setting,
  // as a single file is.
  await instance.platform.query(
    "UPDATE users SET single_key_shortcuts = false WHERE id = 'usr_dev'"
  );
  const dismiss = page.getByRole("button", { name: "Dismiss", exact: true });
  // Dismiss lasts for that patch on this device, so each press gets a patch of its own.
  const openNote = async () => {
    const frame = await open(page, await instance.publish());
    await expect(dismiss).toBeVisible();
    return keyCounter(frame);
  };
  for (const how of presses) {
    await test.step(`Dismiss, ${pressed(how)}`, async () => {
      const heard = await openNote();
      await press(page, dismiss, how);
      await expect(dismiss).toHaveCount(0);
      await nextKeyReaches(page, heard, 1);
    });
  }

  await test.step("a press that moves no focus leaves it on the shell control that has it", async () => {
    await openNote();
    const control = await shellControl(page);
    // dispatchEvent presses Dismiss without moving focus to it.
    await dismiss.dispatchEvent("click");
    await expect(dismiss).toHaveCount(0);
    await expect(control).toBeFocused();
  });
});
