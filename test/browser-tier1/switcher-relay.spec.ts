import type { Frame, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

// Mod+Shift+K is Patchy's switcher key. The relay Serving puts first in a patch's document
// claims it before any of the patch's own listeners can hear it, and Patchy's own pages claim it
// from their first byte. Playwright's key presses are trusted, as a person's are; on Linux, where
// these run, Mod is Ctrl.
const chord = "ControlOrMeta+Shift+K";
const explained = "Mod+Shift+K is Patchy's switcher key; it never reaches the patch's own code.";

// A patch listening everywhere a key can be heard, its own capture listener first in its head.
const listening = `<!doctype html><html lang="en"><head data-theme="patch"><script>
window.heard = [];
addEventListener("keydown", (event) => heard.push("window " + event.key), true);
addEventListener("message", (event) => heard.push("message " + event.data?.kind));
</script><title>Listening</title></head><body><h1>Listening</h1>
<input id="field" aria-label="Field" onkeydown="heard.push('onkeydown ' + event.key)">
<script>
document.addEventListener("keydown", (event) => heard.push("document " + event.key));
document.getElementById("field").addEventListener("keydown", (event) => heard.push("field " + event.key));
</script></body></html>`;
const tier1 = { tier: 1, tables: {}, files: {} } as const;

/** What the listening patch and this spec keep on a window, beside the relay's own request. */
type Listening = Window & { heard?: string[]; patchySwitcher?: unknown; settled?: boolean };
const patchFrame = (page: Page): Frame =>
  page.frames().find((frame) => frame.url().includes("/~content/"))!;
const heard = (page: Page) => patchFrame(page).evaluate(() => (window as Listening).heard ?? []);
const requested = (page: Page) => page.evaluate(() => (window as Listening).patchySwitcher);
const field = (page: Page) => page.frameLocator("#patch").getByRole("textbox", { name: "Field" });

/**
 * Waits until the shell has handled everything the frame posted it so far: messages from one
 * source arrive in the order they were sent.
 */
const settled = async (page: Page) => {
  await page.evaluate(() => {
    const shell = window as Listening;
    shell.settled = false;
    addEventListener("message", (event) => {
      if (event.data === "settled") shell.settled = true;
    });
  });
  await patchFrame(page).evaluate(() => parent.postMessage("settled", "*"));
  await expect.poll(() => page.evaluate(() => (window as Listening).settled)).toBe(true);
};

/** Console lines, CSP refusals and uncaught errors, from the shell and its frame alike. */
const watch = (page: Page) => {
  const lines: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => lines.push(message.text()));
  page.on("pageerror", (error) => errors.push(error.message));
  return {
    lines,
    faults: () => [...errors, ...lines.filter((line) => line.includes("Content Security Policy"))]
  };
};

test("a patch's own listeners and fields never hear the switcher key", async ({
  page,
  instance
}) => {
  const log = watch(page);
  const patch = await instance.publish("company", listening, undefined, tier1);
  await page.goto(patch.address);
  await field(page).click();
  await page.keyboard.press(chord);
  await page.keyboard.press("a");
  await expect(field(page)).toHaveValue("a");
  // Shift and Control on their own are no one's shortcut, so the patch hears those.
  expect((await heard(page)).filter((line) => / [ak]$/i.test(line)).sort()).toEqual([
    "document a",
    "field a",
    "onkeydown a",
    "window a"
  ]);
  // The relay went in after the head's own tag, and took its own tag out again.
  expect(
    await patchFrame(page).evaluate(() => [document.head.dataset.theme, document.scripts.length])
  ).toEqual(["patch", 2]);
  expect(log.faults()).toEqual([]);
});

test("the shell takes the relay's open at company scope and ignores it on a public page", async ({
  page,
  instance
}) => {
  const log = watch(page);
  const company = await instance.publish("company", listening, undefined, tier1);
  await page.goto(company.address);
  await field(page).click();
  await page.keyboard.press(chord);
  await settled(page);
  expect(await requested(page)).toBe(true);
  await expect.poll(() => log.lines.filter((line) => line === explained)).toHaveLength(1);

  log.lines.length = 0;
  const open = await instance.publish("public", listening, undefined, tier1);
  await page.goto(open.address);
  await field(page).click();
  await page.keyboard.press(chord);
  await settled(page);
  expect(await requested(page)).toBeUndefined();
  expect(log.lines).not.toContain(explained);
  expect(await heard(page)).not.toContain("window K");
  expect(log.faults()).toEqual([]);
});

