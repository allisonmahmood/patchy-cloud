import type { Frame, Page, Request } from "@playwright/test";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, notice, installSessionRefreshBoundary, streamAdmitted } from "./fixtures.js";
import type { Instance, Published } from "./instance.js";
import { RuntimeSubscriptionRequest } from "../../packages/api/src/index.js";
import * as Schema from "effect/Schema";

test.use({ tls: true, ignoreHTTPSErrors: true });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Pinned documents target Chromium desktop."
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

/** `patchy dev` serves this same broker. Serving the company shell as local drives the broker's
 * local branch against the real runtime, whose sessions can expire and change account. */
async function serve(page: Page, patch: Published, scope: "company" | "local") {
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
}

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

/** Every `me` the browser attempts, including ones held before they reach the server. */
function meRequests(page: Page) {
  const attempted: Request[] = [];
  page.on("request", (request) => {
    if (isMe(request)) attempted.push(request);
  });
  return attempted;
}

const contentFrame = (page: Page) => {
  const frame = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame() && candidate.url().includes("/~content/"));
  if (!frame) throw new Error("Tier one content frame was not loaded");
  return frame;
};

/** Loads a patch whose fixture client asks `me` at once, without waiting for the answer. */
async function load(page: Page, patch: Published): Promise<Frame> {
  const asked = page.waitForRequest(isMe);
  expect((await page.goto(patch.address))?.status()).toBe(200);
  await asked;
  return contentFrame(page);
}

/** The fixture page without its own `me`: the patch asks only when a test does. */
const lazy = (instance: Instance) =>
  instance.html.replace("<body><h1>", '<body data-me="lazy"><h1>');

/** Loads a lazy patch and waits for its fixture client and its stream's first admission. */
async function loadLazy(page: Page, patch: Published): Promise<Frame> {
  expect((await page.goto(patch.address))?.status()).toBe(200);
  await expect(page.frameLocator("#patch").locator("#identity")).toHaveText("waiting");
  const frame = contentFrame(page);
  await streamAdmitted(frame);
  return frame;
}

/** Runtime's answer to the page's next `op` call. */
const answered = (page: Page, op: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/runtime/call" &&
      response.request().postDataJSON()?.op === op
  );

