import type { Frame, Page, Route } from "@playwright/test";
import type { FixtureWindow } from "./fixture-client.js";
import type { Instance } from "./instance.js";
import { test, expect, open, notice, installSessionRefreshBoundary } from "./fixtures.js";
import { RuntimeSubscriptionRequest, type RuntimeFailure } from "../../packages/api/src/index.js";
import * as Schema from "effect/Schema";

test.use({ tls: true, ignoreHTTPSErrors: true });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Stream acceptance targets Chromium desktop."
);

const decodeSubscriptionRequest = Schema.decodeUnknownSync(RuntimeSubscriptionRequest);

const generations = (frame: Frame) =>
  frame.evaluate(() =>
    (window as unknown as FixtureWindow).harness.replies.flatMap((reply) =>
      reply.event === "stream" && reply.data?.type === "hello" ? [reply.data.generation] : []
    )
  );

test("publish preserves editing, dismissal lasts until the next publish, and rollback clears the bar", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const input = frame.locator("#pasted-copy");
  await input.fill("Unsaved notes");
  await input.focus();
  await instance.publish("company", instance.html, patch.patchId);
  await expect(page.getByText(/^A new version of .+ is available\.$/)).toBeVisible();
  await expect(input).toHaveValue("Unsaved notes");
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(page.getByText(/^A new version of .+ is available\.$/)).toBeHidden();
  // A rollback to the already served version is not a new publish.
  await instance.lifecycle(patch.patchId, "rollback", 2);
  await expect(page.getByText(/^A new version of .+ is available\.$/)).toBeHidden();
  await instance.publish("company", instance.html, patch.patchId);
  await expect(page.getByText(/^A new version of .+ is available\.$/)).toBeVisible();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await expect(page.locator("#patch")).toBeFocused();
  await instance.lifecycle(patch.patchId, "rollback", 1);
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeHidden();
  await expect(input).toHaveValue("Unsaved notes");
  expect(await generations(frame)).toHaveLength(1);
});

test("a served tier upgrade cannot be dismissed and rollback clears its saving notice", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const next = await instance.publish("company", instance.html, patch.patchId);
  // Tier 2 publishing lands separately; seed its stored tier to exercise the real served frame.
  await instance.platform.query(
    "UPDATE patch_versions SET tier = 2, manifest = jsonb_set(manifest, '{tier}', '2') WHERE id = $1",
    [next.versionId]
  );
  await instance.lifecycle(patch.patchId, "rollback", 2);
  await expect(page.getByText(/^.+ was updated\. Reload to keep saving\.$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Not now", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByText("Reload to keep saving", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await instance.lifecycle(patch.patchId, "rollback", 1);
  await expect(page.getByText("Reload to keep saving", { exact: true })).toBeHidden();
});

for (const scenario of [
  { address: "numbered", suffix: "/~v/1", tier: 1 },
  { address: "numbered", suffix: "/~v/1", tier: 2 },
  { address: "current", suffix: "", tier: 1 }
] as const) {
  test(`${scenario.tier === 2 ? "required" : "optional"} reload opens the current version from a ${scenario.address} address and preserves its route`, async ({
    page,
    instance
  }) => {
    const patch = await instance.publish();
    if (scenario.suffix) await instance.publish("company", instance.html, patch.patchId);
    const queryAndHash = "?view=chart&tag=first%20item&tag=second#row-7";
    const frame = await open(page, patch, `${scenario.suffix}/reports/caf%C3%A9${queryAndHash}`);
    await expect.poll(() => generations(frame)).toHaveLength(1);
    await frame.evaluate(() =>
      (window as unknown as FixtureWindow).harness.client.route.set("/reports/weekly/café")
    );
    await expect(page).toHaveURL(
      `${patch.address}${scenario.suffix}/reports/weekly/caf%C3%A9${queryAndHash}`
    );
    const next = await instance.publish(
      "company",
      instance.html.replace("<h1>Tier one acceptance</h1>", "<h1>Current published version</h1>"),
      patch.patchId
    );
    if (scenario.tier === 2) {
      // Tier 2 publishing lands separately; the stored tier drives the real served notice.
      await instance.platform.query(
        "UPDATE patch_versions SET tier = 2, manifest = jsonb_set(manifest, '{tier}', '2') WHERE id = $1",
        [next.versionId]
      );
      await instance.lifecycle(patch.patchId, "rollback", 3);
      await expect(page.getByText(/^.+ was updated\. Reload to keep saving\.$/)).toBeVisible();
    } else {
      await expect(page.getByText(/^A new version of .+ is available\.$/)).toBeVisible();
    }
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(page).toHaveURL(`${patch.address}/reports/weekly/caf%C3%A9${queryAndHash}`);
    await expect(page.locator("#patch")).toHaveAttribute("data-version-id", next.versionId);
    await expect(
      page.frameLocator("#patch").getByRole("heading", { name: "Current published version" })
    ).toBeVisible();
    await expect(page.frameLocator("#patch").locator("#route")).toHaveText("/reports/weekly/café");
    await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeHidden();
    await expect(page.locator("[data-notice]")).toHaveCount(0);
  });
}

test("a lost first hello retries live-socket conflicts until ingress releases the abandoned stream", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/runtime/stream")
      statuses.push(response.status());
  });
  const release = instance.loseNextStreamHello();
  try {
    const frame = await open(page, patch);
    await frame.locator("#pasted-copy").fill("Editing before the first hello");
    await expect.poll(() => statuses.filter((status) => status === 409).length).toBeGreaterThan(1);
    expect(await generations(frame)).toEqual([]);
    await expect(page.locator("[data-notice]")).toHaveCount(0);
    release();
    await expect.poll(() => generations(frame)).toHaveLength(1);
    await expect(frame.locator("#pasted-copy")).toHaveValue("Editing before the first hello");
    await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
    expect(instance.streamConnections.size).toBe(1);
  } finally {
    release();
  }
});

