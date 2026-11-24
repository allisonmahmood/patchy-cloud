import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { test, expect, prepare } from "./fixtures.js";

const html = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

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

test("on a phone Pages follows Tools, and a row's +N more opens its own address, not the row's page", async ({
  browser,
  instance
}) => {
  const server = await build({
    stdin: {
      contents: 'import { createGuest } from "patchy/server"; export default createGuest({});',
      resolveDir: fileURLToPath(new URL("../../packages/patchy", import.meta.url))
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm"
  });
  await instance.publish(
    "company",
    html("Desk booker"),
    undefined,
    { tier: 2, tables: {}, files: {}, uses: {}, handlers: {} },
    { server: server.outputFiles[0]!.text }
  );
  for (const title of ["Lunch poll", "Kickoff brief"])
    await instance.publish("company", html(title), undefined, { tier: 1, tables: {}, files: {} });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  });
  try {
    await prepare(context, instance);
    const page = await context.newPage();
    await page.goto(`${instance.origin}/`);
    const tools = await page.getByRole("region", { name: "Tools" }).boundingBox();
    const pages = page.getByRole("region", { name: "Pages" });
    expect((await pages.boundingBox())!.y).toBeGreaterThanOrEqual(tools!.y + tools!.height);
    // The newest page's row ends in "+1 more", over the row's stretched link: a tap that the
    // row's link took instead would open Kickoff brief.
    const more = pages.getByRole("link", { name: "1 more of your pages" });
    const href = await more.getAttribute("href");
    expect(href).toBe("/patches?show=pages&owner=usr_dev");
    await more.tap();
    await expect(page).toHaveURL(`${instance.origin}${href}`);
  } finally {
    await context.close();
  }
});
