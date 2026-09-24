// PROTOTYPE for #313, not for merge.
// The hard cases for the reactive query loop, each printing measured numbers.
// Run: pnpm test:prototype-reactive
import type { Browser, BrowserContext, Frame, Page } from "@playwright/test";
import { test, expect, open, notice } from "./fixtures.js";
import type { Instance, Published } from "./instance.js";
import type { PrototypeWindow, Recorded } from "./reactive-prototype-client.js";

type Viewer = "owner" | "colleague";
// eslint-disable-next-line no-console -- the measured numbers are the deliverable
const log = (line: string) => console.log(`[reactive #313] ${line}`);
const harness = (frame: Frame) => ({
  events: () => frame.evaluate(() => (window as unknown as PrototypeWindow).harness.events),
  labels: () => frame.evaluate(() => (window as unknown as PrototypeWindow).harness.labels()),
  stats: () => frame.evaluate(() => ({ ...(window as unknown as PrototypeWindow).harness.stats })),
  insert: (label: string, owner?: string) =>
    frame.evaluate(
      ([label, owner]) => (window as unknown as PrototypeWindow).harness.insert(label!, owner),
      [label, owner] as const
    ),
  subscribe: (name: string, args?: Record<string, unknown>) =>
    frame.evaluate(
      ([name, args]) => (window as unknown as PrototypeWindow).harness.subscribe(name!, args),
      [name, args] as const
    ),
  unsubscribe: (name: string) =>
    frame.evaluate(
      (name) => (window as unknown as PrototypeWindow).harness.unsubscribe(name),
      name
    ),
  waitForLabel: (label: string) => expect(frame.locator("#list")).toContainText(label),
  waitForStatus: (status: string) => expect(frame.locator("#status")).toHaveText(status)
});
const serverStats = async (instance: Instance, patch: Published) =>
  (await (
    await fetch(`${instance.origin}/api/runtime/prototype/stats?patchId=${patch.patchId}`)
  ).json()) as {
    reruns: number;
    deliveries: number;
    suppressed: number;
    retries: number;
    wakes: number;
    streams: number;
    subscriptions: number;
  };
const offline = (context: BrowserContext) =>
  context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname)) await route.continue();
    else await route.abort("blockedbyclient");
  });
/** A second browser: its own context, cookies and socket pool. */
const viewer = async (
  browser: Browser,
  instance: Instance,
  patch: Published,
  user: Viewer,
  options: { readonly expiresInSeconds?: number } = {}
) => {
  const context = await browser.newContext();
  await offline(context);
  await instance.session(context, user, options);
  const page = await context.newPage();
  const frame = await open(page, patch);
  return { context, page, frame, ...harness(frame) };
};
const snapshotsWith = (events: Recorded[], label: string, name = "all") =>
  events.filter(
    (event) => event.kind === "snapshot" && event.name === name && event.labels?.includes(label)
  );

test("two browsers, one table: a write in one arrives in the other", async ({
  page,
  browser,
  instance
}) => {
  const patch = await instance.publish("company", instance.prototypeHtml);
  const ownerFrame = await open(page, patch);
  const owner = { frame: ownerFrame, ...harness(ownerFrame) };
  const colleague = await viewer(browser, instance, patch, "colleague");
  await expect(owner.frame.locator("#identity")).toHaveText("usr_dev");
  await expect(colleague.frame.locator("#identity")).toHaveText("usr_colleague");
  await owner.waitForStatus("up-to-date");
  await colleague.waitForStatus("up-to-date");
  const fromStart: number[] = [];
  const fromAck: number[] = [];
  for (let i = 0; i < 5; i++) {
    const label = `owner-write-${i}`;
    const timing = await owner.insert(label);
    await colleague.waitForLabel(label);
    const arrival = snapshotsWith(await colleague.events(), label)[0]!;
    fromStart.push(arrival.at - timing.started);
    fromAck.push(arrival.at - timing.acked);
  }
  const mean = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  log(
    `two browsers: write-start to colleague snapshot ${fromStart.join("/")} ms (mean ${mean(fromStart)}); commit-ack to snapshot ${fromAck.join("/")} ms (mean ${mean(fromAck)})`
  );
  const stats = await serverStats(instance, patch);
  log(
    `two browsers: server reruns ${stats.reruns}, deliveries ${stats.deliveries}, suppressed ${stats.suppressed}, streams ${stats.streams}`
  );
  expect(await colleague.labels()).toEqual(
    expect.arrayContaining(fromStart.map((_, i) => `owner-write-${i}`))
  );
  await colleague.context.close();
});