test("a lost replacement hello retries conflicts without discarding the known-generation document", async ({
  page,
  instance
}) => {
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const initialGeneration = (await generations(frame))[0];
  await frame.locator("#pasted-copy").fill("Editing through a lost replacement hello");
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/runtime/stream")
      statuses.push(response.status());
  });
  const release = instance.loseNextStreamHello();
  try {
    instance.pauseStreams(true);
    await expect.poll(() => instance.streamConnections.size).toBe(0);
    instance.pauseStreams(false);
    await expect.poll(() => statuses.filter((status) => status === 409).length).toBeGreaterThan(1);
    expect(await generations(frame)).toEqual([initialGeneration]);
    await expect(frame.locator("#pasted-copy")).toHaveValue(
      "Editing through a lost replacement hello"
    );
    await expect(page.locator("[data-notice]")).toHaveCount(0);
    release();
    await expect.poll(() => generations(frame)).toHaveLength(2);
    expect((await generations(frame))[1]).not.toBe(initialGeneration);
    await expect(frame.locator("#pasted-copy")).toHaveValue(
      "Editing through a lost replacement hello"
    );
    await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
    expect(instance.streamConnections.size).toBe(1);
  } finally {
    release();
  }
});

test("a definitive sign-out stops at the token deadline without a runtime operation", async ({
  page,
  context,
  instance
}) => {
  await instance.session(context, "owner", 5);
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await instance.session(context, "none");
  const calls = instance.runtimeRequests.filter(
    (request) => request.path === "/api/runtime/call"
  ).length;
  await notice(page, "session_expired");
  expect(
    instance.runtimeRequests.filter((request) => request.path === "/api/runtime/call")
  ).toHaveLength(calls);
});

test("a refreshed browser token preserves query status and never flashes a data error", async ({
  page,
  context,
  instance
}) => {
  await instance.session(context, "owner", 5);
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
  await expect(frame.locator("#subscription-status")).toHaveText("ready");
  await frame.evaluate(() => {
    (window as unknown as FixtureWindow).harness.queryStatuses.length = 0;
  });
  await frame.locator("#pasted-copy").fill("Editing through token refresh");
  await instance.session(context);
  await expect.poll(async () => (await generations(frame)).length).toBeGreaterThan(1);
  await expect(frame.locator("#pasted-copy")).toHaveValue("Editing through token refresh");
  await expect(frame.locator("#subscription-status")).toHaveText("ready");
  await expect(frame.locator("#subscription-rows")).toHaveText("[]");
  await expect(frame.getByRole("alert")).toHaveCount(0);
  expect(
    await frame.evaluate(() => (window as unknown as FixtureWindow).harness.queryStatuses)
  ).not.toContain("error");
  await expect(page.locator("[data-notice]")).toHaveCount(0);
});

