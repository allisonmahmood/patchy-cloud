import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { objectKey, type Entry } from "../../packages/portal/src/updates.js";
import { test, expect } from "./fixtures.js";
import type { Instance } from "./instance.js";

// Exercise the real authenticated pages, external script and content-store reader.
// Only publication is simulated: production publication is not built yet.
const entry = (sequence: number): Entry => ({
  sequence,
  publishedAt: "2026-10-05T12:00:00.000Z",
  title: `Deployment ${sequence}`,
  summary: `Summary ${sequence}`,
  changes: [{ kind: "Improved", title: `Change ${sequence}`, detail: `Details ${sequence}` }]
});
async function publish(instance: Instance, sequences: number[]) {
  const file = join(instance.storageDirectory, objectKey);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify({ version: 1, entries: sequences.map(entry) }));
  await rename(file + ".tmp", file);
}
const marker = (page: Page) =>
  page.evaluate(() =>
    localStorage.getItem(
      "patchy:updates:read-through:" + document.getElementById("updates-bell")!.dataset.viewerId
    )
  );
async function openBell(page: Page) {
  await page.locator("#updates-bell").click();
  await expect(page.locator("#updates-popover")).toBeVisible();
}
async function capture(page: Page, name: string) {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}
async function unread(page: Page, sequence: number) {
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — new deployment"
  );
  await expect(page.locator("#updates-dot")).not.toHaveAttribute("hidden");
  await expect(page.locator("#updates-popover-content .latest-update")).toHaveCount(1);
  await expect(page.locator("#updates-popover-content h3")).toHaveText(`Deployment ${sequence}`);
}
async function caughtUp(page: Page) {
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — all caught up"
  );
  await expect(page.locator("#updates-dot")).toHaveAttribute("hidden");
  await expect(page.locator("#updates-popover-content h3")).toHaveText("All caught up");
  await expect(page.locator("#updates-popover-content .latest-update")).toHaveCount(0);
}
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) expect(await page.pageErrors()).toEqual([]);
});

test("the bell shows only the newest unread deployment; reading history survives closing the tab", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 3, 2]);
  await page.goto(instance.origin);
  await unread(page, 3);
  await openBell(page);
  await expect(page.locator("#updates-popover")).not.toContainText("Deployment 2");
  expect(await marker(page)).toBeNull();
  await capture(page, "unread-bell");

  await page.close();
  const returned = await context.newPage();
  await returned.goto(instance.origin);
  await unread(returned, 3);
  await openBell(returned);
  await returned.getByRole("link", { name: "View all updates" }).click();
  await expect(returned.locator(".update-title")).toHaveText([
    "Deployment 3",
    "Deployment 2",
    "Deployment 1"
  ]);
  await returned.locator("#update-2 summary").click();
  await expect(returned.getByText("Details 2", { exact: true })).toBeVisible();
  await caughtUp(returned);
  expect(await marker(returned)).toBe("3");
  await returned.close();

  const reopened = await context.newPage();
  await reopened.goto(instance.origin);
  await caughtUp(reopened);
  await openBell(reopened);
  await expect(reopened.getByRole("link", { name: "View all updates" })).toBeVisible();
  await capture(reopened, "caught-up-bell");
});

test("returning to an older history snapshot leaves a newer deployment unread until its link loads it", async ({
  page,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin + "/updates");
  await caughtUp(page);
  await publish(instance, [1, 2, 3, 4]);
  // Deliver the tab-return event without depending on headless window-manager focus.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await unread(page, 4);
  expect(await marker(page)).toBe("3");
  await expect(page.locator("#update-4")).toHaveCount(0);
  await expect(page.locator("[data-updates-through]")).toHaveAttribute("data-updates-through", "3");
  await openBell(page);
  await capture(page, "new-deployment-on-old-history");
  await page.locator(".latest-update").click();
  await expect(page).toHaveURL(instance.origin + "/updates?release=4#update-4");
  await expect(page.locator("#update-4")).toHaveAttribute("open");
  await expect(page.getByText("Details 4", { exact: true })).toBeVisible();
  await caughtUp(page);
  expect(await marker(page)).toBe("4");
});