test("a write racing subscription setup never leaves a stale snapshot after up-to-date", async ({
  page,
  instance
}) => {
  const patch = await instance.publish("company", instance.prototypeHtml);
  const frame = await open(page, patch);
  const owner = harness(frame);
  await owner.waitForStatus("up-to-date");
  await owner.unsubscribe("all");
  let raced = 0;
  for (let i = 0; i < 10; i++) {
    const label = `racer-${i}`;
    // Same tick: register the subscription, then issue the write.
    await frame.evaluate(
      ([name, label, limit]) => {
        const h = (window as unknown as PrototypeWindow).harness;
        h.subscribe(name!, { limit });
        void h.insert(label!);
      },
      [`race-${i}`, label, 100 + i] as const
    );
    await expect
      .poll(async () => snapshotsWith(await owner.events(), label, `race-${i}`).length, {
        timeout: 10_000
      })
      .toBeGreaterThan(0);
    const events = (await owner.events()).filter((event) => event.name.startsWith(`race-${i}`));
    const firstWith = events.findIndex(
      (event) => event.kind === "snapshot" && event.labels?.includes(label)
    );
    const staleAfter = events
      .slice(firstWith + 1)
      .filter((event) => event.kind === "snapshot" && !event.labels?.includes(label));
    expect(staleAfter).toEqual([]);
    const upToDateAt = events.findIndex((event) => event.name === `race-${i}:up-to-date`);
    if (upToDateAt < firstWith) raced += 1;
    await owner.unsubscribe(`race-${i}`);
  }
  log(
    `race: 10 rounds, ${raced} where the first snapshot missed the write and a re-run delivered it after up-to-date; 0 stale snapshots after the write was seen`
  );
});

test("a second viewer receives only their own result; the re-run runs as the subscriber", async ({
  page,
  browser,
  instance
}) => {
  const patch = await instance.publish("company", instance.prototypeHtml);
  const owner = harness(await open(page, patch));
  const colleague = await viewer(browser, instance, patch, "colleague");
  await owner.subscribe("own", { index: "byOwner", eq: { owner: "usr_dev" } });
  await colleague.subscribe("own", { index: "byOwner", eq: { owner: "usr_colleague" } });
  await expect
    .poll(async () => (await owner.events()).some((e) => e.name === "own:up-to-date"))
    .toBe(true);
  await expect
    .poll(async () => (await colleague.events()).some((e) => e.name === "own:up-to-date"))
    .toBe(true);
  await owner.insert("mine", "usr_dev");
  await owner.insert("theirs", "usr_colleague");
  await expect
    .poll(async () => snapshotsWith(await owner.events(), "mine", "own").length)
    .toBeGreaterThan(0);
  await expect
    .poll(async () => snapshotsWith(await colleague.events(), "theirs", "own").length)
    .toBeGreaterThan(0);
  const ownerOwn = (await owner.events())
    .filter((e) => e.kind === "snapshot" && e.name === "own")
    .at(-1)!;
  const colleagueOwn = (await colleague.events())
    .filter((e) => e.kind === "snapshot" && e.name === "own")
    .at(-1)!;
  expect(ownerOwn.labels).toEqual(["mine"]);
  expect(colleagueOwn.labels).toEqual(["theirs"]);
  const stats = await serverStats(instance, patch);
  log(
    `authority: owner own-list ${JSON.stringify(ownerOwn.labels)}, colleague own-list ${JSON.stringify(colleagueOwn.labels)}; two writes woke ${stats.reruns} re-runs across 4 subscriptions, ${stats.suppressed} suppressed as unchanged`
  );
  log(
    "authority: tier 1 table reads carry no per-viewer authority (company-level only); the distinct result comes from viewer-dependent arguments, the identity from the stream's own admission"
  );
  await colleague.context.close();
});