test("hidden resume refreshes a stale cookie through the session script without losing the draft", async ({
  page,
  context,
  instance
}) => {
  await page.clock.install();
  let attempts = 0;
  const release = Promise.withResolvers<void>();
  await installSessionRefreshBoundary(context, async (options) => {
    expect(options).toEqual({ skipCache: true });
    attempts++;
    if (attempts === 1) throw new Error("Offline Clerk refresh");
    await release.promise;
    return instance.session(context);
  });
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  expect(attempts).toBe(0);
  await frame.locator("#pasted-copy").fill("Draft through delayed session refresh");
  const pill = page.locator('[data-stream-status="reconnecting"]');
  instance.pauseStreams(true);
  await expect(pill).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(30_000);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  // Suspension must not masquerade as hello/reconciliation.
  await expect(pill).toBeVisible();
  await instance.session(context, "expired");
  instance.pauseStreams(false);
  const refused = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/runtime/stream" && response.status() === 401
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(await (await refused).json()).toMatchObject({ code: "session_refresh_required" });
  // The failed first refresh backs off before the second attempt; step the page clock
  // until it lands rather than betting on real time.
  await expect
    .poll(
      async () => {
        await page.clock.fastForward(5_000);
        return attempts;
      },
      { intervals: [250], timeout: 30_000 }
    )
    .toBe(2);
  await expect(frame.locator("#pasted-copy")).toHaveValue("Draft through delayed session refresh");
  await expect(page.locator("[data-notice]")).toHaveCount(0);
  expect(await generations(frame)).toHaveLength(1);
  await expect(pill).toBeVisible();
  // A successful refresh reconnects at once: no page timer may fire from here on. The
  // clock still runs in real time and cannot pause in the past, so pause a few seconds
  // ahead to survive a stalled runner; no retry is scheduled while the refresh is held.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 5_000);
  release.resolve();
  await expect.poll(() => generations(frame)).toHaveLength(2);
  await expect(pill).toBeHidden();
  await expect(frame.locator("#pasted-copy")).toHaveValue("Draft through delayed session refresh");
});

test("failed token refresh is bounded and an online retry keeps the same document", async ({
  page,
  context,
  instance
}) => {
  await page.clock.install();
  let attempts = 0;
  let available = false;
  await installSessionRefreshBoundary(context, async () => {
    attempts++;
    if (!available) throw new Error("Offline Clerk refresh");
    return instance.session(context);
  });
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await frame.locator("#pasted-copy").fill("Draft during a longer outage");
  instance.pauseStreams(true);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  await instance.session(context, "expired");
  instance.pauseStreams(false);
  await expect.poll(() => attempts).toBe(3);
  const requests = instance.runtimeRequests.filter((request) =>
    request.path.startsWith("/api/runtime/stream")
  ).length;
  await page.clock.fastForward(30_000);
  await expect
    .poll(
      () =>
        instance.runtimeRequests.filter((request) => request.path.startsWith("/api/runtime/stream"))
          .length
    )
    .toBeGreaterThan(requests);
  expect(attempts).toBe(3);
  await expect(frame.locator("#pasted-copy")).toHaveValue("Draft during a longer outage");
  await expect(page.locator("[data-notice]")).toHaveCount(0);
  available = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  // Online lets the next attempt refresh but keeps the pending backoff, up to 30 seconds;
  // the attempt that refreshes then reconnects at once. Step the page clock until the
  // reconnect lands rather than betting on one jump and real time.
  await expect
    .poll(
      async () => {
        await page.clock.fastForward(5_000);
        return generations(frame);
      },
      { intervals: [250], timeout: 30_000 }
    )
    .toHaveLength(2);
  expect(attempts).toBe(4);
  await expect(frame.locator("#pasted-copy")).toHaveValue("Draft during a longer outage");
});

test("the session script stops a stale-token document only when Clerk confirms sign-out", async ({
  page,
  context,
  instance
}) => {
  await installSessionRefreshBoundary(context, () => instance.session(context, "none"));
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  instance.pauseStreams(true);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  await instance.session(context, "expired");
  instance.pauseStreams(false);
  await notice(page, "session_expired");
});

test("sharing publicly preserves an admitted company document across reconnect", async ({
  page,
  context,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await frame.locator("#pasted-copy").fill("Company draft after sharing");
  await instance.share(patch.patchId, "public");
  instance.pauseStreams(true);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  instance.pauseStreams(false);
  await expect.poll(() => generations(frame)).toHaveLength(2);
  await expect(page.locator("#patch")).toHaveAttribute("data-version-id", patch.versionId);
  await expect(frame.locator("#pasted-copy")).toHaveValue("Company draft after sharing");
  await expect(page.locator("[data-notice]")).toHaveCount(0);
  expect(
    await frame.evaluate(async () => {
      try {
        await (window as unknown as FixtureWindow).harness.client.tables.rows!.list();
      } catch (error) {
        if (error instanceof Error && "code" in error) return error.code;
        throw error;
      }
      return "unexpectedly allowed";
    })
  ).toBe("not_available_on_public");
  await expect(frame.locator("#pasted-copy")).toHaveValue("Company draft after sharing");
  const publicPage = await context.newPage();
  const requests = instance.runtimeRequests.filter((request) =>
    request.path.startsWith("/api/runtime/stream")
  ).length;
  const publicFrame = await open(publicPage, patch);
  await expect(publicFrame.locator("#identity")).toHaveText("anonymous");
  expect(
    instance.runtimeRequests.filter((request) => request.path.startsWith("/api/runtime/stream"))
  ).toHaveLength(requests);
  expect(await generations(publicFrame)).toEqual([]);
});

test("a missed retirement frame is enforced when the document reconnects", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  await expect.poll(() => generations(frame)).toHaveLength(1);
  instance.pauseStreams(true);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  await instance.lifecycle(patch.patchId, "retire");
  instance.pauseStreams(false);
  await notice(page, "access_denied");
});

