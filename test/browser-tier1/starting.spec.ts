import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame } from "@playwright/test";
import { registry } from "../../packages/limits/src/registry.js";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open } from "./fixtures.js";
import type { Instance } from "./instance.js";

// Real server artifacts, Runtime streams and workerd calls. Ingress only delays or drops bytes.
test.skip(({ browserName }) => browserName !== "chromium", "Tier 2 targets Chromium desktop.");

async function publish(instance: Instance) {
  const server = await build({
    stdin: {
      contents: `import { query, mutation, createGuest, t } from "patchy/server";
const add = mutation({ args: { label: t.text() }, result: t.json(), handler: (ctx, args) => ctx.tables.rows.insert(args) });
const list = query({ args: {}, result: t.array(t.text()), handler: async ctx =>
  (await ctx.tables.rows.list({ order: "asc" })).rows.map(row => row.label).sort() });
const size = query({ args: { payload: t.text() }, result: t.number(), handler: (_ctx, args) => args.payload.length });
export default createGuest({ rows: { add, list, size } });`,
      resolveDir: fileURLToPath(new URL("../../packages/patchy", import.meta.url)),
      sourcefile: "starting-server.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    conditions: ["development"]
  });
  return instance.publish(
    "company",
    instance.html,
    undefined,
    {
      tier: 2,
      files: {},
      handlers: {
        "rows.add": {
          kind: "mutation",
          args: { label: { kind: "text" } },
          result: { kind: "json" }
        },
        "rows.list": {
          kind: "query",
          args: {},
          result: { kind: "array", element: { kind: "text" } }
        },
        "rows.size": {
          kind: "query",
          args: { payload: { kind: "text" } },
          result: { kind: "number" }
        }
      }
    },
    { server: server.outputFiles[0]!.text }
  );
}

const reply = (frame: Frame, id: string) =>
  frame.evaluate(
    (id) => (window as unknown as FixtureWindow).harness.replies.find((reply) => reply.id === id),
    id
  );
const calls = (instance: Instance) =>
  instance.runtimeRequests.filter(
    (request) =>
      request.path === "/api/runtime/call" && JSON.parse(request.body).op === "server.call"
  );
async function add(frame: Frame, wire: number, id: string) {
  await frame.evaluate(
    ({ wire, id }) => {
      const key = `${Date.now()}-${btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "")}`;
      (window as unknown as FixtureWindow).harness.raw({
        v: wire,
        id,
        op: "server.call",
        args: { handler: "rows.add", args: { label: id }, mutationKey: key }
      });
    },
    { wire, id }
  );
}

test("starting holds calls before stream bytes, covers first open and resume, and survives a drop", async ({
  page,
  instance
}) => {
  const patch = await publish(instance);
  instance.holdStreamFrames(true);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const frame = await open(page, patch);
  await frame.locator("#pasted-copy").fill("Keep this draft");
  await add(frame, instance.wire, "first-open");
  const cover = page.getByRole("dialog", { name: "Starting your tools" });
  await page.clock.fastForward(1_999);
  await expect(cover).toBeHidden();
  expect(calls(instance)).toEqual([]);
  await page.clock.fastForward(1);
  await expect(cover).toBeVisible();
  await expect(cover.locator(".glyph-sm")).toBeVisible();
  await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
  await expect(cover).toBeFocused();
  for (const key of ["Tab", "Shift+Tab", "Escape"]) {
    await page.keyboard.press(key);
    await expect(cover).toBeVisible();
    await expect(cover).toBeFocused();
  }
  await page.clock.resume();
  instance.pauseStreams(true);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  instance.pauseStreams(false);
  await expect.poll(() => instance.streamConnections.size).toBe(1);
  expect(await reply(frame, "first-open")).toBeUndefined();
  expect(calls(instance)).toEqual([]);
  instance.holdStreamFrames(false);
  await expect
    .poll(() => reply(frame, "first-open"))
    .toMatchObject({ kind: "result", value: { label: "first-open" } });
  await expect(cover).toBeHidden();
  await expect(page.locator("#patch")).toBeFocused();
  expect(calls(instance)).toHaveLength(1);
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1_000)));

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(30_000);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  instance.holdStreamFrames(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await add(frame, instance.wire, "after-resume");
  await page.clock.fastForward(1_999);
  await expect(cover).toBeHidden();
  await page.clock.fastForward(1);
  await expect(cover).toBeVisible();
  await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
  expect(calls(instance)).toHaveLength(1);
  instance.holdStreamFrames(false);
  await expect
    .poll(() => reply(frame, "after-resume"))
    .toMatchObject({ kind: "result", value: { label: "after-resume" } });
  await expect(cover).toBeHidden();
  await expect(frame.locator("#pasted-copy")).toHaveValue("Keep this draft");
  await frame.evaluate(
    (wire) =>
      (window as unknown as FixtureWindow).harness.raw({
        v: wire,
        id: "saved-rows",
        op: "server.call",
        args: { handler: "rows.list", args: {} }
      }),
    instance.wire
  );
  await expect
    .poll(() => reply(frame, "saved-rows"))
    .toMatchObject({ kind: "result", value: ["after-resume", "first-open"] });
});