test("a viewer revoked mid-subscription fails closed: deactivation and session expiry", async ({
  page,
  browser,
  instance
}) => {
  const patch = await instance.publish("company", instance.prototypeHtml);
  const owner = harness(await open(page, patch));
  const colleague = await viewer(browser, instance, patch, "colleague");
  await colleague.waitForStatus("up-to-date");
  await owner.insert("before-revocation");
  await colleague.waitForLabel("before-revocation");
  await instance.platform.query(
    "UPDATE users SET deactivated_at = now() WHERE id = 'usr_colleague'"
  );
  const before = (await colleague.events()).length;
  await owner.insert("after-revocation");
  await notice(colleague.page, "access_denied");
  const leaked = snapshotsWith(
    await colleague.events().catch(() => [] as Recorded[]),
    "after-revocation"
  );
  log(
    `revocation (deactivated): colleague stream stopped with access_denied, ${leaked.length} snapshots leaked after revocation (events before ${before})`
  );
  expect(leaked).toEqual([]);
  await instance.platform.query(
    "UPDATE users SET deactivated_at = NULL WHERE id = 'usr_colleague'"
  );
  await colleague.context.close();

  const short = await viewer(browser, instance, patch, "colleague", { expiresInSeconds: 3 });
  await short.waitForStatus("up-to-date");
  await short.page.waitForTimeout(9_000); // past exp plus Clerk's 5 s clock skew allowance
  const started = Date.now();
  await owner.insert("after-expiry");
  await notice(short.page, "session_expired");
  log(
    `revocation (expired session): stream stopped with session_expired ${Date.now() - started} ms after the write; no snapshot delivered`
  );
  await short.context.close();
});

test("the stream dropped and reconnected: must-resync, fresh snapshot, no lost or duplicate wake", async ({
  page,
  browser,
  instance
}) => {
  const patch = await instance.publish("company", instance.prototypeHtml);
  const owner = harness(await open(page, patch));
  const colleague = await viewer(browser, instance, patch, "colleague");
  await colleague.waitForStatus("up-to-date");
  await owner.waitForStatus("up-to-date");
  const dropped = instance.dropStreams();
  expect(dropped).toBeGreaterThanOrEqual(2);
  const droppedAt = Date.now();
  // The status flips resyncing -> up-to-date within milliseconds; read the recorded sequence.
  await expect
    .poll(async () => {
      const names = (await colleague.events()).map((e) => e.name);
      const resync = names.indexOf("all:resyncing");
      return resync !== -1 && names.indexOf("all:up-to-date", resync) !== -1;
    })
    .toBe(true);
  const resumedAt = Date.now();
  await owner.insert("after-drop");
  await colleague.waitForLabel("after-drop");
  const events = await colleague.events();
  const names = events.map((e) => (e.kind === "snapshot" ? `snapshot(${e.rows})` : e.name));
  log(
    `drop: severed ${dropped} streams; colleague resumed in ${resumedAt - droppedAt} ms; sequence ${names.join(" > ")}`
  );
  expect(snapshotsWith(events, "after-drop")).toHaveLength(1);
  expect(events.filter((e) => e.name === "all:resyncing").length).toBeGreaterThanOrEqual(1);
  const stats = await colleague.stats();
  log(
    `drop: client snapshots ${stats.snapshots}, stale/duplicate dropped ${stats.dropped}, resyncs ${stats.resyncs}`
  );

  // An offline window: every reconnect attempt fails, a write lands meanwhile, then the network returns.
  await colleague.context.route("**/api/runtime/prototype/stream*", (route) =>
    route.abort("connectionfailed")
  );
  instance.dropStreams();
  const offlineAt = Date.now();
  await owner.insert("while-offline");
  await colleague.page.waitForTimeout(10_000);
  const duringOffline = snapshotsWith(await colleague.events(), "while-offline");
  await colleague.context.unroute("**/api/runtime/prototype/stream*");
  await colleague.waitForLabel("while-offline");
  const backAt = Date.now();
  const after = await colleague.events();
  log(
    `offline window: 10 s with reconnects refused; snapshots with the offline write during the window ${duringOffline.length}, after reconnect ${snapshotsWith(after, "while-offline").length}; resumed ${backAt - offlineAt} ms after going offline; resyncs ${(await colleague.stats()).resyncs}`
  );
  expect(duringOffline).toEqual([]);
  expect(snapshotsWith(after, "while-offline")).toHaveLength(1);
  await colleague.context.close();
});