test("a reconnect keeps its pill after hello until the desired subscriptions reach their fences", async ({
  page,
  instance
}) => {
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
  await expect(frame.locator("#subscription-rows")).toHaveText("[]");
  await frame.locator("#pasted-copy").fill("Keep the disconnected draft");
  const pill = page.locator('[data-stream-status="reconnecting"]');
  instance.pauseStreams(true);
  await expect(pill).toBeHidden();
  await expect(pill).toBeVisible();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/runtime/subscriptions", async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    instance.pauseStreams(false);
    await expect.poll(async () => (await generations(frame)).length).toBe(2);
    await expect(pill).toBeVisible();
    await expect(frame.locator("#subscription-rows")).toHaveText("[]");
    release.resolve();
    await expect(pill).toBeHidden();
    await expect(frame.locator("#pasted-copy")).toHaveValue("Keep the disconnected draft");
  } finally {
    release.resolve();
    instance.pauseStreams(false);
    await page.unroute("**/api/runtime/subscriptions");
  }
});

test("a hidden document suspends after thirty seconds and resumes its loaded version", async ({
  page,
  instance
}) => {
  await page.clock.install();
  const patch = await instance.publish();
  const frame = await open(page, patch);
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await frame.locator("#pasted-copy").fill("Hidden draft");
  // Drive the browser visibility boundary deterministically, without freezing its timers.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(29_000);
  expect(instance.streamConnections.size).toBe(1);
  await page.clock.fastForward(1_000);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  await instance.publish("company", instance.html, patch.patchId);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await generations(frame)).length).toBe(2);
  await expect(page.getByText(/^A new version of .+ is available\.$/)).toBeVisible();
  await expect(frame.locator("#pasted-copy")).toHaveValue("Hidden draft");
});

test("host restart reconnects the loaded document without discarding input", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const first = (await generations(frame))[0];
  await frame.locator("#pasted-copy").fill("Keep this through a restart");
  await instance.restart();
  await expect.poll(async () => (await generations(frame)).at(-1)).not.toBe(first);
  await expect(frame.locator("#pasted-copy")).toHaveValue("Keep this through a restart");
  await expect(page.getByText("Reconnecting", { exact: false })).toBeHidden();
});

test("a ninth document stops at the stream limit and can reopen when a slot is free", async ({
  context,
  page,
  instance
}) => {
  const patch = await instance.publish();
  const admitted = await Promise.all(Array.from({ length: 8 }, () => context.newPage()));
  const frames = await Promise.all(admitted.map((document) => open(document, patch)));
  await expect
    .poll(async () => Promise.all(frames.map(generations)))
    .toEqual(Array.from({ length: 8 }, () => [expect.any(String)]));
  await page.goto(patch.address);
  await notice(page, "stream_limit");
  expect(instance.streamConnections.size).toBe(8);
  await admitted[0]!.close();
  await expect.poll(() => instance.streamConnections.size).toBe(7);
  const reopened = await open(page, patch);
  await expect.poll(() => generations(reopened)).toHaveLength(1);
  expect(instance.streamConnections.size).toBe(8);
});

test("seven company documents stay connected simultaneously over HTTP/2 TLS ingress", async ({
  context,
  instance
}) => {
  const patch = await instance.publish();
  const pages = await Promise.all(Array.from({ length: 7 }, () => context.newPage()));
  const streamResponses: Array<{ protocol: string | undefined; status: number }> = [];
  for (const page of pages) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.responseReceived", ({ response }) => {
      if (new URL(response.url).pathname === "/api/runtime/stream") {
        streamResponses.push({ protocol: response.protocol, status: response.status });
      }
    });
  }
  const frames = await Promise.all(pages.map((page) => open(page, patch)));
  await expect
    .poll(async () => Promise.all(frames.map(generations)))
    .toEqual(Array.from({ length: 7 }, () => [expect.any(String)]));
  expect(streamResponses).toEqual(
    Array.from({ length: 7 }, () => ({ protocol: "h2", status: 200 }))
  );
  expect(instance.streamConnections.size).toBe(7);
  // A new committed version must reach all seven still-open streams, not seven sequential opens.
  await instance.publish("company", instance.html, patch.patchId);
  for (const page of pages)
    await expect(page.getByText(/^A new version of .+ is available\.$/)).toBeVisible();
  expect(instance.streamConnections.size).toBe(7);
  await Promise.all(pages.map((page) => page.close()));
  await expect.poll(() => instance.streamConnections.size).toBe(0);
});

