import { test, expect, prepare } from "./fixtures.js";

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
  const email = dialog.getByLabel("Invite a guest");
  await expect(email).toBeFocused();
  await email.fill("guest@pine.example");
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page).toHaveURL(`${instance.origin}/patches?share=${patch.name}`);
  await expect(dialog.getByRole("status")).toHaveText(`Shared ${title} with Jo Rivera`);
  await expect(dialog.getByText("guest@pine.example · Pine Studio")).toBeVisible();
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
  // The receipt, beside Home's Connect line for someone with no agent yet.
  await expect(page.getByRole("status").filter({ hasText: "Removed" })).toHaveText(
    `Removed ${title}`
  );
  await expect(shelf).toHaveCount(0);
  expect((await page.goto(patch.address))?.status()).toBe(404);
});

test("a row of All patches opens its patch from anywhere on it, while its Share and menu stay pressable", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const title = "Tier one acceptance";

  await page.goto(`${instance.origin}/patches`);
  const row = page.getByRole("row").filter({ hasText: title });
  await row.getByRole("link", { name: `Share ${title}` }).click();
  await expect(page.getByRole("dialog", { name: `Share ${title}` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(`${instance.origin}/patches`);

  await row.getByRole("button", { name: `Actions for ${title}` }).click();
  await expect(page.getByRole("link", { name: `Settings, ${title}` })).toBeVisible();
  await page.keyboard.press("Escape");
  // The row's link covers the cell, which is the point: a press there opens the patch.
  await row.getByRole("cell", { name: "Company", exact: true }).click({ force: true });
  await expect(page).toHaveURL(patch.address);
});

test("Share on a public page with a guest starts on General access, never on the guest's Remove", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  await instance.guest(patch.patchId, true);
  await instance.share(patch.patchId, "public");

  await page.goto(`${instance.origin}/patches?share=${patch.name}`);
  await expect(page.getByRole("combobox", { name: "General access" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Remove Jo Rivera" })).toBeVisible();
});

test("without script, Share is a page: Copy link waits for script, and going public asks at its own address", async ({
  browser,
  instance
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await prepare(context, instance);
    const patch = await instance.publish();
    const title = "Tier one acceptance";
    const page = await context.newPage();

    await page.goto(`${instance.origin}/patches?share=${patch.name}`);
    const dialog = page.getByRole("dialog", { name: `Share ${title}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy link" })).toBeHidden();
    await dialog.getByRole("combobox", { name: "General access" }).selectOption("public");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(`${instance.origin}/patches?share=${patch.name}&confirm=public`);
    await dialog.getByRole("button", { name: "Make public" }).click();
    await expect(page).toHaveURL(`${instance.origin}/patches?share=${patch.name}`);
    await expect(dialog.getByRole("status")).toHaveText(
      `${title} is open to anyone on the internet`
    );
  } finally {
    await context.close();
  }
});

for (const javaScriptEnabled of [true, false])
  test(`team choices follow General access with script ${javaScriptEnabled ? "on" : "off"}`, async ({
    browser,
    instance
  }) => {
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      await prepare(context, instance);
      const created = await context.request.post(
        `${instance.origin}/settings/company/teams/create`,
        {
          headers: { origin: instance.origin },
          form: { name: "Design" }
        }
      );
      expect(created.ok()).toBe(true);
      const patch = await instance.publish();
      const page = await context.newPage();
      await page.goto(`${instance.origin}/patches?share=${patch.name}`);
      const scope = page.getByLabel("General access");
      const team = page.getByRole("checkbox", { name: "Design", exact: true });
      await expect(team).toBeHidden();
      await scope.selectOption("teams");
      await expect(team).toBeVisible();
      await team.check();
      await scope.selectOption("company");
      await expect(team).toBeHidden();
      await scope.selectOption("public");
      await expect(team).toBeHidden();
      await scope.selectOption("teams");
      await expect(team).toBeChecked();
      await expect(team).toBeVisible();
    } finally {
      await context.close();
    }
  });
