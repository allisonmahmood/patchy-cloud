import { test, expect, prepare } from "./fixtures.js";

test("a headline in What's new opens its change, and its months mark what was new though opening them caught the viewer up", async ({
  page,
  instance
}) => {
  // The owner has never looked, so everything is new to them.
  await instance.session(page.context(), "owner");
  await page.goto(`${instance.origin}/`);
  await page
    .getByRole("button", { name: /^What’s new: \d+ changes? since your last visit$/ })
    .click();
  const headline = page.getByRole("dialog", { name: "What’s new" }).getByRole("link").first();
  const title = (await headline.locator("span").nth(1).textContent()) ?? "";
  await headline.click();

  await expect(page).toHaveURL(/\/whats-new\/\d{4}-\d{2}\?since=0#change-\d+-\d+$/);
  const change = page.locator("details", { has: page.locator("summary", { hasText: title }) });
  await expect(change).toHaveAttribute("open", "");
  await expect(change.getByRole("img", { name: "New to you" })).toBeVisible();
  const url = new URL(page.url());
  await expect(change.getByRole("link", { name: "Link to this change" })).toHaveAttribute(
    "href",
    `${url.pathname}${url.hash}`
  );

  // The month before still marks what was new, though the panel and this page raised the marker.
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/whats-new\/\d{4}-\d{2}\?since=0$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("What’s new");
  await expect(page.getByRole("img", { name: "New to you" }).first()).toBeVisible();

  await page.goto(`${instance.origin}/whats-new`);
  await expect(page.locator("details.change")).not.toHaveCount(0);
  await expect(page.locator("details[open]")).toHaveCount(0);
});

test("a permalink opens a change the reader has already seen, with or without script", async ({
  browser,
  instance
}) => {
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      await prepare(context, instance);
      const page = await context.newPage();
      // Opening the newest month catches the reader up, so nothing on it starts open.
      await page.goto(`${instance.origin}/whats-new`);
      await page.goto(`${instance.origin}/whats-new`);
      await expect(page.locator("details[open]")).toHaveCount(0);
      // A closed change's link is hidden, so it is read by its place rather than its role.
      const link = page.locator(".change-body[id] a").nth(1);
      const permalink = (await link.getAttribute("href")) ?? "";
      expect(permalink).toMatch(/^\/whats-new\/\d{4}-\d{2}#change-\d+-\d+$/);

      await page.goto(`${instance.origin}${permalink}`);
      const id = permalink.split("#")[1] ?? "";
      const change = page.locator("details", { has: page.locator(`[id="${id}"]`) });
      await expect(change).toHaveAttribute("open", "");
      await expect(change.getByRole("link", { name: "Link to this change" })).toBeVisible();
      await expect(page.locator("details[open]")).toHaveCount(1);
    } finally {
      await context.close();
    }
  }
});