test("a missing delta installs the full ordered desired set, then resumes using its last vectors", async ({
  page,
  instance
}) => {
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const commands: RuntimeSubscriptionRequest[] = [];
  let dropped = false;
  await page.route("**/api/runtime/subscriptions", async (route) => {
    const command = decodeSubscriptionRequest(route.request().postDataJSON());
    commands.push(command);
    if (command.type === "subscribe" && !dropped) {
      dropped = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    } else await route.continue();
  });
  await frame.evaluate(async () => {
    const client = (window as unknown as FixtureWindow).harness.client;
    await client.tables.rows!.insert({ label: "Ordered subscriptions" });
    for (const limit of [1, 2]) {
      const output = Object.assign(document.createElement("p"), { id: `ordered-${limit}` });
      document.body.append(output);
      client.tables.rows!.list.subscribe({ limit }, (snapshot) => {
        if (snapshot.data)
          output.textContent = JSON.stringify(snapshot.data.rows.map((row) => row.label));
      });
    }
  });
  await expect(frame.locator("#ordered-1")).toHaveText('["Ordered subscriptions"]', {
    timeout: 15_000
  });
  await expect(frame.locator("#ordered-2")).toHaveText('["Ordered subscriptions"]');
  const deltas = commands.filter((command) => command.type === "subscribe");
  expect(deltas.map((command) => command.sequence)).toEqual([1, 2]);
  const replacement = commands.find(
    (command) => command.type === "replace" && command.sequence === 2
  );
  if (replacement?.type !== "replace")
    throw new Error("The gap must be repaired with a desired set.");
  expect(replacement.subscriptions.map((subscription) => subscription.id).sort()).toEqual(
    deltas.map((command) => command.subscription.id).sort()
  );
  const lastSnapshots = await frame.evaluate(() =>
    Object.fromEntries(
      (window as unknown as FixtureWindow).harness.replies.flatMap(({ event, data }) =>
        event === "stream" && (data?.type === "snapshot" || data?.type === "up-to-date")
          ? [[data.id, { revision: data.revision, vector: data.vector }]]
          : []
      )
    )
  );
  const before = commands.length;
  instance.pauseStreams(true);
  await expect(page.locator('[data-stream-status="reconnecting"]')).toBeVisible();
  instance.pauseStreams(false);
  await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
  const resumed = commands.slice(before).find((command) => command.type === "replace");
  if (resumed?.type !== "replace")
    throw new Error("A new generation must replace the desired set.");
  expect(resumed.generation).not.toBe(replacement.generation);
  expect(resumed.sequence).toBe(0);
  expect(resumed.subscriptions.map((subscription) => subscription.id).sort()).toEqual(
    replacement.subscriptions.map((subscription) => subscription.id).sort()
  );
  for (const subscription of resumed.subscriptions) {
    expect({ revision: subscription.revision, vector: subscription.vector }).toEqual(
      lastSnapshots[subscription.id]
    );
  }
  await page.unroute("**/api/runtime/subscriptions");
});

test("a lost admitted frame repairs the desired set without replacing the live connection", async ({
  page,
  instance
}) => {
  await page.clock.install();
  const commands: RuntimeSubscriptionRequest[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/runtime/subscriptions")
      commands.push(decodeSubscriptionRequest(request.postDataJSON()));
  });
  const frame = await open(page, await instance.publish());
  await frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
  await expect(frame.locator("#subscription-rows")).toHaveText("[]");
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const pill = page.locator('[data-stream-status="reconnecting"]');
  instance.pauseStreams(true);
  try {
    await expect(pill).toBeVisible();
    const dropped = instance.loseNextAdmitted(0);
    instance.pauseStreams(false);
    await dropped;
    await expect.poll(() => generations(frame)).toHaveLength(2);
    await expect(pill).toBeHidden();
    const generation = (await generations(frame))[1];
    const replacements = commands.filter(
      (command) => command.generation === generation && command.type === "replace"
    );
    expect(replacements.map((command) => command.sequence)).toEqual([0, 0]);
    expect(instance.streamConnections.size).toBe(1);
    await expect(frame.locator("#subscription-rows")).toHaveText("[]");
    const completed = commands.length;
    await page.clock.fastForward(31_000);
    expect(commands).toHaveLength(completed);
    expect(await generations(frame)).toHaveLength(2);
  } finally {
    instance.pauseStreams(false);
  }
});

// One live query per limit, each rendering its row count into #rows-<limit>.
const subscribeLimit = (frame: Frame, limit: number) =>
  frame.evaluate((limit) => {
    const output = Object.assign(document.createElement("p"), { id: `rows-${limit}` });
    document.body.append(output);
    (window as unknown as FixtureWindow).harness.client.tables.rows!.list.subscribe(
      { limit },
      (snapshot) => {
        if (snapshot.data) output.textContent = String(snapshot.data.rows.length);
      }
    );
  }, limit);
