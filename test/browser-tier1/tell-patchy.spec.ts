import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

// Tell Patchy's panel, in the sidebar's foot: what its script does with answers that arrive late
// and with focus when it closes. The routes themselves are the portal's own tests.

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