test("the shell ignores switcher messages from anywhere but its frame's relay", async ({
  page,
  instance
}) => {
  const patch = await instance.publish("company", listening, undefined, tier1);
  await page.goto(patch.address);
  await patchFrame(page).evaluate(() => {
    parent.postMessage({ patchy: "switcher", v: 2, kind: "open" }, "*");
    parent.postMessage({ patchy: "switcher", v: 1, kind: "menu" }, "*");
    parent.postMessage({ patchy: "switcher", v: 1, kind: "closed" }, "*");
  });
  await settled(page);
  expect(await requested(page)).toBeUndefined();
  // Messages dispatched in the shell can claim any source and origin; only the real pair counts.
  expect(
    await page.evaluate(() => {
      const frame = document.getElementById("patch") as HTMLIFrameElement;
      const open = { patchy: "switcher", v: 1, kind: "open" };
      const post = (source: MessageEventSource | null, origin: string, data: unknown = open) =>
        dispatchEvent(new MessageEvent("message", { data, source, origin }));
      post(window, "null");
      post(frame.contentWindow, location.origin);
      post(frame.contentWindow, "null", { ...open, v: 2 });
      post(frame.contentWindow, "null", { ...open, kind: "menu" });
      post(frame.contentWindow, "null", { ...open, patchy: "elsewhere" });
      const spoofed = (window as Listening).patchySwitcher;
      post(frame.contentWindow, "null");
      return [spoofed, (window as Listening).patchySwitcher];
    })
  ).toEqual([undefined, true]);
});

test("the shell holds the key until the patch's relay says hello, then hands the patch focus", async ({
  page,
  instance
}) => {
  const patch = await instance.publish("company", listening, undefined, tier1);
  const content = Promise.withResolvers<void>();
  await page.route("**/~content/**", async (route) => {
    await content.promise;
    await route.continue();
  });
  // The frame's load event never reaches the shell, so only hello can hand the patch focus.
  await page.addInitScript(() => {
    document.addEventListener(
      "load",
      (event) => {
        if (event.target instanceof HTMLIFrameElement) event.stopImmediatePropagation();
      },
      true
    );
  });
  await page.goto(patch.address, { waitUntil: "domcontentloaded" });
  // The frame is still empty, so the shell keeps focus, and its own relay claims the key.
  await page.keyboard.press(chord);
  expect(
    await page.evaluate(() => [
      document.activeElement === document.body,
      (window as Listening).patchySwitcher
    ])
  ).toEqual([true, true]);
  content.resolve();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("patch");
  await page.keyboard.press("a");
  await expect.poll(() => heard(page)).toContain("window a");
});

test("the relay puts the cursor back where the press found it once the switcher closes", async ({
  page,
  instance
}) => {
  const patch = await instance.publish("company", listening, undefined, tier1);
  await page.goto(patch.address);
  await field(page).fill("hello world");
  await patchFrame(page).evaluate(() =>
    (document.getElementById("field") as HTMLInputElement).setSelectionRange(2, 5)
  );
  await page.keyboard.press(chord);
  await settled(page);
  // As a switcher might leave it: focus and the selection elsewhere.
  await patchFrame(page).evaluate(() => {
    const input = document.getElementById("field") as HTMLInputElement;
    input.setSelectionRange(0, 0);
    input.blur();
  });
  await page.evaluate(() => {
    const frame = document.getElementById("patch") as HTMLIFrameElement;
    frame.focus();
    frame.contentWindow!.postMessage({ patchy: "switcher", v: 1, kind: "closed" }, "*");
  });
  await expect
    .poll(() =>
      patchFrame(page).evaluate(() => {
        const input = document.getElementById("field") as HTMLInputElement;
        return [document.activeElement === input, input.selectionStart, input.selectionEnd];
      })
    )
    .toEqual([true, 2, 5]);
  // Patchy's own message never reaches the patch.
  expect(await heard(page)).not.toContain("message closed");
});

test("Patchy's own pages and notices claim the key from their first byte", async ({
  page,
  instance
}) => {
  const log = watch(page);
  for (const path of ["/", "/~shell/notice/access_denied", "/nobody/nothing-here"]) {
    await page.goto(new URL(path, instance.origin).href);
    await page.keyboard.press(chord);
    expect(await requested(page), path).toBe(true);
  }
  expect(log.faults()).toEqual([]);
});
