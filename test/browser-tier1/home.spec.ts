import { test, expect, prepare } from "./fixtures.js";

test("on a phone without script the Final step offers only what works, and Later puts it off", async ({
  browser,
  instance
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    javaScriptEnabled: false
  });
  try {
    await prepare(context, instance);
    await instance.session(context, "guest");
    const page = await context.newPage();
    await page.goto(`${instance.origin}/`);
    const step = page.getByRole("dialog", { name: "Final step" });
    await expect(step.getByText("so this step happens there")).toBeVisible();
    // Send and Copy need script, so without it neither is offered.
    await expect(step.getByRole("button", { name: "Send this to my computer" })).toHaveCount(0);
    await expect(step.getByRole("button", { name: "Copy" })).toHaveCount(0);
    await step.getByRole("button", { name: "Look around Pine Studio first" }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Connect your agent to build patches")).toBeVisible();
  } finally {
    await context.close();
  }
});