test("hiding during the initial starting delay keeps the cover closed until two seconds after resume", async ({
  page,
  instance
}) => {
  const patch = await publish(instance);
  instance.holdStreamFrames(true);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const frame = await open(page, patch);
  await add(frame, instance.wire, "held-across-hidden-start");
  const cover = page.getByRole("dialog", { name: "Starting your tools" });
  await page.clock.fastForward(1_000);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(30_000);
  await expect.poll(() => instance.streamConnections.size).toBe(0);
  await expect(cover).toBeHidden();
  expect(await reply(frame, "held-across-hidden-start")).toBeUndefined();
  expect(calls(instance)).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(1_999);
  await expect(cover).toBeHidden();
  await page.clock.fastForward(1);
  await expect(cover).toBeVisible();
  await expect(cover).toBeFocused();
  await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
  await page.clock.resume();
  instance.holdStreamFrames(false);
  await expect
    .poll(() => reply(frame, "held-across-hidden-start"))
    .toMatchObject({
      kind: "result",
      value: { label: "held-across-hidden-start" }
    });
  await expect(cover).toBeHidden();
  expect(calls(instance)).toHaveLength(1);
});

for (const bound of ["outstanding", "heldBytes"] as const) {
  test(`starting counts held calls against frame.${bound}`, async ({ page, instance }) => {
    const patch = await publish(instance);
    instance.holdStreamFrames(true);
    const frame = await open(page, patch);
    const payloadSize = bound === "heldBytes" ? 1_000_000 : 0;
    const count =
      bound === "outstanding"
        ? registry["frame.outstanding"].default + 1
        : Math.ceil(registry["frame.heldBytes"].default / (payloadSize * 3)) + 1;
    await frame.evaluate(
      ({ count, payloadSize, wire }) => {
        const harness = (window as unknown as FixtureWindow).harness;
        for (let index = 0; index < count; index++)
          harness.raw({
            v: wire,
            id: `held-${index}`,
            op: "server.call",
            args: { handler: "rows.size", args: { payload: "x".repeat(payloadSize) } }
          });
      },
      { count, payloadSize, wire: instance.wire }
    );
    await expect
      .poll(() => reply(frame, `held-${count - 1}`))
      .toMatchObject({
        kind: "error",
        error: {
          code: bound === "outstanding" ? "too_many_requests" : "too_large",
          limitId: `frame.${bound}`
        }
      });
    expect(calls(instance)).toEqual([]);
    await page.close();
    instance.holdStreamFrames(false);
    expect(calls(instance)).toEqual([]);
  });
}