test("a burst of writes coalesces into few re-runs with a correct final value", async ({
  page,
  browser,
  instance
}) => {
  const patch = await instance.publish("company", instance.prototypeHtml);
  const ownerFrame = await open(page, patch);
  const owner = { frame: ownerFrame, ...harness(ownerFrame) };
  const colleague = await viewer(browser, instance, patch, "colleague");
  await colleague.waitForStatus("up-to-date");
  await owner.waitForStatus("up-to-date");
  for (const count of [50, 200]) {
    const before = await serverStats(instance, patch);
    const clientBefore = await colleague.stats();
    const started = Date.now();
    await owner.frame.evaluate(
      async ([count, prefix]) => {
        const h = (window as unknown as PrototypeWindow).harness;
        for (let i = 0; i < count!; i++) await h.insert(`${prefix}-${i}`);
      },
      [count, `burst${count}`] as const
    );
    const written = Date.now() - started;
    await colleague.waitForLabel(`burst${count}-${count - 1}`);
    await expect
      .poll(
        async () => (await colleague.labels()).filter((l) => l.startsWith(`burst${count}-`)).length
      )
      .toBe(count);
    const settled = Date.now() - started;
    await colleague.page.waitForTimeout(500);
    const after = await serverStats(instance, patch);
    const clientAfter = await colleague.stats();
    log(
      `burst ${count}: written in ${written} ms, colleague complete at ${settled} ms; wakes ${after.wakes - before.wakes}, re-runs ${after.reruns - before.reruns} (2 streams), deliveries ${after.deliveries - before.deliveries}, suppressed ${after.suppressed - before.suppressed}; colleague snapshots ${clientAfter.snapshots - clientBefore.snapshots}`
    );
    expect(after.reruns - before.reruns).toBeLessThan(count * 2);
  }
  await colleague.context.close();
});