const admittedSequences = (frame: Frame) =>
  frame.evaluate(() =>
    (window as unknown as FixtureWindow).harness.replies.flatMap((reply) =>
      reply.event === "stream" && reply.data?.type === "admitted" ? [reply.data.sequence] : []
    )
  );

test("admitted subscriptions wait the reconcile interval for their answers before a replace", async ({
  page,
  instance
}) => {
  await page.clock.install();
  const commands: RuntimeSubscriptionRequest[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/runtime/subscriptions")
      commands.push(decodeSubscriptionRequest(request.postDataJSON()));
  });
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const pill = page.locator('[data-stream-status="reconnecting"]');
  const replaces = () =>
    commands.flatMap((command) => (command.type === "replace" ? [command.sequence] : []));
  // Pause ahead of real time; no reconciliation timer is armed for the reconciled empty set.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
  // Like a server still running the queries: every POST is admitted, no answer arrives.
  instance.holdStreamFrames("answers");
  try {
    for (const limit of [1, 2, 3]) await subscribeLimit(frame, limit);
    await expect.poll(() => admittedSequences(frame)).toContain(3);
    // A timer replace would also raise the pill two seconds later.
    await page.clock.runFor(29_000);
    await expect(pill).toBeHidden();
    // Missing answers are still repaired, on the slow path.
    await page.clock.runFor(1_000);
    await expect.poll(replaces).toEqual([0, 3]);
  } finally {
    instance.holdStreamFrames(false);
  }
  for (const limit of [1, 2, 3]) await expect(frame.locator(`#rows-${limit}`)).toHaveText("0");
  await expect(pill).toBeHidden();
  expect(replaces()).toEqual([0, 3]);
});

test("a lost subscribe POST or admitted frame is repaired within a second", async ({
  page,
  instance
}) => {
  await page.clock.install();
  const commands: RuntimeSubscriptionRequest[] = [];
  let lost = false;
  await page.route("**/api/runtime/subscriptions", async (route) => {
    const command = decodeSubscriptionRequest(route.request().postDataJSON());
    commands.push(command);
    if (command.type === "subscribe" && !lost) {
      lost = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    } else await route.continue();
  });
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const sent = () => commands.map((command) => `${command.type} ${command.sequence}`);
  // Pause ahead of real time; no reconciliation timer is armed for the reconciled empty set.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);

  await subscribeLimit(frame, 1);
  await expect.poll(sent).toEqual(["replace 0", "subscribe 1"]);
  await page.clock.runFor(1_000);
  await expect.poll(sent).toEqual(["replace 0", "subscribe 1", "replace 1"]);
  await expect(frame.locator("#rows-1")).toHaveText("0");

  const dropped = instance.loseNextAdmitted(2);
  await subscribeLimit(frame, 2);
  await dropped;
  await page.clock.runFor(1_000);
  await expect
    .poll(sent)
    .toEqual(["replace 0", "subscribe 1", "replace 1", "subscribe 2", "replace 2"]);
  await expect(frame.locator("#rows-2")).toHaveText("0");
  await page.clock.resume();
  await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
  await page.unroute("**/api/runtime/subscriptions");
});

// A Patchy refusal of one subscription POST, in the server's wire shape.
const refusal = (status: number, code: RuntimeFailure["code"]) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({
    ok: false,
    source: "patchy",
    error: "Refused by the test ingress.",
    code
  } satisfies RuntimeFailure)
});

// Whether the newest stream has admitted a sequence. The first stream's frames before the
// port binds are not replayed, so count only those after the last hello.
const admittedSinceHello = (frame: Frame) =>
  frame.evaluate(() => {
    const types = (window as unknown as FixtureWindow).harness.replies.flatMap((reply) =>
      reply.event === "stream" && reply.data ? [reply.data.type] : []
    );
    return types.slice(types.lastIndexOf("hello")).includes("admitted");
  });