test("reading in another tab clears the bell and an older tab cannot move the marker backwards", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin);
  await unread(page, 3);
  const history = await context.newPage();
  await history.goto(instance.origin + "/updates");
  await caughtUp(history);
  await caughtUp(page); // The real browser storage event updates this untouched tab.

  await publish(instance, [1, 2, 3, 4]);
  const newer = await context.newPage();
  await newer.goto(instance.origin + "/updates");
  await caughtUp(newer);
  await expect.poll(() => marker(history)).toBe("4");
  await history.evaluate(() => window.dispatchEvent(new Event("focus")));
  await caughtUp(history);
  expect(await marker(history)).toBe("4");
  await expect(history.locator("#update-4")).toHaveCount(0);
});

test("hidden history is not read; becoming visible marks only its rendered snapshot", async ({
  page,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  // Headless Chromium does not consistently hide background tabs. Substitute only
  // browser visibility; the served script and its event listeners stay unchanged.
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  const latestRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/updates/latest")) latestRequests.push(request.url());
  });
  await page.goto(instance.origin + "/updates");
  expect(await marker(page)).toBeNull();
  await expect(page.locator("#updates-bell")).toHaveAttribute("aria-label", "Updates — loading");
  expect(latestRequests).toEqual([]);
  await publish(instance, [1, 2, 3, 4]);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible"
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await unread(page, 4);
  expect(await marker(page)).toBe("3");
  await expect(page.locator("#update-4")).toHaveCount(0);
});

for (const failure of ["access denied", "quota exceeded"] as const) {
  test(`storage ${failure}: reading works within the page and new deployments remain unread`, async ({
    page,
    instance
  }) => {
    await publish(instance, [1, 2, 3]);
    await page.addInitScript((failure) => {
      if (failure === "access denied") {
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException("Storage blocked", "SecurityError");
          }
        });
      } else {
        Storage.prototype.setItem = () => {
          throw new DOMException("Storage full", "QuotaExceededError");
        };
      }
    }, failure);
    await page.goto(instance.origin + "/updates");
    await caughtUp(page);
    await publish(instance, [1, 2, 3, 4]);
    await openBell(page);
    await unread(page, 4);
    await page.locator(".latest-update").click();
    await caughtUp(page);
    // The documented fallback lasts for this page, not across navigation.
    await page.goto(instance.origin);
    await unread(page, 4);
  });
}

test("missing history is empty, corrupt history is unavailable, and recovery does not mark notes read", async ({
  page,
  instance
}) => {
  await page.goto(instance.origin);
  await caughtUp(page);
  await publish(instance, [1, 2, 3]);
  await writeFile(join(instance.storageDirectory, objectKey), "broken history");
  expect((await page.goto(instance.origin + "/updates"))?.status()).toBe(503);
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — unavailable"
  );
  await expect(page.locator("[data-updates-through]")).toHaveCount(0);
  expect(await marker(page)).toBeNull();
  await openBell(page);
  await expect(page.locator("#updates-popover-content h3")).toHaveText("Updates unavailable");
  await page.locator("#updates-bell").click();
  await publish(instance, [1, 2, 3]);
  await openBell(page);
  await unread(page, 3);
  expect(await marker(page)).toBeNull();
});

test("switching people refuses a stale tab's feed and keeps each person's read marker separate", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin + "/updates");
  await caughtUp(page);
  expect(await marker(page)).toBe("3");
  await instance.session(context, "colleague");
  await openBell(page);
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — unavailable"
  );
  await expect(page.locator("#updates-popover-content .latest-update")).toHaveCount(0);
  await page.goto(instance.origin);
  await unread(page, 3);
  expect(await marker(page)).toBeNull();
  await instance.session(context, "owner");
  await page.reload();
  await caughtUp(page);
});
