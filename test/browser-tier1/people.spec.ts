import { test, expect, prepare } from "./fixtures.js";

test("an admin invites in a dialog over People, takes someone through deactivation and back, and switches agent access", async ({
  page,
  context,
  instance
}) => {
  const people = `${instance.origin}/settings/people`;
  await page.goto(people);
  const invite = page.getByRole("link", { name: "Invite people…" });
  await invite.click();
  await expect(page).toHaveURL(`${people}?invite=1`);
  const dialog = page.getByRole("dialog", { name: "Invite people" });
  const emails = dialog.getByRole("textbox", { name: "Emails" });
  await expect(emails).toBeFocused();
  // A refusal draws the dialog again with what was typed, the problem under the field.
  await emails.fill("not-an-address");
  await dialog.getByRole("button", { name: "Send invites" }).click();
  await expect(emails).toHaveAttribute("aria-invalid", "true");
  await expect(emails).toHaveValue("not-an-address");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(people);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Colleague owns no patch, so their flow goes straight to its confirmation.
  await page.getByRole("button", { name: "Actions for Colleague" }).click();
  await page.getByRole("link", { name: "Deactivate…, Colleague" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Deactivate Colleague?");
  await page.getByRole("button", { name: "Deactivate Colleague" }).click();
  await expect(page).toHaveURL(people);
  const show = page.getByRole("navigation", { name: "Show" });
  await show.getByRole("link", { name: /^Deactivated/ }).click();
  await expect(page.getByRole("table", { name: "People" })).toContainText("Colleague");
  await page.getByRole("button", { name: "Actions for Colleague" }).click();
  await page.getByRole("link", { name: "Reactivate…, Colleague" }).click();
  await page.getByRole("button", { name: "Reactivate Colleague" }).click();
  await expect(page).toHaveURL(people);
  await expect(show.getByRole("link", { name: /^Deactivated/ })).toHaveCount(0);

  // Agent access is one setting: its switch is a form that posts at once.
  await page.goto(`${instance.origin}/settings/agent-access`);
  const agents = page.getByRole("switch", { name: "Agents use patches" });
  const on = (await agents.getAttribute("aria-checked")) === "true";
  await agents.click();
  await expect(page.getByRole("status")).toHaveText(`Agent access is ${on ? "off" : "on"}`);
  await expect(agents).toHaveAttribute("aria-checked", String(!on));

  // A member reads the value and who can change it, with nothing to press.
  await instance.session(context, "colleague");
  await page.reload();
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("main")).toContainText(on ? "Off" : "On");
  await expect(page.getByRole("main")).toContainText("Only super admins can change this.");
});

test("without script, a deactivation's confirmation keeps its choice through a reload, Back and Forward", async ({
  browser,
  instance
}) => {
  const first = await instance.publish();
  const second = await instance.publish();
  // The colleague, made an admin, deactivates the owner of both.
  await instance.platform.query("UPDATE users SET role='super_admin' WHERE id='usr_colleague'");
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await prepare(context, instance);
    await instance.session(context, "colleague");
    const page = await context.newPage();
    const path = `${instance.origin}/settings/people/users/usr_dev/deactivate`;
    await page.goto(path);
    await page.getByText("Retire some", { exact: true }).click();
    await expect(page.getByRole("radio", { name: /^Retire some/ })).toBeChecked();
    await page.locator(`input[name="patch"][value="${second.patchId}"]`).check();
    await page.getByRole("button", { name: /^Deactivate / }).click();
    const confirmation = `${path}?choice=selected&patch=${second.patchId}`;
    await expect(page).toHaveURL(confirmation);
    const heading = page.getByRole("heading", { level: 1 });
    const retire = page.getByRole("button", { name: /and retire selected$/ });
    await expect(heading).toHaveText(/^Deactivate .+\?$/);
    await expect(retire).toBeVisible();
    await page.reload();
    await expect(heading).toHaveText(/^Deactivate .+\?$/);
    await page.goBack();
    await expect(page).toHaveURL(path);
    await page.goForward();
    await expect(page).toHaveURL(confirmation);
    await expect(retire).toBeVisible();

    await retire.click();
    await expect(page).toHaveURL(`${instance.origin}/settings/people`);
    // Only the chosen patch was retired.
    await page.goto(`${instance.origin}/patches?show=off`);
    const off = page.getByRole("table", { name: "Retired and deleted patches" });
    await expect(off.locator(`a.row-link[href="/patches/${second.name}"]`)).toHaveCount(1);
    await expect(off.locator(`a.row-link[href="/patches/${first.name}"]`)).toHaveCount(0);
  } finally {
    await context.close();
  }
});
