import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open, prepare } from "./fixtures.js";

test.use({ tls: true, ignoreHTTPSErrors: true });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Subscriptions target Chromium desktop."
);

test("a colleague's write updates the subscribed screen and reconnect catches a missed write", async ({
  page,
  browser,
  instance
}) => {
  const patch = await instance.publish();
  const writer = await open(page, patch);
  const colleague = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await prepare(colleague, instance);
    await instance.session(colleague, "colleague");
    const readerPage = await colleague.newPage();
    const reader = await open(readerPage, patch);
    await reader.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
    await expect(reader.locator("#subscription-rows")).toHaveText("[]");
    const row = await writer.evaluate(() =>
      (window as unknown as FixtureWindow).harness.client.tables.rows!.insert({
        label: "Alice saved"
      })
    );
    await expect(reader.locator("#subscription-rows")).toHaveText('["Alice saved"]');
    instance.pauseStreams(true);
    await expect(readerPage.locator('[data-stream-status="reconnecting"]')).toBeVisible();
    await writer.evaluate(
      (id) =>
        (window as unknown as FixtureWindow).harness.client.tables.rows!.update(id, {
          label: "Saved while disconnected"
        }),
      row.id
    );
    await expect(reader.locator("#subscription-rows")).toHaveText('["Alice saved"]');
    instance.pauseStreams(false);
    await expect(reader.locator("#subscription-rows")).toHaveText('["Saved while disconnected"]');
    await expect(readerPage.locator('[data-stream-status="reconnecting"]')).toBeHidden();
  } finally {
    instance.pauseStreams(false);
    await colleague.close();
  }
});
