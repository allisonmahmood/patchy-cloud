import { test, expect } from "./fixtures.js";
import { loadDialog } from "./dialog.js";

// The `/~ui` gallery exists only where dev personas sign people in, as in development.
test.use({ serverEnvironment: { PATCHY_DEV_PERSONAS_SECRET: "ui-gallery" } });

test("the keyboard opens and closes menus and dialogs, and focus comes back", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/~ui`);
  const more = page.getByRole("button", { name: "Actions for Kudos" });
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = page.locator("#menu-g-kudos");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Delete…, Kudos" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  // Reached from its page, a dialog starts on its field and goes back on Escape, and focus
  // returns to the very link that opened it, not another link to the same dialog.
  const openers = page.locator('a[href="/~ui/dialog"]');
  await expect(openers).toHaveCount(2);
  await loadDialog(page, () => openers.nth(1).click());
  await expect(page).toHaveURL(/\/~ui\/dialog$/);
  const dialog = page.getByRole("dialog", { name: "Invite people" });
  await expect(dialog.getByRole("textbox", { name: "Emails" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/~ui$/);
  await expect(openers.nth(1)).toBeFocused();

  // From another page, Back returns there rather than to the dialog's own page.
  await page.goto(`${instance.origin}/~ui/index`);
  await loadDialog(page, () =>
    page.getByRole("main").getByRole("link", { name: "New patch" }).click()
  );
  await expect(page).toHaveURL(/\/~ui\/dialog$/);
  await dialog.getByRole("link", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/~ui\/index$/);
  await expect(page.getByRole("main").getByRole("link", { name: "New patch" })).toBeFocused();

  // Loaded directly, even with a malformed fragment, it closes to its own page.
  await page.goto(`${instance.origin}/~ui/dialog#%`);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/~ui$/);

  // A dialog only its own actions close ignores Escape.
  await page.goto(`${instance.origin}/~ui/final`);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/~ui\/final$/);
});

test("a refused submission draws the dialog again, and closing it skips the submission", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/~ui`);
  await page.goto(`${instance.origin}/~ui/index?page=2`);
  await loadDialog(page, () =>
    page.getByRole("main").getByRole("link", { name: "New patch" }).click()
  );
  await expect(page).toHaveURL(/\/~ui\/dialog$/);
  await loadDialog(page, () => page.getByRole("button", { name: "Send invites" }).click());
  const emails = page
    .getByRole("dialog", { name: "Invite people" })
    .getByRole("textbox", { name: "Emails" });
  await expect(emails).toHaveAttribute("aria-invalid", "true");
  await expect(emails).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/~ui\/index\?page=2$/);
  await expect(page.getByRole("main").getByRole("link", { name: "New patch" })).toBeFocused();
  // Back from the page goes to where it was reached from, never to the refused submission.
  await page.goBack();
  await expect(page).toHaveURL(/\/~ui$/);
});

test("in a history at its longest, closing a dialog drawn again still reaches its opener", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/~ui/index?page=2`);
  // A browser keeps 50 entries: past that a new one drops the oldest, and the count stays.
  await page.evaluate(() => {
    for (let entry = 0; entry < 60; entry++) history.pushState(null, "");
  });
  const length = await page.evaluate(() => history.length);
  const opener = page.getByRole("main").getByRole("link", { name: "New patch" });
  await loadDialog(page, () => opener.click());
  const dialog = page.getByRole("dialog", { name: "Invite people" });
  for (let refusal = 0; refusal < 2; refusal++) {
    await loadDialog(page, () => page.getByRole("button", { name: "Send invites" }).click());
    await expect(dialog.getByRole("textbox", { name: "Emails" })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
  }
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/~ui\/index\?page=2$/);
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("Back from a refused submission closes the dialog to the page that opened it", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/~ui`);
  await page.goto(`${instance.origin}/~ui/index?page=2`);
  const opener = page.getByRole("main").getByRole("link", { name: "New patch" });
  const dialog = page.getByRole("dialog", { name: "Invite people" });
  for (const refusals of [1, 2]) {
    await loadDialog(page, () => opener.click());
    await expect(page).toHaveURL(/\/~ui\/dialog$/);
    for (let refusal = 0; refusal < refusals; refusal++) {
      const refused = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.status() === 422
      );
      await loadDialog(page, () => page.getByRole("button", { name: "Send invites" }).click());
      await refused;
      await expect(dialog.getByRole("textbox", { name: "Emails" })).toHaveAttribute(
        "aria-invalid",
        "true"
      );
    }
    // One step back passes the dialog's earlier entries, to its opener, focused, page usable.
    await page.goBack({ waitUntil: "commit" });
    await expect(page).toHaveURL(/\/~ui\/index\?page=2$/);
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.locator(".app[inert]")).toHaveCount(0);
  }
  // Back from there goes to where it was reached from.
  await page.goBack();
  await expect(page).toHaveURL(/\/~ui$/);
});

test("with script, Show reveals a secret, Copy appears and a fragment opens its disclosure", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/~ui/flow`);
  const token = page.getByLabel("Access token");
  await token.fill("sk-sample");
  await expect(token).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(token).toHaveAttribute("type", "text");
  await expect(page.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-pressed", "true");
  // A section still to come neither takes focus nor submits.
  await expect(page.getByRole("radio", { name: "Acme Co" })).toBeDisabled();

  await page.goto(`${instance.origin}/~ui#g-disclosure-answer`);
  await expect(page.locator("#g-disclosure-answer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy the command" })).toBeVisible();
});

