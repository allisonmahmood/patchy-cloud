import { test, expect } from "./fixtures.js";

test("an owner shares a page from its menu, and the guest opens it from Home and removes it", async ({
  page,
  context,
  instance
}) => {
  const patch = await instance.publish();
  const title = "Tier one acceptance";

  await page.goto(`${instance.origin}/patches`);
  await page.getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("link", { name: `Share…, ${title}` }).click();
  const dialog = page.getByRole("dialog", { name: `Share ${title}` });
  const email = dialog.getByLabel("Add guests");
  await expect(email).toBeFocused();
  await email.fill("guest@pine.example");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page).toHaveURL(`${instance.origin}/patches?share=${patch.name}`);
  await expect(dialog.getByRole("status")).toHaveText(`Shared ${title} with Jo Rivera`);
  await expect(dialog.getByRole("list", { name: "Guests" })).toContainText(
    "guest@pine.example · Pine Studio"
  );
  await dialog.getByRole("link", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Someone new to Patchy meets the Final step first.
  await instance.session(context, "guest");
  await page.goto(`${instance.origin}/`);
  await page.getByRole("button", { name: "Later" }).click();
  const shelf = page.getByRole("region", { name: "Shared with you" });
  await shelf.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(patch.address);
  await expect(page.frameLocator("#patch").getByRole("heading", { name: title })).toBeVisible();

  await page.goto(`${instance.origin}/`);
  await shelf.getByRole("button", { name: `Actions for ${title}` }).click();
  await shelf.getByRole("link", { name: `Remove…, ${title}` }).click();
  await expect(page.getByRole("heading", { name: `Remove ${title}?` })).toBeVisible();
  await page.getByRole("button", { name: `Remove ${title}` }).click();
  await expect(page.getByRole("status")).toHaveText(`Removed ${title}`);
  await expect(shelf).toHaveCount(0);
  expect((await page.goto(patch.address))?.status()).toBe(404);
});
