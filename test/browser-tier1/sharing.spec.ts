import { DEV_SEED } from "@patchy/auth/seed";
import { test, expect, prepare } from "./fixtures.js";
import { loadDialog } from "./dialog.js";

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
  await dialog.getByRole("link", { name: "Close", exact: true }).last().click();
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

test("a row of All patches opens its patch from anywhere on it, while its menu actions stay pressable", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const title = "Tier one acceptance";

  await page.goto(`${instance.origin}/patches`);
  const row = page.getByRole("row").filter({ hasText: title });
  await row.getByRole("button", { name: `Actions for ${title}` }).click();
  await loadDialog(page, () => page.getByRole("link", { name: `Share…, ${title}` }).click());
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
  test(`an owner shares with teams and back with script ${javaScriptEnabled ? "on" : "off"}`, async ({
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
      const teamId = new URL(created.url()).searchParams.get("team")!;
      // Joining is a roster change: its review carries the revision its save is held to.
      const reviewed = await context.request.post(
        `${instance.origin}/settings/company/teams/stage?team=${teamId}`,
        { headers: { origin: instance.origin }, form: { add: DEV_SEED.userId, intent: "review" } }
      );
      const revision = /name="revision" value="(\d+)"/.exec(await reviewed.text())?.[1] ?? "";
      const joined = await context.request.post(
        `${instance.origin}/settings/company/teams/save?team=${teamId}`,
        { headers: { origin: instance.origin }, form: { add: DEV_SEED.userId, revision } }
      );
      expect(joined.ok()).toBe(true);
      const engineering = await context.request.post(
        `${instance.origin}/settings/company/teams/create`,
        {
          headers: { origin: instance.origin },
          form: { name: "Engineering" }
        }
      );
      expect(engineering.ok()).toBe(true);
      const patch = await instance.publish();
      const page = await context.newPage();
      await page.goto(`${instance.origin}/patches?share=${patch.name}`);
      const scope = page.getByLabel("General access");
      const team = page.getByRole("checkbox", { name: "Design", exact: true });
      const access = page.getByRole("group", { name: "Who has access" });
      const patchRow = page
        .getByRole("row", { includeHidden: true })
        .filter({ hasText: "Tier one acceptance" });
      await expect(access).toContainText("People at Patchy Dev");
      await scope.selectOption("teams");
      await team.check();
      // Unsaved controls never claim that access already changed.
      await expect(access).toContainText("People at Patchy Dev");
      const save = page.getByRole("button", { name: "Save", exact: true });
      await expect(save).toHaveAttribute("form", "share-access-form");
      await save.click();
      await expect(access).toContainText("Design");
      await expect(access).not.toContainText("People at Patchy Dev");
      await expect(patchRow).toContainText("Design");
      await page.reload();
      await expect(scope).toHaveValue("teams");
      await expect(team).toBeChecked();
      const engineeringChoice = page.getByRole("checkbox", { name: "Engineering", exact: true });
      await engineeringChoice.check();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(access).toContainText("Engineering");
      await expect(patchRow).toContainText("Design and Engineering");
      await engineeringChoice.uncheck();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(access).toContainText("Design");
      await expect(access).not.toContainText("Engineering");
      await scope.selectOption("company");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(access).toContainText("People at Patchy Dev");
      await expect(access).not.toContainText("Design");
    } finally {
      await context.close();
    }
  });
