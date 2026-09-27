// PROTOTYPE for #315: the boundary proofs (brief step 11) against a tiny fixture consumer, owner
// and colleague in two browser contexts on an isolated offline instance. Each proof records its
// numbers into .local/prototype-crm-results/numbers.json.
import { mkdir, writeFile } from "node:fs/promises";
import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page
} from "@playwright/test";
import { buildPatch, type Built } from "./build.js";
import {
  HIDDEN_GRACE_MS,
  startInstance,
  type Instance,
  type Published,
  type User
} from "./instance.js";

type Harness = Record<string, (...args: never[]) => Promise<unknown>> & {
  ready: boolean;
  state: Record<
    string,
    { at: number; data?: unknown; error?: string; status?: string } & Record<string, unknown>
  >;
};
type Win = Window & { harness: Harness };
const numbers: Record<string, unknown> = {};
const record = (key: string, value: unknown) => {
  numbers[key] = value;
  console.log(`[numbers] ${key}: ${JSON.stringify(value)}`);
};

const test = base.extend<object, { instance: Instance }>({
  instance: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const instance = await startInstance();
      try {
        await use(instance);
      } finally {
        await instance.close();
      }
    },
    { scope: "worker", timeout: 180_000 }
  ]
});
test.describe.configure({ mode: "serial" });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const pdf = (text: string) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\ntrailer << /Root 1 0 R >>\n%%EOF\n`
  );

let contracts: Published;
let crm: Published;
let crmTwo: Published;
let built: { contracts: Built; crm: Built };
let owner: { context: BrowserContext; page: Page; frame: Frame };
let colleague: { context: BrowserContext; page: Page; frame: Frame };
let dealId: string;

const manifest = (instance: Instance, extra: Record<string, unknown>) => ({
  manifestVersion: 1,
  release: instance.release,
  tier: 2,
  tables: {},
  files: {},
  uses: {},
  ...extra
});
const contractsManifest = (instance: Instance, shared: boolean) =>
  manifest(instance, {
    name: "contracts",
    files: {
      documents: { description: "Signed customer contracts and their thumbnails.", shared }
    },
    handlers: built.contracts.handlers
  });
const crmManifest = (instance: Instance, name: string) =>
  manifest(instance, {
    name,
    tables: {
      deals: {
        description: "Deals in the pipeline.",
        columns: {
          title: { kind: "text" },
          stage: { kind: "text" },
          private: { kind: "boolean" },
          ownerId: { kind: "text" }
        },
        indexes: {}
      },
      attachments: {
        description: "Files attached to deals.",
        columns: { dealId: { kind: "text" }, name: { kind: "text" }, ownerId: { kind: "text" } },
        indexes: { byDeal: { columns: ["dealId"] } }
      }
    },
    files: { dealFiles: { description: "Deal attachments, named <dealId>/<file>." } },
    uses: {
      contracts: {
        kind: "sharedStore",
        patchId: contracts.patchId,
        store: "documents",
        id: `${contracts.patchId}/documents`,
        revision: contracts.schemaRevision
      }
    },
    handlers: built.crm.handlers
  });

async function open(browser: Browser, instance: Instance, user: User, patch: Published) {
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort("blockedbyclient")
  );
  await instance.session(context, user);
  const page = await context.newPage();
  page.on("console", (message) => console.log(`[${user} console] ${message.text()}`));
  expect((await page.goto(patch.address))?.status()).toBe(200);
  let frame: Frame | undefined;
  await expect
    .poll(async () => {
      frame = page.frames().find((candidate) => candidate.url().includes("/~content/"));
      return frame === undefined
        ? false
        : await frame
            .evaluate(() => (window as unknown as Win).harness?.ready === true)
            .catch(() => false);
    })
    .toBe(true);
  return { context, page, frame: frame! };
}
const call = <T>(frame: Frame, method: string, ...args: unknown[]) =>
  frame.evaluate(
    ([name, values]) => (window as unknown as Win).harness[name as string]!(...(values as never[])),
    [method, args] as const
  ) as Promise<T>;
const state = (frame: Frame, key: string) =>
  frame.evaluate((name) => (window as unknown as Win).harness.state[name] ?? null, key);
/** Milliseconds from `since` (the frame's performance clock) until `check` holds on a state key. */
async function until(
  frame: Frame,
  key: string,
  check: (value: { at: number } & Record<string, unknown>) => boolean,
  timeout = 15_000
) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = (await state(frame, key)) as ({ at: number } & Record<string, unknown>) | null;
    if (value !== null && check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `${key} did not reach the expected state; last ${JSON.stringify(await state(frame, key))}`
  );
}
const now = (frame: Frame) => frame.evaluate(() => performance.now());
type ContractEntry = { name: string; handle: string };
const contractsOf = (value: { data?: unknown }) => (value.data ?? []) as ContractEntry[];

test.beforeAll(async ({ browser, instance }) => {
  test.setTimeout(180_000);
  built = {
    contracts: await buildPatch("contracts", "Contracts"),
    crm: await buildPatch("crm", "CRM fixture")
  };
  const created = await instance.publish({
    manifest: contractsManifest(instance, true),
    html: built.contracts.html,
    server: built.contracts.server
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  contracts = created.body;
  // The source's owner uploads two documents through its own page and action.
  const source = await open(browser, instance, "owner", contracts);
  await call(
    source.frame,
    "replace",
    "acme.pdf",
    pdf("acme v1").toString("base64"),
    "application/pdf"
  );
  await call(source.frame, "replace", "acme.png", PNG.toString("base64"), "image/png");
  await source.context.close();
  for (const name of ["crm", "crm-two"]) {
    const published = await instance.publish({
      manifest: crmManifest(instance, name),
      html: built.crm.html,
      server: built.crm.server
    });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    if (name === "crm") crm = published.body;
    else crmTwo = published.body;
  }
  owner = await open(browser, instance, "owner", crm);
  colleague = await open(browser, instance, "colleague", crm);
});

test.afterAll(async () => {
  await owner?.context.close();
  await colleague?.context.close();
  await mkdir(".local/prototype-crm-results", { recursive: true });
  await writeFile(".local/prototype-crm-results/numbers.json", JSON.stringify(numbers, null, 2));
});

test("step 5: a subscribed query filtered by ctx.viewer delivers each viewer its own rows", async ({
  instance
}) => {
  await until(owner.frame, "pipeline", (value) => value.status === "up-to-date");
  await until(colleague.frame, "pipeline", (value) => value.status === "up-to-date");
  const before = await instance.stats(crm.patchId);
  const t0 = await now(colleague.frame);
  const secret = await call<string>(owner.frame, "create", "Owner secret", "lead", true);
  const ownerSees = await until(owner.frame, "pipeline", (value) =>
    ((value.data ?? []) as Array<{ id: string }>).some((deal) => deal.id === secret)
  );
  const t1 = await now(colleague.frame);
  dealId = await call<string>(colleague.frame, "create", "Team deal", "lead", false);
  const colleagueSees = await until(colleague.frame, "pipeline", (value) =>
    ((value.data ?? []) as Array<{ id: string }>).some((deal) => deal.id === dealId)
  );
  const ownerSeesTeam = await until(owner.frame, "pipeline", (value) =>
    ((value.data ?? []) as Array<{ id: string }>).some((deal) => deal.id === dealId)
  );
  // The colleague's re-run after the owner's private write delivered nothing new to it.
  const colleagueRows = (colleagueSees.data ?? []) as Array<{ id: string; title: string }>;
  expect(colleagueRows.map((deal) => deal.title)).toEqual(["Team deal"]);
  const ownerRows = (ownerSeesTeam.data ?? []) as Array<{ id: string; title: string }>;
  expect(ownerRows.map((deal) => deal.title).sort()).toEqual(["Owner secret", "Team deal"]);
  // The page cannot bypass the patch's filter: a tier 2 page has no table operations.
  const direct = await colleague.frame.evaluate(async () => {
    try {
      await (window as unknown as Win).harness.pipeline();
      return "server ok";
    } catch (error) {
      return String(error);
    }
  });
  expect(direct).toBe("server ok");
  const after = await instance.stats(crm.patchId);
  record("step5", {
    ownerPrivateWriteToOwnSnapshotMs: Math.round((ownerSees.at as number) - t0),
    colleagueWriteToColleagueSnapshotMs: Math.round((colleagueSees.at as number) - t1),
    colleagueWriteToOwnerSnapshotMs: Math.round((ownerSeesTeam.at as number) - t1),
    reruns: (after.reruns ?? 0) - (before.reruns ?? 0),
    deliveries: (after.deliveries ?? 0) - (before.deliveries ?? 0),
    suppressed: (after.suppressed ?? 0) - (before.suppressed ?? 0),
    colleagueRows: colleagueRows.length,
    ownerRows: ownerRows.length
  });
});

test("step 5: a tier 2 page cannot call a primitive directly", async () => {
  const tables = (await call(colleague.frame, "raw", "tables.list", { table: "deals" })) as {
    ok: boolean;
    code: string;
  };
  const files = (await call(colleague.frame, "raw", "files.list", { store: "dealFiles" })) as {
    ok: boolean;
    code: string;
  };
  expect(tables).toMatchObject({ ok: false, code: "invalid_request" });
  expect(files).toMatchObject({ ok: false, code: "invalid_request" });
  record("tierGate", { tablesList: tables.code, filesList: files.code });
});

test("step 3: a staged upload is adopted once by an action, which sees the measured size", async () => {
  const bytes = Buffer.from("not really a png, but the page claims it is");
  const started = Date.now();
  const attached = (await call(
    owner.frame,
    "attach",
    dealId,
    "claim.png",
    bytes.toString("base64"),
    "image/png",
    false
  )) as {
    ok: boolean;
    value: {
      recorded: boolean;
      measured: number;
      claimed: string;
      stored: { size: number; handle: string };
    };
    file: unknown;
  };
  // Only the deal's owner records; the colleague created this deal, so the owner cannot.
  expect(attached.ok).toBe(true);
  expect(attached.value.measured).toBe(bytes.byteLength);
  expect(attached.value.claimed).toBe("image/png");
  expect(attached.value.recorded).toBe(false);
  // The same Upload again: single-use.
  const again = (await call(owner.frame, "actionWith", attached.file)) as {
    ok: boolean;
    code: string;
  };
  expect(again).toEqual({ ok: false, code: "not_found" });
  // Another viewer cannot adopt the owner's staged upload either.
  const staged = await call(
    owner.frame,
    "stage",
    Buffer.from("x").toString("base64"),
    "text/plain"
  );
  const foreign = (await call(colleague.frame, "actionWith", staged)) as {
    ok: boolean;
    code: string;
  };
  expect(foreign).toEqual({ ok: false, code: "not_found" });
  record("step3", {
    stageAndAttachMs: Date.now() - started,
    measured: attached.value.measured,
    claimed: attached.value.claimed,
    reuse: again.code,
    foreignViewer: foreign.code
  });
});

test("step 11: a failed follow-up mutation after an adopted put is presented honestly", async () => {
  const bytes = pdf("proposal");
  const result = (await call(
    colleague.frame,
    "attach",
    dealId,
    "proposal.pdf",
    bytes.toString("base64"),
    "application/pdf",
    true
  )) as {
    ok: boolean;
    value: { recorded: boolean; reason: string; stored: { handle: string; size: number } };
  };
  expect(result.ok).toBe(true);
  expect(result.value.recorded).toBe(false);
  expect(result.value.reason).toBe("record_failed");
  // The file was adopted: it is in the store and its handle redeems, but no record points at it.
  const stored = (await call(colleague.frame, "stored", dealId, "proposal.pdf")) as {
    size: number;
  } | null;
  expect(stored?.size).toBe(bytes.byteLength);
  const listed = (await call(colleague.frame, "attachments", dealId)) as unknown[];
  const redeemed = (await call(colleague.frame, "redeem", result.value.stored.handle)) as {
    ok: boolean;
    size: number;
  };
  expect(redeemed).toMatchObject({ ok: true, size: bytes.byteLength });
  // Retry succeeds and the second viewer sees the committed attachment.
  const retry = (await call(
    colleague.frame,
    "attach",
    dealId,
    "proposal.pdf",
    bytes.toString("base64"),
    "application/pdf",
    false
  )) as { value: { recorded: boolean; stored: { handle: string } } };
  expect(retry.value.recorded).toBe(true);
  const ownerList = (await call(owner.frame, "attachments", dealId)) as Array<{
    name: string;
    handle: string;
  }>;
  expect(ownerList.map((file) => file.name)).toEqual(["proposal.pdf"]);
  const ownerRedeem = (await call(owner.frame, "redeem", ownerList[0]!.handle)) as {
    ok: boolean;
    size: number;
  };
  expect(ownerRedeem).toMatchObject({ ok: true, size: bytes.byteLength });
  // The first attempt's handle names bytes the retry replaced: not_found, not stale bytes.
  const stale = (await call(colleague.frame, "redeem", result.value.stored.handle)) as {
    ok: boolean;
    code: string;
  };
  expect(stale).toMatchObject({ ok: false, code: "not_found" });
  record("partialOutcome", {
    recordedAfterFailure: result.value.recorded,
    reason: result.value.reason,
    storedSize: stored?.size,
    attachmentsListedAfterFailure: listed.length,
    firstHandleAfterRetry: stale.code,
    ownerSeesCommitted: ownerList.length,
    ownerRedeemMs: Math.round((ownerRedeem as { ms?: number }).ms ?? 0)
  });
});

test("step 11: replacing the PDF answers not_found for the old handle and updates the live view", async ({
  browser,
  instance
}) => {
  const initial = await until(colleague.frame, "contracts", (value) =>
    contractsOf(value).some((file) => file.name === "acme.pdf")
  );
  const old = contractsOf(initial).find((file) => file.name === "acme.pdf")!.handle;
  // Handles are per viewer: the owner's page holds its own handle for the same bytes.
  const ownerInitial = await until(owner.frame, "contracts", (value) =>
    contractsOf(value).some((file) => file.name === "acme.pdf")
  );
  const ownerOld = contractsOf(ownerInitial).find((file) => file.name === "acme.pdf")!.handle;
  // Warm the colleague's shell cache for the old handle.
  const warm = (await call(colleague.frame, "redeem", old)) as { ok: boolean; ms: number };
  const cached = (await call(colleague.frame, "redeem", old)) as { ok: boolean; ms: number };
  expect(warm.ok && cached.ok).toBe(true);
  const source = await open(browser, instance, "owner", contracts);
  const t0 = await now(colleague.frame);
  const ownerT0 = await now(owner.frame);
  await call(
    source.frame,
    "replace",
    "acme.pdf",
    pdf("acme v2, countersigned").toString("base64"),
    "application/pdf"
  );
  const updated = await until(colleague.frame, "contracts", (value) => {
    const entry = contractsOf(value).find((file) => file.name === "acme.pdf");
    return entry !== undefined && entry.handle !== old;
  });
  const ownerUpdated = await until(owner.frame, "contracts", (value) => {
    const entry = contractsOf(value).find((file) => file.name === "acme.pdf");
    return entry !== undefined && entry.handle !== ownerOld;
  });
  await source.context.close();
  const next = contractsOf(updated).find((file) => file.name === "acme.pdf")!.handle;
  const oldAfter = (await call(colleague.frame, "redeem", old)) as { ok: boolean; code: string };
  expect(oldAfter).toMatchObject({ ok: false, code: "not_found" });
  const nextAfter = (await call(colleague.frame, "redeem", next)) as { ok: boolean; size: number };
  expect(nextAfter).toMatchObject({ ok: true, size: pdf("acme v2, countersigned").byteLength });
  // The thumbnail kept its handle and still shows.
  await until(colleague.frame, "thumb:acme.png", (value) => typeof value.url === "string");
  record("replace", {
    replaceToColleagueSnapshotMs: Math.round((updated.at as number) - t0),
    replaceToOwnerSnapshotMs: Math.round((ownerUpdated.at as number) - ownerT0),
    firstRedeemMs: Math.round(warm.ms),
    cachedRedeemMs: Math.round(cached.ms),
    oldHandleAfterWarmCache: oldAfter.code,
    newHandle: nextAfter.ok
  });
});

test("step 11: unsharing refuses redemption at once, leaves the consumer's records, and resharing restores", async ({
  instance
}) => {
  const current = await until(
    colleague.frame,
    "contracts",
    (value) => contractsOf(value).length === 2
  );
  const handle = contractsOf(current).find((file) => file.name === "acme.png")!.handle;
  const warm = (await call(colleague.frame, "redeem", handle)) as { ok: boolean };
  expect(warm.ok).toBe(true);
  const address = colleague.page.url();
  // Unshare through the source's publish: refused while a live consumer declares it...
  const refused = await instance.publish({
    patchId: contracts.patchId,
    manifest: contractsManifest(instance, false),
    html: built.contracts.html,
    server: built.contracts.server
  });
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe("has_dependants");
  const t0 = await now(colleague.frame);
  const unshared = await instance.publish({
    patchId: contracts.patchId,
    manifest: contractsManifest(instance, false),
    html: built.contracts.html,
    server: built.contracts.server,
    force: true
  });
  expect(unshared.status, JSON.stringify(unshared.body)).toBe(200);
  // A direct call is refused at once, as the handler's own outcome.
  const direct = await colleague.frame.evaluate(async () => {
    try {
      await (window as unknown as Win).harness.contracts();
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  });
  expect(direct).toBe("access_denied");
  const refusedView = await until(
    colleague.frame,
    "contracts",
    (value) => value.error === "access_denied"
  );
  const ownerRefused = await until(
    owner.frame,
    "contracts",
    (value) => value.error === "access_denied"
  );
  const redeemed = (await call(colleague.frame, "redeem", handle)) as { ok: boolean; code: string };
  expect(redeemed).toMatchObject({ ok: false, code: "access_denied" });
  // The consumer's own records and files are untouched, and the page was not replaced.
  expect(colleague.page.url()).toBe(address);
  const own = (await call(colleague.frame, "attachments", dealId)) as Array<{ handle: string }>;
  expect(own.length).toBe(1);
  const ownRedeem = (await call(colleague.frame, "redeem", own[0]!.handle)) as { ok: boolean };
  expect(ownRedeem.ok).toBe(true);
  const deal = await call<string>(colleague.frame, "create", "After unshare", "won", false);
  await until(colleague.frame, "pipeline", (value) =>
    ((value.data ?? []) as Array<{ id: string }>).some((row) => row.id === deal)
  );
  // Reshare: the same declaration works again with no redeclaration, and so does the handle.
  const t1 = await now(colleague.frame);
  const reshared = await instance.publish({
    patchId: contracts.patchId,
    manifest: contractsManifest(instance, true),
    html: built.contracts.html,
    server: built.contracts.server
  });
  expect(reshared.status, JSON.stringify(reshared.body)).toBe(200);
  const restored = await until(
    colleague.frame,
    "contracts",
    (value) => value.error === undefined && contractsOf(value).length === 2
  );
  const again = (await call(colleague.frame, "redeem", handle)) as { ok: boolean };
  expect(again.ok).toBe(true);
  record("unshare", {
    schemaRevisionUnshared: unshared.body.schemaRevision,
    schemaRevisionReshared: reshared.body.schemaRevision,
    unshareToColleagueRefusalMs: Math.round((refusedView.at as number) - t0),
    ownerRefused: ownerRefused.error,
    warmCacheRedeemAfterUnshare: redeemed.code,
    ownRecordsAfterUnshare: own.length,
    reshareToColleagueSnapshotMs: Math.round((restored.at as number) - t1),
    handleAfterReshare: again.ok,
    pageReplaced: colleague.page.url() !== address
  });
});

test("step 11: a handle tried as another viewer and inside another patch is refused", async ({
  browser,
  instance
}) => {
  const mine = await until(owner.frame, "contracts", (value) => contractsOf(value).length === 2);
  const handle = contractsOf(mine).find((file) => file.name === "acme.pdf")!.handle;
  const self = (await call(owner.frame, "redeem", handle)) as { ok: boolean };
  expect(self.ok).toBe(true);
  const asColleague = (await call(colleague.frame, "redeem", handle)) as {
    ok: boolean;
    code: string;
  };
  expect(asColleague).toMatchObject({ ok: false, code: "access_denied" });
  const other = await open(browser, instance, "owner", crmTwo);
  const inOtherPatch = (await call(other.frame, "redeem", handle)) as { ok: boolean; code: string };
  expect(inOtherPatch).toMatchObject({ ok: false, code: "access_denied" });
  // The same file through the other patch's own selection works: handles differ per patch.
  const theirs = await until(other.frame, "contracts", (value) => contractsOf(value).length === 2);
  const theirHandle = contractsOf(theirs).find((file) => file.name === "acme.pdf")!.handle;
  expect(theirHandle).not.toBe(handle);
  const theirRedeem = (await call(other.frame, "redeem", theirHandle)) as { ok: boolean };
  expect(theirRedeem.ok).toBe(true);
  // Deterministic for the tuple: the colleague's own handle for the file differs from the owner's.
  const colleagueView = await until(
    colleague.frame,
    "contracts",
    (value) => contractsOf(value).length === 2
  );
  expect(contractsOf(colleagueView).find((file) => file.name === "acme.pdf")!.handle).not.toBe(
    handle
  );
  await other.context.close();
  record("foreign", {
    asColleague: asColleague.code,
    inOtherPatch: inOtherPatch.code,
    handleLength: handle.length
  });
});

test("step 6: a hidden document suspends its subscriptions and resumes provisionally", async ({
  browser,
  instance
}) => {
  const watcher = await open(browser, instance, "owner", crm);
  await until(watcher.frame, "pipeline", (value) => value.status === "up-to-date");
  const streamsBefore = (await instance.stats(crm.patchId)).streams ?? 0;
  const hide = (hidden: boolean) =>
    watcher.page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (value ? "hidden" : "visible")
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  const hiddenAt = Date.now();
  await hide(true);
  await until(
    watcher.frame,
    "pipeline",
    (value) => value.status === "suspended",
    HIDDEN_GRACE_MS + 5000
  );
  const suspendedAfter = Date.now() - hiddenAt;
  await expect
    .poll(async () => (await instance.stats(crm.patchId)).streams ?? 0)
    .toBe(streamsBefore - 1);
  const snapshotBefore = await state(watcher.frame, "pipeline");
  const whileHidden = await call<string>(
    colleague.frame,
    "create",
    "Written while hidden",
    "lead",
    false
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stillSuspended = await state(watcher.frame, "pipeline");
  expect(stillSuspended?.at).toBe(snapshotBefore?.at);
  const t0 = await now(watcher.frame);
  await hide(false);
  const resyncing = await until(watcher.frame, "pipeline", (value) => value.status === "resyncing");
  const resumed = await until(watcher.frame, "pipeline", (value) =>
    ((value.data ?? []) as Array<{ id: string }>).some((row) => row.id === whileHidden)
  );
  await until(watcher.frame, "pipeline", (value) => value.status === "up-to-date");
  await watcher.context.close();
  record("hidden", {
    graceMs: HIDDEN_GRACE_MS,
    hiddenToSuspendedMs: suspendedAfter,
    serverStreamsReleased: true,
    visibleToResyncingMs: Math.round((resyncing.at as number) - t0),
    visibleToFreshSnapshotMs: Math.round((resumed.at as number) - t0)
  });
});