test("a name's hint follows what is typed, and a pressed submit says Testing… and takes no second", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/~ui/flow`);
  const hint = page.locator("#g-f-name-hint");
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(hint).toHaveText("Patches use it as attio/crm.");
  await name.fill("sales");
  await expect(hint).toHaveText("Patches use it as attio/sales.");
  await name.fill("  ");
  await expect(hint).toHaveText("Patches use it as attio/crm.");

  // Hold the submission, as Patchy would while it tests. The presses happen in the page, where
  // a submit and the enhancer's answer to it run at once, before the navigation can start.
  const posts: Array<string> = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${instance.origin}/~ui/flow`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postData() ?? "");
    await held;
    await route.fulfill({ status: 303, headers: { location: "/~ui/flow" } });
  });
  const pressed = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>("button[data-pending]")!;
    const sent: Array<boolean> = [];
    document.addEventListener("submit", (event) => sent.push(!event.defaultPrevented));
    const width = button.getBoundingClientRect().width;
    button.click();
    const look = {
      label: button.textContent,
      disabled: button.getAttribute("aria-disabled"),
      sameWidth: button.getBoundingClientRect().width === width
    };
    // Pressing again, or submitting the form another way, is turned away.
    button.click();
    button.form!.requestSubmit();
    return { ...look, sent };
  });
  expect(pressed).toEqual({
    label: "Testing…",
    disabled: "true",
    sameWidth: true,
    sent: [true, false, false]
  });
  await expect.poll(() => posts.length).toBe(1);

  // Once the page answers, the next page's button is at rest.
  release();
  await expect(page.getByRole("button", { name: "Test and connect" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test and connect" })).not.toHaveAttribute(
    "aria-disabled"
  );
  expect(posts).toHaveLength(1);
});

test("a short label holds room for its pending one, so pressing it moves nothing", async ({
  page,
  instance
}) => {
  // No content: the page stays as it is, its button still pending.
  await page.route(`${instance.origin}/~ui/flow`, (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 204 }) : route.fallback()
  );
  await page.goto(`${instance.origin}/~ui`);
  const test = page.locator("form button[data-pending]");
  await expect(test).toHaveAccessibleName("Test");
  const pressed = await test.evaluate((button: HTMLButtonElement) => {
    const before = button.getBoundingClientRect();
    button.click();
    const after = button.getBoundingClientRect();
    return {
      label: button.textContent,
      same: before.width === after.width && before.height === after.height
    };
  });
  expect(pressed).toEqual({ label: "Testing…", same: true });
});

