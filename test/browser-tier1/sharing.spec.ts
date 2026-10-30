import { test, expect } from "./fixtures.js";

test("owner shares a patch, guest opens it and removes the share from Home", async ({
  page,
  context,
  instance
}, testInfo) => {
  const patch = await instance.publish();
  await page.goto(`${instance.origin}/patches/${patch.name}/settings`);
  await expect(page.getByRole("heading", { name: "Who can open it" })).toBeVisible();
  await page.getByLabel("Add by email").fill("guest@patchy.local");
  await page.getByRole("button", { name: "Share patch" }).click();
  await expect(page.getByText("guest@patchy.local")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy patch link" })).toBeVisible();
  await testInfo.attach("patch-sharing", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });

  await instance.session(context, "guest");
  await page.goto(`${instance.origin}/`);
  const later = page.getByRole("button", { name: "Later" });
  if (await later.isVisible()) await later.click();
  await expect(page.getByRole("heading", { name: "Shared with you" })).toBeVisible();
  await testInfo.attach("shared-with-you", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
  await page.getByRole("link", { name: "Open", exact: true }).click();
  await expect(page.locator("#patch")).toBeVisible();
  await page.goto(`${instance.origin}/`);
  await page.getByRole("button", { name: /Remove .* from Shared with you/ }).click();
  await expect(page.getByRole("heading", { name: "Shared with you" })).toHaveCount(0);
  expect((await page.goto(patch.address))?.status()).toBe(404);
});