test("a current-generation loss reconnects at once, then waits until a stream reconciles", async ({
  page,
  instance
}) => {
  await page.clock.install();
  const fences: Array<string | undefined> = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/runtime/stream")
      fences.push(request.headers()["x-patchy-generation"]);
  });
  // Like a host that does not hold the stream, for the next POSTs of any type.
  let refusals = 0;
  await page.route("**/api/runtime/subscriptions", async (route) => {
    if (refusals === 0) return route.continue();
    refusals--;
    await route.fulfill(refusal(409, "invalid_request"));
  });
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  // Pause ahead of real time; no timer is armed for the reconciled empty set. From here a
  // reconnect that lands without runFor skipped the backoff.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);

  // The first loss reconnects at once. The new stream admits its replace but its answers are
  // held, so it has not reconciled and the next loss waits for the backoff.
  instance.holdStreamFrames("answers");
  try {
    refusals = 1;
    await subscribeLimit(frame, 1);
    await expect.poll(() => generations(frame)).toHaveLength(2);
    await expect.poll(() => admittedSinceHello(frame)).toBe(true);
    refusals = 1;
    await subscribeLimit(frame, 2);
    await expect.poll(() => refusals).toBe(0);
    await expect.poll(() => instance.streamConnections.size).toBe(0);
    await page.waitForTimeout(500);
    expect(await generations(frame)).toHaveLength(2);
    await page.clock.runFor(500);
    await expect.poll(() => generations(frame)).toHaveLength(3);
  } finally {
    instance.holdStreamFrames(false);
  }

  // Once that stream's answers arrive it has reconciled, so the next loss reconnects at once.
  await expect(frame.locator("#rows-1")).toHaveText("0");
  await expect(frame.locator("#rows-2")).toHaveText("0");
  refusals = 1;
  await subscribeLimit(frame, 3);
  await expect.poll(() => generations(frame)).toHaveLength(4);
  await expect(frame.locator("#rows-3")).toHaveText("0");
  // Every reconnect names the generation it replaces, so it touches its version, never warms it.
  expect(fences).toEqual([undefined, ...(await generations(frame)).slice(0, -1)]);
  await page.unroute("**/api/runtime/subscriptions");
});

test("stale, session, principal and rate-limit refusals of a POST keep their handling", async ({
  page,
  instance
}) => {
  await page.clock.install();
  // The next POST of any type is held, then each queued refusal answers one.
  let held: PromiseWithResolvers<Route> | undefined;
  const refusals: Array<Parameters<typeof refusal>> = [];
  await page.route("**/api/runtime/subscriptions", async (route) => {
    if (held) {
      held.resolve(route);
      held = undefined;
      return;
    }
    const next = refusals.shift();
    if (next) await route.fulfill(refusal(...next));
    else await route.continue();
  });
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);

  // A refusal that arrives after the shell moved past its sequence leaves the stream alone.
  const stalled = Promise.withResolvers<Route>();
  held = stalled;
  await subscribeLimit(frame, 1);
  const stale = await stalled.promise;
  await subscribeLimit(frame, 2);
  // The fast repair installs the whole set at sequence 2.
  await page.clock.runFor(1_000);
  await expect(frame.locator("#rows-2")).toHaveText("0");
  await stale.fulfill(refusal(409, "invalid_request"));
  await page.waitForTimeout(500);
  await page.clock.runFor(1_000);
  await expect(frame.locator("#rows-1")).toHaveText("0");
  expect(await generations(frame)).toHaveLength(1);
  expect(instance.streamConnections.size).toBe(1);

  // Every other refusal of a current POST still tears the stream down behind the backoff and
  // leaves the allowance unspent: the unreconciled replacement's loss reconnects at once.
  let limit = 2;
  for (const [status, code] of [
    [401, "session_refresh_required"],
    [409, "principal_changed"],
    [429, "rate_limited"]
  ] as const) {
    const opened = (await generations(frame)).length;
    refusals.push([status, code], [409, "invalid_request"]);
    await subscribeLimit(frame, ++limit);
    await expect.poll(() => refusals.length).toBe(1);
    await expect.poll(() => instance.streamConnections.size).toBe(0);
    await page.waitForTimeout(500);
    expect(await generations(frame)).toHaveLength(opened);
    await page.clock.runFor(500);
    await expect.poll(() => generations(frame)).toHaveLength(opened + 2);
    expect(refusals).toEqual([]);
    await expect(frame.locator(`#rows-${limit}`)).toHaveText("0");
  }
  await page.unroute("**/api/runtime/subscriptions");
});

// The page clock when each stream opened and when the shell aborted it. With the clock paused,
// a backoff timer opens the next stream inside `runFor`, so the gap is exactly the delay.
interface StreamOpen {
  readonly at: number;
  lostAt?: number;
}
const recordStreamOpens = (page: Page) =>
  page.addInitScript(() => {
    const opens: StreamOpen[] = [];
    const fetch = window.fetch;
    Object.assign(window, { streamOpens: opens });
    window.fetch = (input, init) => {
      if (String(input).includes("/api/runtime/stream")) {
        const open: StreamOpen = { at: Date.now() };
        opens.push(open);
        init?.signal?.addEventListener("abort", () => {
          open.lostAt = Date.now();
        });
      }
      return fetch(input, init);
    };
  });
const streamOpens = (page: Page) =>
  page.evaluate(() => (window as unknown as { streamOpens: StreamOpen[] }).streamOpens);
