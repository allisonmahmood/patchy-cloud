import type { Frame, Page, Request } from "@playwright/test";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, notice, installSessionRefreshBoundary } from "./fixtures.js";
import type { Instance, Published } from "./instance.js";
import { RuntimeSubscriptionRequest } from "../../packages/api/src/index.js";
import * as Schema from "effect/Schema";

test.use({ tls: true, ignoreHTTPSErrors: true });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Subscriptions target Chromium desktop."
);

const isMe = (request: Request) =>
  new URL(request.url()).pathname === "/api/runtime/call" && request.postDataJSON()?.op === "me";
const decodeSubscriptionRequest = Schema.decodeUnknownSync(RuntimeSubscriptionRequest);
const isSubscription = (request: Request) => {
  if (new URL(request.url()).pathname !== "/api/runtime/subscriptions") return false;
  const command = decodeSubscriptionRequest(request.postDataJSON());
  return (
    command.type === "subscribe" || (command.type === "replace" && command.subscriptions.length > 0)
  );
};

/** Holds every `me` call in the browser until the returned release runs. */
async function holdMe(page: Page) {
  const held = Promise.withResolvers<void>();
  await page.route("**/api/runtime/call", async (route) => {
    if (isMe(route.request())) await held.promise;
    // The document may have left for a notice while its call was held.
    await route.continue().catch(() => {});
  });
  return held.resolve;
}

/** Loads a patch whose fixture client asks `me` at once, without waiting for the answer. */
async function load(page: Page, patch: Published): Promise<Frame> {
  const asked = page.waitForRequest(isMe);
  expect((await page.goto(patch.address))?.status()).toBe(200);
  await asked;
  const frame = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame() && candidate.url().includes("/~content/"));
  if (!frame) throw new Error("Tier one content frame was not loaded");
  return frame;
}

const meCalls = (instance: Instance) =>
  instance.runtimeRequests.filter(
    (request) => request.path === "/api/runtime/call" && JSON.parse(request.body).op === "me"
  ).length;

for (const scope of ["company", "local"] as const) {
  test(`a ${scope} document subscribes while me is pending and still answers me`, async ({
    page,
    instance
  }) => {
    const patch = await instance.publish();
    // `patchy dev` serves this same broker; the company shell served as local drives its local
    // branch against the real runtime.
    if (scope === "local")
      await page.route(patch.address, async (route) => {
        const response = await route.fetch();
        const html = await response.text();
        expect(html).toContain('data-scope="company"');
        await route.fulfill({
          response,
          body: html.replace('data-scope="company"', 'data-scope="local"')
        });
      });
    const release = await holdMe(page);
    try {
      const frame = await load(page, patch);
      const subscribed = page.waitForRequest(isSubscription);
      await frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
      await subscribed;
      await expect(frame.locator("#subscription-rows")).toHaveText("[]");
      await expect(frame.locator("#identity")).toHaveText("waiting");
      release();
      await expect(frame.locator("#identity")).toHaveText("usr_dev");
      // Only the patch asked; the shell added no `me` of its own.
      expect(meCalls(instance)).toBe(1);
    } finally {
      release();
    }
  });
}

test("a stale cookie on a company subscription refreshes through the stream while me is pending", async ({
  page,
  context,
  instance
}) => {
  let refreshes = 0;
  await installSessionRefreshBoundary(context, () => {
    refreshes++;
    return instance.session(context);
  });
  const patch = await instance.publish();
  const release = await holdMe(page);
  try {
    const frame = await load(page, patch);
    await expect.poll(() => instance.streamConnections.size).toBe(1);
    await instance.session(context, "expired");
    // The shell aborts the refused update before its body can be read; the refresh shows its code.
    const refused = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/runtime/subscriptions" &&
        response.status() === 401
    );
    await frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
    await refused;
    await expect(frame.locator("#subscription-rows")).toHaveText("[]");
    expect(refreshes).toBe(1);
    await expect(frame.locator("#identity")).toHaveText("waiting");
    await expect(page.locator("[data-notice]")).toHaveCount(0);
    release();
    await expect(frame.locator("#identity")).toHaveText("usr_dev");
  } finally {
    release();
  }
});

test("an account change ends a company document as principal_changed while me is pending", async ({
  page,
  context,
  instance
}) => {
  const patch = await instance.publish();
  const release = await holdMe(page);
  try {
    const frame = await load(page, patch);
    await expect.poll(() => instance.streamConnections.size).toBe(1);
    await instance.session(context, "colleague");
    await frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
    await notice(page, "principal_changed");
    expect(meCalls(instance)).toBe(0);
  } finally {
    release();
  }
});
