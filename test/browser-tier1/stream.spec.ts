import type { Frame } from "@playwright/test";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open, notice } from "./fixtures.js";

test.use({ tls: true, ignoreHTTPSErrors: true });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Stream acceptance targets Chromium desktop."
);

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
  // Re-announcing the same served version is not a new publish.
  await instance.lifecycle(patch.patchId, "rollback", 2);
  await expect
    .poll(() =>
      frame.evaluate(
        () =>
          (window as unknown as FixtureWindow).harness.replies.filter(
            (reply) => reply.event === "stream" && reply.data?.type === "served"
          ).length
      )
    )
    .toBe(3);
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

test("an idle session expiry stops the document without a runtime operation", async ({
  page,
  context,
  instance
}) => {
  // Clerk allows five seconds of clock skew; the stream checks at five-second intervals.
  await instance.session(context, "owner", 2);
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  const calls = instance.runtimeRequests.filter(
    (request) => request.path === "/api/runtime/call"
  ).length;
  await notice(page, "session_expired");
  expect(
    instance.runtimeRequests.filter((request) => request.path === "/api/runtime/call")
  ).toHaveLength(calls);
});

test("a refreshed browser token re-admits the idle stream without stopping its document", async ({
  page,
  context,
  instance
}) => {
  await instance.session(context, "owner", 2);
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await frame.locator("#pasted-copy").fill("Editing through token refresh");
  await instance.session(context);
  await expect.poll(async () => (await generations(frame)).length).toBeGreaterThan(1);
  await expect(frame.locator("#pasted-copy")).toHaveValue("Editing through token refresh");
  await expect(page.locator("[data-notice]")).toHaveCount(0);
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

test("a cut ingress stream delays its reconnect pill and clears it on re-admission", async ({
  page,
  instance
}) => {
  const frame = await open(page, await instance.publish());
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await frame.locator("#pasted-copy").fill("Keep the disconnected draft");
  const pill = page.locator('[data-stream-status="reconnecting"]');
  instance.pauseStreams(true);
  await expect(pill).toBeHidden();
  await expect(pill).toBeVisible();
  instance.pauseStreams(false);
  await expect.poll(async () => (await generations(frame)).length).toBe(2);
  await expect(pill).toBeHidden();
  await expect(frame.locator("#pasted-copy")).toHaveValue("Keep the disconnected draft");
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

test("re-admission stops a document whose loaded version was revoked while disconnected", async ({
  page,
  instance
}) => {
  const patch = await instance.publish();
  const frame = await open(page, patch);
  await expect.poll(() => generations(frame)).toHaveLength(1);
  await instance.publish("company", instance.html, patch.patchId);
  // Seed durable revocation while restarting. The service suite covers the same-host notification.
  await instance.platform.query("UPDATE patch_versions SET revoked_at = now() WHERE id = $1", [
    patch.versionId
  ]);
  await instance.restart();
  await notice(page, "revoked");
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
  const streamResponses: Array<{ protocol: string; status: number }> = [];
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

test("public documents do not open a company stream", async ({ page, instance }) => {
  const patch = await instance.publish("public");
  const before = instance.runtimeRequests.length;
  await open(page, patch);
  expect(
    instance.runtimeRequests
      .slice(before)
      .filter((request) => request.path.startsWith("/api/runtime/stream"))
  ).toEqual([]);
});