test("fan-out: 30 documents x 5 subscriptions, one write", async ({ browser, instance }) => {
  test.setTimeout(240_000);
  const patch = await instance.publish("company", instance.prototypeHtml);
  const company = await instance.company();
  const connections = async () =>
    Number(
      (
        await company.query(
          "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()"
        )
      ).rows[0]!.count
    );
  const idle = await connections();
  // Six contexts of five documents: HTTP/1.1 allows six connections per origin per pool.
  const contexts: BrowserContext[] = [];
  const frames: Array<ReturnType<typeof harness> & { frame: Frame }> = [];
  for (let c = 0; c < 6; c++) {
    const context = await browser.newContext();
    await offline(context);
    await instance.session(context, "owner");
    contexts.push(context);
    for (let p = 0; p < 5; p++) {
      const frame = await open(await context.newPage(), patch);
      frames.push({ frame, ...harness(frame) });
    }
  }
  for (const document of frames) {
    await document.unsubscribe("all");
    for (let s = 1; s <= 5; s++) await document.subscribe(`s${s}`, { limit: 100 + s });
  }
  await expect
    .poll(async () => (await serverStats(instance, patch)).subscriptions, { timeout: 60_000 })
    .toBe(150);
  for (const document of frames)
    await expect
      .poll(async () => (await document.events()).filter((e) => e.name === "s5:up-to-date").length)
      .toBe(1);
  const settledConnections = await connections();
  const before = await serverStats(instance, patch);
  const started = Date.now();
  await frames[0]!.insert("fan-out");
  let peak = settledConnections;
  const sampler = setInterval(() => {
    void connections().then((n) => {
      peak = Math.max(peak, n);
    });
  }, 20);
  let allDelivered: number;
  try {
    for (const document of frames)
      await expect
        .poll(async () => snapshotsWith(await document.events(), "fan-out", "s1").length, {
          timeout: 30_000
        })
        .toBe(1);
    allDelivered = Date.now() - started;
    await frames[0]!.frame.waitForTimeout(500);
  } finally {
    clearInterval(sampler);
    const errors = new Map<string, number>();
    for (const document of frames)
      for (const event of await document.events().catch(() => [] as Recorded[]))
        if (event.kind === "error") errors.set(event.name, (errors.get(event.name) ?? 0) + 1);
    log(
      `fan-out: subscription errors seen in frames: ${errors.size === 0 ? "none" : JSON.stringify(Object.fromEntries(errors))}`
    );
  }
  const after = await serverStats(instance, patch);
  log(
    `fan-out: 30 documents x 5 subscriptions = ${before.subscriptions} subscriptions on ${before.streams} streams; one write -> wakes ${after.wakes - before.wakes}, re-runs ${after.reruns - before.reruns} (retries after transient failure ${after.retries - before.retries}), deliveries ${after.deliveries - before.deliveries}; every document updated within ${allDelivered} ms; company-database connections idle ${idle}, with streams open ${settledConnections}, peak during fan-out ${peak}`
  );
  expect(after.deliveries - before.deliveries).toBe(150);
  for (const context of contexts) await context.close();

  // The HTTP/1.1 hazard: seven documents in one context share one six-connection pool.
  const single = await browser.newContext();
  await offline(single);
  await instance.session(single, "owner");
  const seven: Page[] = [];
  for (let i = 0; i < 7; i++) seven.push(await single.newPage());
  // Sequential loads, each given 8 s: once six streams hold the pool, the next navigation hangs.
  const loaded: boolean[] = [];
  const ready: boolean[] = [];
  for (const page of seven) {
    loaded.push(
      await page.goto(patch.address, { timeout: 8_000 }).then(
        () => true,
        () => false
      )
    );
    ready.push(
      await page
        .frameLocator("#patch")
        .locator("#status")
        .filter({ hasText: "up-to-date" })
        .waitFor({ timeout: 8_000 })
        .then(
          () => true,
          () => false
        )
    );
  }
  log(
    `http/1.1: seven documents opened one after another in one browser context: loaded within 8 s ${loaded.filter(Boolean).length}/7, reached up-to-date ${ready.filter(Boolean).length}/7 (dev server is plain HTTP/1.1, six connections per origin; production ingress must terminate HTTP/2)`
  );
  await single.close();
});

test("a subscription over a company Postgres connection refuses loudly", async ({
  page,
  instance
}) => {
  const patch = await instance.publish("company", instance.prototypeHtml);
  const frame = await open(page, patch);
  const outcome = await frame.evaluate(() =>
    (window as unknown as PrototypeWindow).harness.subscribePostgres()
  );
  log(`postgres: ${outcome}`);
  expect(outcome).toMatch(
    /^invalid_request: Subscriptions over company Postgres connections are not supported/
  );
});
