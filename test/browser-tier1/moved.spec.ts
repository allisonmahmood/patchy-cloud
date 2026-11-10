import { test, expect } from "./fixtures.js";

// Released skills and CLIs link to Your agents' old address with a fragment. A browser keeps the
// fragment across the redirect, so the new pages keep the ids those links name.
test("an old Your agents link lands on the part of the page it names", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/machines#add-a-computer`);
  await expect(page).toHaveURL(`${instance.origin}/agents#add-a-computer`);
  await expect(page.locator(":target")).toHaveAttribute("href", "/agents/computer");
  await page.locator(":target").click();
  await expect(page).toHaveURL(`${instance.origin}/agents/computer`);
  await expect(page.getByRole("heading", { name: "Add a computer" })).toBeVisible();

  await page.goto(`${instance.origin}/machines?agent=codex#connect-an-agent`);
  await expect(page).toHaveURL(`${instance.origin}/agents/connect?app=codex#connect-an-agent`);
  await expect(page.getByRole("heading", { name: "Connect an app" })).toBeVisible();
  await expect(page.locator(":target")).toHaveAttribute("id", "connect-an-agent");
});