for (const scope of ["company", "local"] as const) {
  test(`a ${scope} document subscribes while me is pending and still answers me`, async ({
    page,
    instance
  }) => {
    const patch = await instance.publish();
    await serve(page, patch, scope);
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
    } finally {
      release();
    }
  });

  test(`a ${scope} document's first write, first read and subscriptions go out without me`, async ({
    page,
    instance
  }) => {
    const patch = await instance.publish("company", lazy(instance));
    await serve(page, patch, scope);
    const asked = meRequests(page);
    const writer = await loadLazy(page, patch);
    expect(
      await writer.evaluate(
        async () =>
          (
            await (window as unknown as FixtureWindow).harness.client.tables.rows!.insert({
              label: "First write"
            })
          ).label
      )
    ).toBe("First write");
    const reader = await loadLazy(page, patch);
    expect(
      await reader.evaluate(async () =>
        (await (window as unknown as FixtureWindow).harness.client.tables.rows!.list()).rows.map(
          (row) => row.label
        )
      )
    ).toEqual(["First write"]);
    await reader.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
    await expect(reader.locator("#subscription-rows")).toHaveText('["First write"]');
    expect(asked).toHaveLength(0);
    expect(
      await reader.evaluate(
        async () => (await (window as unknown as FixtureWindow).harness.client.me())?.user.id
      )
    ).toBe("usr_dev");
    expect(asked).toHaveLength(1);
  });

  test(`a stale cookie on a ${scope} subscription refreshes through the stream while me is pending`, async ({
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
    await serve(page, patch, scope);
    const release = await holdMe(page);
    try {
      const frame = await load(page, patch);
      await expect.poll(() => instance.streamConnections.size).toBe(1);
      await streamAdmitted(frame);
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

  test(`an account change ends a ${scope} document as principal_changed while me is pending`, async ({
    page,
    context,
    instance
  }) => {
    const patch = await instance.publish();
    await serve(page, patch, scope);
    const release = await holdMe(page);
    try {
      const frame = await load(page, patch);
      await expect.poll(() => instance.streamConnections.size).toBe(1);
      await streamAdmitted(frame);
      await instance.session(context, "colleague");
      await frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
      await notice(page, "principal_changed");
    } finally {
      release();
    }
  });

  test(`an account change before a ${scope} document's first write refuses it unrun`, async ({
    page,
    context,
    instance
  }) => {
    const patch = await instance.publish("company", lazy(instance));
    await serve(page, patch, scope);
    const asked = meRequests(page);
    const frame = await loadLazy(page, patch);
    await instance.session(context, "colleague");
    const write = answered(page, "tables.insert");
    await frame.evaluate(() => {
      void (window as unknown as FixtureWindow).harness.client.tables
        .rows!.insert({ label: "Written as the colleague" })
        .catch(() => {});
    });
    expect((await write).status()).toBe(409);
    await notice(page, "principal_changed");
    expect(asked).toHaveLength(0);
    const company = await instance.company();
    expect(
      (await company.query(`SELECT count(*)::int AS n FROM "p_${patch.patchId}"."rows"`)).rows[0].n
    ).toBe(0);
  });

  test(`session expiry before a ${scope} document's first read ends it as session_expired`, async ({
    page,
    context,
    instance
  }) => {
    const patch = await instance.publish("company", lazy(instance));
    await serve(page, patch, scope);
    const asked = meRequests(page);
    const frame = await loadLazy(page, patch);
    await instance.session(context, "expired");
    const read = answered(page, "tables.list");
    await frame.evaluate(() => {
      void (window as unknown as FixtureWindow).harness.client.tables.rows!.list().catch(() => {});
    });
    expect((await read).status()).toBe(401);
    await notice(page, "session_expired");
    expect(asked).toHaveLength(0);
  });

  test(`a refused operation leaves a ${scope} document working; losing the document ends it`, async ({
    page,
    instance
  }) => {
    const consumer = await instance.publish("company", lazy(instance));
    await serve(page, consumer, scope);
    const asked = meRequests(page);
    const reader = await loadLazy(page, consumer);
    // Tier 1 reaches only its own patch: another patch's shared table is a tier 2 handler's.
    const refused = answered(page, "shared.list");
    await reader.evaluate(
      (wire) =>
        (window as unknown as FixtureWindow).harness.raw({
          v: wire,
          id: "shared-read",
          op: "shared.list",
          args: { alias: "source" }
        }),
      instance.wire
    );
    expect((await refused).status()).toBe(403);
    await expect
      .poll(() =>
        reader.evaluate(
          () =>
            (window as unknown as FixtureWindow).harness.replies.find(
              (reply) => reply.id === "shared-read"
            )?.error?.code
        )
      )
      .toBe("server_required");
    expect(
      await reader.evaluate(
        async () =>
          (
            await (window as unknown as FixtureWindow).harness.client.tables.rows!.insert({
              label: "Still working"
            })
          ).label
      )
    ).toBe("Still working");
    expect(page.url()).toBe(consumer.address);
    expect(asked).toHaveLength(0);

    const frame = await loadLazy(page, consumer);
    await instance.platform.query("UPDATE users SET deactivated_at=now() WHERE id='usr_dev'");
    const read = answered(page, "tables.list");
    await frame.evaluate(() => {
      void (window as unknown as FixtureWindow).harness.client.tables.rows!.list().catch(() => {});
    });
    expect((await read).status()).toBe(403);
    await notice(page, "access_denied");
    expect(asked).toHaveLength(1);
  });
}