test.describe("fleet bind retry", () => {
  const limits = {
    "execution.fleet.budget": 1,
    "execution.pool.spares": 1,
    "execution.pool.wait": 3_000,
    "execution.housekeeping.interval": 250,
    // Fixture shutdown can force-kill a host. Keep the lease expiry inside this test's
    // compressed bind window without changing production crash fencing.
    "execution.housekeeping.lease": 1_000
  };
  test.use({
    serverEnvironment: {
      EXECUTION_PROVIDER: "local-fleet",
      PATCHY_LIMITS_JSON: JSON.stringify(limits)
    }
  });

  test("a full real fleet refuses held calls once, retries automatically and manually, and never replays", async ({
    page,
    context,
    instance
  }) => {
    await page.clock.install();
    const occupied = await publish(instance);
    const blockerPage = await context.newPage();
    const blocker = await open(blockerPage, occupied);
    await blocker.evaluate(
      (wire) =>
        (window as unknown as FixtureWindow).harness.raw({
          v: wire,
          id: "occupied-ready",
          op: "server.call",
          args: { handler: "rows.list", args: {} }
        }),
      instance.wire
    );
    await expect
      .poll(() => reply(blocker, "occupied-ready"))
      .toMatchObject({
        kind: "result",
        value: []
      });
    await blockerPage.close();
    instance.runtimeRequests.length = 0;
    // Keep the first company's real idle binding. Seed another tenant, not a fleet row.
    await instance.platform.query(
      "INSERT INTO companies (id, handle, name, created_at) VALUES ('cmp_starting', 'starting', 'Starting acceptance', now())"
    );
    await instance.platform.query("UPDATE users SET company_id='cmp_starting' WHERE id='usr_dev'");
    const waiting = await publish(instance);
    const frame = await open(page, waiting);
    await add(frame, instance.wire, "refused-before-ready");
    const cover = page.getByRole("dialog", { name: "Starting your tools" });
    await expect(cover).toBeVisible();
    await expect
      .poll(() => reply(frame, "refused-before-ready"))
      .toMatchObject({
        kind: "error",
        error: {
          code: "busy",
          scope: "company",
          limitId: "execution.pool.wait",
          value: 3_000,
          retryAfter: expect.any(Number)
        }
      });
    await add(frame, instance.wire, "refused-while-failed");
    await expect
      .poll(() => reply(frame, "refused-while-failed"))
      .toMatchObject({
        kind: "error",
        error: {
          code: "busy",
          scope: "company",
          limitId: "execution.pool.wait",
          value: 3_000,
          retryAfter: expect.any(Number)
        }
      });
    expect(calls(instance)).toEqual([]);
    const attempts = () =>
      instance.runtimeRequests.filter(
        (request) =>
          request.path.startsWith("/api/runtime/stream?") && request.path.includes(waiting.patchId)
      ).length;
    await expect.poll(attempts).toBeGreaterThan(1);
    const retry = cover.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(retry).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(retry).toBeFocused();
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 100)));
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.fastForward(30_000);
    await expect.poll(() => instance.streamConnections.size).toBe(0);
    await expect(cover).toBeHidden();
    instance.holdStreamFrames(true);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.fastForward(1_999);
    await expect(cover).toBeHidden();
    await page.clock.fastForward(1);
    await expect(cover).toBeVisible();
    await expect(cover).toBeFocused();
    await expect(page.locator('[data-stream-status="reconnecting"]')).toBeHidden();
    instance.holdStreamFrames(false);
    await expect(retry).toBeVisible();
    await page.clock.resume();
    const beforeRetry = attempts();
    await retry.click();
    await expect.poll(attempts).toBeGreaterThan(beforeRetry);
    expect(calls(instance)).toEqual([]);
    // A deployment with room for a second task lets the real controller bind this company.
    await instance.restart({
      PATCHY_LIMITS_JSON: JSON.stringify({ ...limits, "execution.fleet.budget": 2 })
    });
    await expect(cover).toBeHidden();
    await add(frame, instance.wire, "new-after-ready");
    await expect
      .poll(() => reply(frame, "new-after-ready"))
      .toMatchObject({
        kind: "result",
        value: { label: "new-after-ready" }
      });
    expect(calls(instance)).toHaveLength(1);
    expect(
      await frame.evaluate(() =>
        (window as unknown as FixtureWindow).harness.replies.filter(
          (reply) => reply.id === "refused-before-ready" || reply.id === "refused-while-failed"
        )
      )
    ).toHaveLength(2);
    await frame.evaluate(
      (wire) =>
        (window as unknown as FixtureWindow).harness.raw({
          v: wire,
          id: "only-new-write",
          op: "server.call",
          args: { handler: "rows.list", args: {} }
        }),
      instance.wire
    );
    await expect
      .poll(() => reply(frame, "only-new-write"))
      .toMatchObject({
        kind: "result",
        value: ["new-after-ready"]
      });
  });
});
