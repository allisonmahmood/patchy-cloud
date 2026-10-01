import { test as base, expect } from "@playwright/test";
import type { BrowserContext, Frame, Page } from "@playwright/test";
import { startInstance } from "./instance.js";
import type { Instance, Published } from "./instance.js";
import type { FixtureWindow } from "./fixture-client.js";

export const test = base.extend<{ instance: Instance }, { tls: boolean }>({
  tls: [false, { option: true, scope: "worker" }],
  instance: [
    async ({ tls }, use) => {
      const instance = await startInstance({ tls });
      try {
        await use(instance);
      } finally {
        await instance.close();
      }
    },
    { timeout: 120_000 }
  ]
});
/** Every context stays offline, even with developer credentials in the invoking shell. */
export async function prepare(context: BrowserContext, instance: Instance) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
    else await route.abort("blockedbyclient");
  });
  await instance.session(context);
}
/** Replace only Clerk's SDK boundary. The served session script and signed-cookie verification stay real. */
export async function installSessionRefreshBoundary(
  context: BrowserContext,
  refresh: (options: { skipCache: boolean }) => Promise<string | null>
) {
  await context.exposeFunction("__tier1RefreshSession", refresh);
  await context.addInitScript(() => {
    const host = window as unknown as {
      __tier1RefreshSession(options: { skipCache: boolean }): Promise<string | null>;
      Clerk: {
        load(): Promise<void>;
        session: { getToken(options: { skipCache: boolean }): Promise<string | null> };
      };
    };
    host.Clerk = {
      load: () => Promise.resolve(),
      session: { getToken: (options) => host.__tier1RefreshSession(options) }
    };
  });
}
test.beforeEach(({ context, instance }) => prepare(context, instance));
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
export async function notice(page: Page, code: string) {
  await expect(page).toHaveURL(new RegExp(`/~shell/notice/${code}\\?`));
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator("h1")).toBeVisible();
}
export { expect };
