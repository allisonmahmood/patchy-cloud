import { test as base, expect } from "@playwright/test";
import type { Frame, Page } from "@playwright/test";
import { startInstance } from "./instance.js";
import type { Instance, Published } from "./instance.js";
import type { FixtureWindow } from "./fixture-client.js";

export const test = base.extend<object, { instance: Instance }>({
  instance: [
    // Playwright requires destructuring even when a fixture has no dependencies.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const instance = await startInstance();
      try {
        await use(instance);
      } finally {
        await instance.close();
      }
    },
    { scope: "worker", timeout: 120_000 }
  ]
});
test.beforeEach(async ({ context, instance }) => {
  // Offline even with real developer credentials in the invoking shell. Clerk JS is not faked.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
    else await route.abort("blockedbyclient");
  });
  await instance.session(context);
});
export async function open(page: Page, patch: Published, suffix = ""): Promise<Frame> {
  expect((await page.goto(patch.address + suffix))?.status()).toBe(200);
  await expect(page.frameLocator("#patch").locator("#identity")).not.toHaveText("waiting");
  const frame = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame() && candidate.url().includes("/~content/"));
  if (!frame) throw new Error("Tier one content frame was not loaded");
  expect(await frame.evaluate(() => (window as unknown as FixtureWindow).harness.ready)).toBe(true);
  return frame;
}
export async function call(frame: Frame, op: string, args: unknown = {}) {
  return frame.evaluate(
    ({ op, args }) => (window as unknown as FixtureWindow).harness.call(op, args),
    { op, args }
  );
}
export async function fire(frame: Frame, op: string, args: unknown = {}) {
  await frame.evaluate(
    ({ op, args }) => {
      void (window as unknown as FixtureWindow).harness.call(op, args).catch(() => {});
    },
    { op, args }
  );
}
export async function notice(page: Page, code: string) {
  await expect(page).toHaveURL(new RegExp(`/~shell/notice/${code}\\?`));
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("h1")).toBeVisible();
}
export { expect };
