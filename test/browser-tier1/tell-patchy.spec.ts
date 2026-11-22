import type { Page } from "@playwright/test";
import { test, expect, prepare } from "./fixtures.js";

// Tell Patchy's panel, in the sidebar's foot: what its script does with answers that arrive late,
// with focus when it closes, and with a link to the composer, with and without script. The routes
// themselves are the portal's own tests.

const panel = (page: Page) => page.getByRole("dialog", { name: "Tell Patchy" });
const foot = (page: Page) => page.locator(".tell-patchy-button");
const field = (page: Page) => page.locator("#tell-patchy-text");

test("a send answered after the panel closed and opened again leaves the new draft alone, and says it couldn't confirm the first", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/`);
  await foot(page).click();
  await field(page).fill("Postgres connection encrypted with RSA");

  // Hold the send's answer until the panel has closed and opened again.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/feedback", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.continue();
  });
  await panel(page).getByRole("button", { name: "Send" }).click();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();

  // It may have been saved, so it opens again with the draft kept and the note.
  await foot(page).click();
  await expect(panel(page).getByText("Patchy couldn’t confirm that")).toBeVisible();
  await expect(field(page)).toHaveValue("Postgres connection encrypted with RSA");
  await field(page).fill("A second draft");

  const answered = page.waitForResponse(
    (response) => response.url().endsWith("/feedback") && response.request().method() === "POST"
  );
  release();
  await answered;
  // The late answer is dropped: no receipt over the new draft, which stays.
  await expect(panel(page).getByText(/^Request sent:/)).toHaveCount(0);
  await expect(field(page)).toBeVisible();
  await expect(field(page)).toHaveValue("A second draft");
});

test("closing the panel gives focus back to Tell Patchy, after the switcher took it too", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/`);
  await foot(page).click();
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(foot(page)).toBeFocused();

  // The switcher's chord from the panel's field, then Escape, comes back to Tell Patchy.
  await foot(page).click();
  await expect(field(page)).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await expect(page.getByRole("dialog", { name: "Go to" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Go to" })).toBeHidden();
  await expect(foot(page)).toBeFocused();
});

// The switcher hides the panel as it opens. Chromium and Firefox say so with the panel's toggle;
// WebKit says nothing, so there the panel settles as the switcher closes. Either way it ends the same.
test("a send answered while the switcher is open opens again with the draft kept and the note", async ({
  page,
  instance
}) => {
  const switcher = page.getByRole("dialog", { name: "Go to" });
  await page.goto(`${instance.origin}/`);
  await foot(page).click();
  await field(page).fill("Postgres connection encrypted with RSA");

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/feedback", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.continue();
  });
  // Settles once the panel's script has read the answer and done what it does with it.
  const read = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const text = Response.prototype.text;
        Response.prototype.text = function (this: Response) {
          const url = this.url;
          return text.call(this).finally(() => {
            if (url.endsWith("/feedback")) setTimeout(resolve);
          });
        };
      })
  );
  await panel(page).getByRole("button", { name: "Send" }).click();
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await expect(switcher).toBeVisible();
  release();
  await read;
  await page.keyboard.press("Escape");
  await expect(switcher).toBeHidden();

  await foot(page).click();
  await expect(panel(page).getByText("Patchy couldn’t confirm that")).toBeVisible();
  await expect(panel(page).getByText(/^Request sent:/)).toHaveCount(0);
  await expect(field(page)).toHaveValue("Postgres connection encrypted with RSA");
});

test("a switcher opened from outside the open panel leaves the next switcher's focus alone", async ({
  page,
  instance
}) => {
  const switcher = page.getByRole("dialog", { name: "Go to" });
  const search = page.locator("#app-search");
  await page.goto(`${instance.origin}/`);
  await foot(page).click();
  await expect(field(page)).toBeFocused();
  await search.focus();
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await expect(switcher).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(switcher).toBeHidden();
  await expect(search).toBeFocused();

  // Later, from nothing focused, the switcher has nothing of the panel's to give back.
  await search.blur();
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await expect(switcher).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(switcher).toBeHidden();
  await expect(page.locator("body")).toBeFocused();
});

test("Ask for an integration picks Request after Feedback was chosen: in place with script, at the composer's address without", async ({
  browser,
  page,
  instance
}) => {
  const ask = (on: Page) => on.getByRole("link", { name: "Ask for an integration" });
  await page.goto(`${instance.origin}/settings/integrations/connect`);
  await foot(page).click();
  await panel(page).getByRole("radio", { name: "Feedback" }).check();
  await page.keyboard.press("Escape");
  await ask(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/integrations\/connect$/);
  await expect(panel(page).getByRole("radio", { name: "Request" })).toBeChecked();
  await expect(field(page)).toBeFocused();

  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await prepare(context, instance);
    const quiet = await context.newPage();
    await quiet.goto(`${instance.origin}/settings/integrations/connect`);
    await foot(quiet).click();
    await panel(quiet).getByRole("radio", { name: "Feedback" }).check();
    await quiet.keyboard.press("Escape");
    await ask(quiet).click();
    await expect(quiet).toHaveURL(/\/feedback\/new\?kind=request$/);
    await expect(
      quiet.locator("#tell-patchy-new").getByRole("radio", { name: "Request" })
    ).toBeChecked();
  } finally {
    await context.close();
  }
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tap outside the panel gives focus back to Tell Patchy, and Done to Menu, which it closes", async ({
    page,
    instance
  }) => {
    await page.goto(`${instance.origin}/`);
    const menu = page.getByRole("button", { name: "Menu" });
    await menu.tap();
    await foot(page).tap();
    const box = (await panel(page).boundingBox())!;
    // The gap above the panel, inside Menu: the tap moves focus for itself after the panel closed.
    await page.touchscreen.tap(200, box.y - 12);
    await expect(panel(page)).toBeHidden();
    await expect(foot(page)).toBeFocused();

    await foot(page).tap();
    await page.getByRole("radio", { name: "Feedback" }).check();
    await field(page).fill("Sent from a phone");
    await panel(page).getByRole("button", { name: "Send" }).tap();
    await panel(page).getByRole("button", { name: "Done" }).tap();
    await expect(panel(page)).toBeHidden();
    await expect(menu).toBeFocused();
  });
});
