import { test, expect, prepare } from "./fixtures.js";
import { loadDialog } from "./dialog.js";

// A patch's page: Retire and Delete ask in dialogs at their own URLs, over Settings.
const tier1 = { tier: 1, tables: {}, files: {} } as const;
const page = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

test("Delete and Retire ask in a dialog over Settings, and Restore sits in the header", async ({
  page: browser,
  instance
}) => {
  const patch = await instance.publish("company", page("Desk map"), undefined, tier1);
  const card = `${instance.origin}/patches/${patch.name}`;
  await browser.goto(`${card}/settings`);
  await expect(browser.getByRole("heading", { level: 1 })).toHaveText("Desk map");

  // Delete opens on its typed name; a wrong name is refused in the dialog, which closes past it.
  await loadDialog(browser, () => browser.getByRole("link", { name: "Delete…" }).click());
  await expect(browser).toHaveURL(`${card}/delete`);
  const remove = browser.getByRole("dialog", { name: "Delete Desk map" });
  const typed = remove.getByRole("textbox", { name: `Type ${patch.name} to confirm` });
  await expect(typed).toBeFocused();
  await typed.fill("not-it");
  await loadDialog(browser, () => remove.getByRole("button", { name: "Delete Desk map" }).click());
  await expect(remove.getByText(`Type ${patch.name} to confirm. Nothing was done.`)).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(browser).toHaveURL(`${card}/settings`);
  await expect(browser.getByRole("link", { name: "Delete…" })).toBeFocused();

  // Retire asks "are you sure", starting on Cancel, and lands on Overview with Restore.
  await browser.getByRole("link", { name: "Retire…" }).click();
  const retire = browser.getByRole("dialog", { name: "Retire Desk map?" });
  await expect(retire.getByRole("link", { name: "Cancel" })).toBeFocused();
  await retire.getByRole("button", { name: "Retire Desk map" }).click();
  await expect(browser).toHaveURL(card);
  await expect(browser.getByRole("status").filter({ hasText: "Retired Desk map" })).toBeVisible();
  await expect(browser.locator(".ph-status")).toContainText(
    "Nobody can open it until it’s restored."
  );
  await browser.getByRole("button", { name: "Restore" }).click();
  await expect(browser.getByRole("link", { name: "Open", exact: true })).toBeVisible();
  await expect(browser.locator(".ph-status")).toHaveCount(0);
});

test("Reassign starts on its owner and keeps its refusal there, and a stale act's refusal takes focus", async ({
  page: browser,
  instance
}) => {
  const patch = await instance.publish("company", page("Desk map"), undefined, tier1);
  const card = `${instance.origin}/patches/${patch.name}`;
  await browser.goto(`${card}/settings`);

  // A choice, not a destructive act: the dialog starts on the field, and a refused owner stays on it.
  await loadDialog(browser, () => browser.getByRole("link", { name: "Reassign…" }).click());
  const reassign = browser.getByRole("dialog", { name: "Reassign Desk map" });
  const owner = reassign.getByRole("combobox", { name: "New owner" });
  await expect(owner).toBeFocused();
  await loadDialog(browser, () =>
    reassign.getByRole("button", { name: "Reassign Desk map" }).click()
  );
  await expect(owner).toBeFocused();
  await expect(owner).toHaveAttribute("aria-invalid", "true");
  await expect(reassign.getByText("Choose an active member of this company.")).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(browser).toHaveURL(`${card}/settings`);

  // Retired from another tab meanwhile, this tab's Retire is refused, and the refusal has focus.
  await browser.goto(`${card}/retire`);
  const other = await browser.context().newPage();
  await other.goto(`${card}/retire`);
  await other.getByRole("button", { name: "Retire Desk map" }).click();
  await expect(other).toHaveURL(card);
  await browser.getByRole("button", { name: "Retire Desk map" }).click();
  await expect(browser.locator(".refusal")).toBeFocused();
  await expect(browser.locator(".refusal")).toContainText(
    "This patch changed while you had this page open"
  );
});

test("on a phone a deactivated owner's status line wraps inside the header, also under Reassign", async ({
  browser,
  instance
}) => {
  const patch = await instance.publish("company", page("Desk map"), undefined, tier1);
  // Its owner deactivated, it is the colleague, made an admin, who sees the status line.
  await instance.platform.query("UPDATE users SET role='admin' WHERE id='usr_colleague'");
  await instance.platform.query("UPDATE users SET deactivated_at=now() WHERE id='usr_dev'");
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  });
  try {
    await prepare(context, instance);
    await instance.session(context, "colleague");
    const phone = await context.newPage();
    for (const path of ["", "/reassign"]) {
      await phone.goto(`${instance.origin}/patches/${patch.name}${path}`);
      await expect(phone.locator(".ph-status")).toContainText(
        "Nobody can publish to this patch. Its owner is deactivated."
      );
      expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    }
  } finally {
    await context.close();
  }
});