// Whether the newest stream is lost and waiting for its backoff: the shell aborted it, and the
// ingress saw it close, so no reconnect is in flight.
const newestLost = async (page: Page, instance: Instance) =>
  instance.streamConnections.size === 0 && (await streamOpens(page)).at(-1)?.lostAt !== undefined;
// After n backoff failures in a row the shell waits 500 ms·2ⁿ, jittered down to as little as
// half, so its delay falls in [250·2ⁿ, 500·2ⁿ): step n.
type ReconnectStep = "at once" | number;
const reconnectSteps = async (page: Page) => {
  const opens = await streamOpens(page);
  return opens.slice(1).map((open, index): ReconnectStep => {
    const delay = open.at - (opens[index]?.lostAt ?? Number.NaN);
    return delay === 0 ? "at once" : Math.floor(Math.log2(delay / 250));
  });
};

for (const scenario of [
  {
    refused: "misrouted",
    refusal: refusal(409, "invalid_request"),
    // #776's one immediate reconnect, then the backoff.
    streak: ["at once", 0, 1, 2],
    next: ["at once", 0]
  },
  { refused: "rate limited", refusal: refusal(429, "rate_limited"), streak: [0, 1, 2], next: [0] }
] as const) {
  test(`a stream whose POSTs are all ${scenario.refused} backs off exponentially until it reconciles`, async ({
    page,
    instance
  }) => {
    await page.clock.install();
    await recordStreamOpens(page);
    let refusing = false;
    await page.route("**/api/runtime/subscriptions", (route) =>
      refusing ? route.fulfill(scenario.refusal) : route.continue()
    );
    const frame = await open(page, await instance.publish());
    await expect.poll(() => generations(frame)).toHaveLength(1);
    // Pause ahead of real time; no timer is armed for the reconciled empty set.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
    // Runs out each lost stream's backoff, up to its step's longest delay.
    const reconnect = async (steps: ReadonlyArray<ReconnectStep>) => {
      for (const step of steps) {
        if (step === "at once") continue;
        await expect.poll(() => newestLost(page, instance)).toBe(true);
        await page.clock.runFor(500 * 2 ** step);
      }
    };

    // Each new stream's replace is refused, so none reconciles and the delay keeps doubling.
    refusing = true;
    await subscribeLimit(frame, 1);
    await reconnect(scenario.streak);
    // A stream that admits its replace while its answers are held has not reconciled, so
    // losing it keeps the grown delay.
    await expect.poll(() => newestLost(page, instance)).toBe(true);
    refusing = false;
    instance.holdStreamFrames("answers");
    await reconnect([3]);
    await expect.poll(() => admittedSinceHello(frame)).toBe(true);
    refusing = true;
    await subscribeLimit(frame, 2);
    // Once a stream's answers arrive, it reconciles and the next streak starts over.
    await expect.poll(() => newestLost(page, instance)).toBe(true);
    refusing = false;
    instance.holdStreamFrames(false);
    await reconnect([4]);
    await expect(frame.locator("#rows-1")).toHaveText("0");
    await expect(frame.locator("#rows-2")).toHaveText("0");
    refusing = true;
    await subscribeLimit(frame, 3);
    await reconnect(scenario.next);
    expect(await reconnectSteps(page)).toEqual([...scenario.streak, 3, 4, ...scenario.next]);
    await page.unroute("**/api/runtime/subscriptions");
  });
}

test("a session refresh during a refused streak reconnects at once and keeps the backoff", async ({
  page,
  context,
  instance
}) => {
  await page.clock.install();
  await recordStreamOpens(page);
  let refreshes = 0;
  await installSessionRefreshBoundary(context, () => {
    refreshes++;
    return instance.session(context);
  });
  let refusing = false;
  await page.route("**/api/runtime/subscriptions", (route) =>
    refusing ? route.fulfill(refusal(429, "rate_limited")) : route.continue()
  );
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);

  refusing = true;
  await subscribeLimit(frame, 1);
  await expect.poll(() => newestLost(page, instance)).toBe(true);
  await page.clock.runFor(500);
  await expect.poll(() => newestLost(page, instance)).toBe(true);
  // The next stream open finds a stale token: the refresh reconnects without a timer.
  await instance.session(context, "expired");
  const stale = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/runtime/stream" && response.status() === 401
  );
  await page.clock.runFor(1_000);
  expect(await (await stale).json()).toMatchObject({ code: "session_refresh_required" });
  // The refreshed stream's POSTs are still refused, so its backoff picks up where it was.
  await expect.poll(() => newestLost(page, instance)).toBe(true);
  await page.clock.runFor(2_000);
  expect(await reconnectSteps(page)).toEqual([0, 1, "at once", 2]);
  expect(refreshes).toBe(1);
  await expect(page.locator("[data-notice]")).toHaveCount(0);
  await page.unroute("**/api/runtime/subscriptions");
});