test("without script, a dialog is the page, its close is a link, and secrets stay masked", async ({
  browser,
  instance
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto(`${instance.origin}/~ui/dialog`);
    const dialog = page.getByRole("dialog", { name: "Invite people" });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => getComputedStyle(element).position)).toBe("static");
    await expect(page.locator(".app")).toBeHidden();
    await dialog.getByRole("link", { name: "Close" }).click();
    await expect(page).toHaveURL(/\/~ui$/);
    await page.goto(`${instance.origin}/~ui/flow`);
    await expect(page.getByRole("button", { name: "Show" })).toBeHidden();
    // The name's hint shows the example, as it was drawn.
    await page.getByRole("textbox", { name: "Name" }).fill("sales");
    await expect(page.locator("#g-f-name-hint")).toHaveText("Patches use it as attio/crm.");
  } finally {
    await context.close();
  }
});

test("on a touch screen controls are 44px, field text is 16px, and long labels wrap at 320px", async ({
  browser,
  instance
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 800 },
    hasTouch: true,
    isMobile: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${instance.origin}/~ui`);
    const sizes = await page.evaluate(() => ({
      button: document.querySelector(".btn:not(.btn-icon)")!.getBoundingClientRect().height,
      icon: document.querySelector(".btn-icon")!.getBoundingClientRect().height,
      tab: document.querySelector(".tab")!.getBoundingClientRect().height,
      field: getComputedStyle(document.querySelector("input.field")!).fontSize,
      width: document.documentElement.scrollWidth
    }));
    expect(sizes).toEqual({ button: 44, icon: 44, tab: 44, field: "16px", width: 320 });

    // A confirmation names a person or a patch; a patch's name may be 32 letters with no space.
    await page.evaluate(() => {
      const group = document.querySelector(".btn-group")!;
      group.innerHTML = `<button class="btn btn-primary" type="button">Deactivate Allison Mahmood and retire selected</button><button class="btn btn-danger" type="button">Delete ${"w".repeat(32)}</button>`;
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  } finally {
    await context.close();
  }
});

test("on a phone, a dialog breaks a long unbroken name and keeps Close on screen", async ({
  browser,
  instance
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  });
  try {
    const page = await context.newPage();
    await page.goto(`${instance.origin}/~ui/dialog`);
    // A computer's name may be 64 characters with no space, in the title and in what it says.
    const dialog = page.locator("#g-dialog");
    await dialog.evaluate((element, name) => {
      element.querySelector("h2")!.textContent = `Disconnect ${name}?`;
      element
        .querySelector(".dialog-body")!
        .insertAdjacentHTML("afterbegin", `<p class="prose">${name} stops publishing as you.</p>`);
    }, "w".repeat(64));
    const close = await dialog.getByRole("link", { name: "Close" }).boundingBox();
    expect(close!.x + close!.width).toBeLessThanOrEqual(390);
    // Nothing scrolls sideways, in the dialog or the page.
    expect(
      await dialog.evaluate((element) => ({
        fits: element.scrollWidth <= element.clientWidth,
        page: document.documentElement.scrollWidth
      }))
    ).toEqual({ fits: true, page: 390 });
  } finally {
    await context.close();
  }
});

test("in forced colours, a logo keeps its white square, so a dark theme can't hide it", async ({
  page,
  instance
}) => {
  await page.goto(`${instance.origin}/~ui`);
  const logo = page.locator(".im-logo").first();
  const letters = page.locator(".im:not(.im-logo)").first();
  const surface = await logo.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
  // Letters take the theme's colours, which shows forced colours are on.
  await expect(letters).not.toHaveCSS("background-color", surface);
  await expect(logo).toHaveCSS("background-color", surface);
});
