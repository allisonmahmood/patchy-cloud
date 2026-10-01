import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open, prepare } from "./fixtures.js";
import { manifest } from "./instance.js";
import { RuntimeSubscriptionRequest } from "../../packages/api/src/index.js";
import * as Schema from "effect/Schema";

test.use({ tls: true, ignoreHTTPSErrors: true });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Subscriptions target Chromium desktop."
);

const decodeSubscriptionRequest = Schema.decodeUnknownSync(RuntimeSubscriptionRequest);

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

test("a refused shared source keeps its data and error without reconnecting or replacing the document", async ({
  page,
  context,
  instance
}) => {
  await page.clock.install();
  const source = await instance.publish("company", instance.html, undefined, {
    tables: {
      rows: { ...manifest.tables.rows, shared: true, columns: { label: { kind: "text" } } }
    }
  });
  const sourcePage = await context.newPage();
  try {
    const writer = await open(sourcePage, source);
    const row = await writer.evaluate(() =>
      (window as unknown as FixtureWindow).harness.client.tables.rows!.insert({
        label: "Last available source data"
      })
    );
    const consumer = await instance.publish("company", instance.html, undefined, {
      uses: {
        source: {
          kind: "sharedTable",
          patchId: source.patchId,
          table: "rows",
          id: `${source.patchId}/rows`,
          revision: 1
        }
      }
    });
    const commands: RuntimeSubscriptionRequest[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/runtime/subscriptions")
        commands.push(decodeSubscriptionRequest(request.postDataJSON()));
    });
    const reader = await open(page, consumer);
    await reader.evaluate(() => {
      const harness = (window as unknown as FixtureWindow).harness;
      harness.subscribeRows("shared");
      const own = Object.assign(document.createElement("p"), { id: "own-query-status" });
      document.body.append(own);
      harness.client.tables.rows!.list.subscribe({}, (snapshot) => {
        own.textContent = snapshot.status;
      });
    });
    await expect(reader.locator("#subscription-rows")).toHaveText('["Last available source data"]');
    await expect(reader.locator("#own-query-status")).toHaveText("ready");
    const pill = page.locator('[data-stream-status="reconnecting"]');
    await expect(pill).toBeHidden();
    const beforeRefusal = commands.length;
    await instance.lifecycle(source.patchId, "retire", undefined, true);
    await expect(reader.locator("#subscription-status")).toHaveText("error");
    await expect(reader.getByRole("alert")).toHaveText("access_denied");
    await page.clock.fastForward(31_000);
    await expect(reader.locator("#subscription-rows")).toHaveText('["Last available source data"]');
    await expect(reader.locator("#own-query-status")).toHaveText("ready");
    await expect(pill).toBeHidden();
    expect(commands).toHaveLength(beforeRefusal);

    // A new generation must also accept the refusal as an answer to its reconciliation fence.
    instance.pauseStreams(true);
    await expect(pill).toBeVisible();
    instance.pauseStreams(false);
    await expect(pill).toBeHidden();
    await expect(reader.locator("#subscription-status")).toHaveText("error");
    await expect(reader.getByRole("alert")).toHaveText("access_denied");
    await expect(reader.locator("#subscription-rows")).toHaveText('["Last available source data"]');
    const resumed = commands.length;
    await page.clock.fastForward(31_000);
    await expect(pill).toBeHidden();
    expect(commands).toHaveLength(resumed);

    await instance.lifecycle(source.patchId, "restore");
    await expect(reader.locator("#subscription-status")).toHaveText("ready");
    await expect(reader.getByRole("alert")).toHaveCount(0);
    const restoredWriter = await open(sourcePage, source);
    await restoredWriter.evaluate(
      (id) =>
        (window as unknown as FixtureWindow).harness.client.tables.rows!.update(id, {
          label: "Source restored"
        }),
      row.id
    );
    await expect(reader.locator("#subscription-rows")).toHaveText('["Source restored"]');
    expect(commands).toHaveLength(resumed);
  } finally {
    instance.pauseStreams(false);
    await sourcePage.close();
  }
});
