import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { objectKey, type Entry } from "../../packages/portal/src/updates.js";
import { makeDraft } from "../../scripts/release-notes.mjs";
import { test, expect } from "./fixtures.js";
import type { Instance } from "./instance.js";

// Exercise the real authenticated pages, external script and content-store reader.
// Publication is simulated locally; production deployment is outside this prototype's scope.
const entry = (sequence: number): Entry => ({
  sequence,
  publishedAt: "2026-10-05T12:00:00.000Z",
  title: `Deployment ${sequence}`,
  summary: `Summary ${sequence}`,
  changes: [{ kind: "Improved", title: `Change ${sequence}`, detail: `Details ${sequence}` }]
});
async function publish(instance: Instance, sequences: number[]) {
  await writeHistory(instance, sequences.map(entry));
}
async function writeHistory(instance: Instance, entries: ReadonlyArray<Entry>) {
  const file = join(instance.storageDirectory, objectKey);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify({ version: 1, entries }));
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
async function readBell(page: Page) {
  await openBell(page);
  await expect(page.locator(".latest-update")).toBeVisible();
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — all caught up"
  );
  await page.locator("#updates-bell").click();
  await caughtUp(page);
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

test("draft notes keep understandable copy through shared history, the bell and expanded details", async ({
  page,
  instance
}) => {
  const feature = "b".repeat(40);
  const internal = "c".repeat(40);
  // Hand-authored sample output for contract verification, not a live model-quality evaluation.
  const response = {
    title: "Catch up on what’s new in Patchy",
    summary: "See the latest update from the bell and browse earlier updates in one place.",
    changes: [
      {
        kind: "New",
        title: "Find recent changes",
        detail:
          "Open the bell for a quick summary. Choose View all updates to read the full history.",
        sources: [feature]
      },
      {
        kind: "Improved",
        title: "Read updates at your own pace",
        detail: "Updates appear newest first. Expand any update to see what changed.",
        sources: [feature]
      },
      {
        kind: "Fixed",
        title: "Keep newer updates unread",
        detail:
          "If a new update arrives while you’re reading an older page, it stays in the bell until you open the newer history.",
        sources: [feature]
      }
    ],
    omitted: [{ commit: internal, reason: "internal" }]
  };
  const draft = makeDraft(
    {
      kind: "forward",
      repository: "patchy/local-notes-test",
      from: "a".repeat(40),
      to: internal,
      commits: [
        { sha: feature, message: "feat(portal): notification implementation" },
        { sha: internal, message: "chore: internal telemetry" }
      ]
    },
    response,
    "local-response-file"
  );
  // Serialize the real generator output before the local publication step adds
  // its own sequence/date. No assertion-only copy of the reader schema is used.
  const serialized = JSON.parse(JSON.stringify(draft)) as {
    notes: Pick<Entry, "title" | "summary" | "changes">;
  };
  const deployment = {
    runId: 123,
    attempt: 1,
    commit: feature,
    url: "https://github.com/allisonmahmood/patchy-cloud/actions/runs/123/attempts/1"
  };
  await writeHistory(instance, [{ ...entry(1), ...serialized.notes, deployment }]);
  await page.goto(instance.origin);
  await openBell(page);
  await expect(page.locator(".latest-update h3")).toHaveText(response.title);
  await expect(page.locator(".latest-update p")).toHaveText(response.summary);
  await page.locator(".latest-update").click();
  await expect(page.locator("#update-1")).toHaveAttribute("open");
  await expect(page.locator('a[href*="github.com"]')).toHaveCount(0);
  await expect(page.locator(".update-title")).toHaveText(response.title);
  await expect(page.locator(".update-summary")).toHaveText(response.summary);
  await expect(page.locator(".update-change .pill")).toHaveText(["New", "Improved", "Fixed"]);
  await expect(page.locator(".update-change h2")).toHaveText(
    response.changes.map((change) => change.title)
  );
  await expect(page.locator(".update-change p")).toHaveText(
    response.changes.map((change) => change.detail)
  );
  for (const hidden of [
    feature,
    internal,
    "local-response-file",
    "provenance",
    "internal telemetry",
    "feat(portal)"
  ]) {
    await expect(page.locator(".updates-page")).not.toContainText(hidden);
  }
  await caughtUp(page);
  await capture(page, "readable-draft-notes");
});

test("deployment summaries retain concrete internal-work and initial-release copy", async ({
  page,
  instance
}) => {
  const commit = "b".repeat(40);
  const entries = ["initial", "unchanged", "rollback", "forward"].map((kind, index) => {
    const draft = makeDraft(
      {
        kind,
        repository: "patchy/local-notes-test",
        from: "a".repeat(40),
        to: commit,
        commits: [{ sha: commit }]
      },
      {
        title:
          kind === "initial" ? "Company tools and sharing" : "More complete activity reporting",
        summary:
          kind === "initial"
            ? "Open your company’s tools and choose who can use them."
            : "Patchy now records company membership changes in its internal usage reports.",
        changes: [],
        omitted: [{ commit, reason: "internal" }]
      }
    );
    return { ...entry(index + 1), ...draft.notes };
  });
  await writeHistory(instance, entries);
  await page.goto(instance.origin + "/updates");
  await expect(page.locator(".update-title")).toHaveText([
    "More complete activity reporting",
    "An earlier version has been restored",
    "Platform maintenance",
    "Company tools and sharing"
  ]);
  await expect(page.locator(".update-summary")).toHaveText([
    "Patchy now records company membership changes in its internal usage reports.",
    "Patchy has returned to an earlier release. Recent changes may no longer be available.",
    "This deployment uses the same application version.",
    "Open your company’s tools and choose who can use them."
  ]);
  await expect(page.locator(".update-change")).toHaveCount(0);
  await readBell(page);
});

test("updates arrive while browsing, survive closing an unread tab, and clear when the bell opens", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 2]);
  await page.goto(instance.origin + "/updates");
  await readBell(page);
  await page.goto(instance.origin);
  await caughtUp(page);
  await publish(instance, [1, 2, 3]);
  // No focus, navigation or click: the visible page discovers the simulated deployment.
  await unread(page, 3);
  expect(await marker(page)).toBe("2");
  await page.close();
  const returned = await context.newPage();
  await returned.goto(instance.origin);
  await unread(returned, 3);
  expect(await marker(returned)).toBe("2");
  await openBell(returned);
  await expect.poll(() => marker(returned)).toBe("3");
  await expect(returned.locator("#updates-dot")).toHaveAttribute("hidden");
  await expect(returned.locator(".latest-update h3")).toHaveText("Deployment 3");
  await capture(returned, "read-on-opening-bell");
  await returned.locator("#updates-bell").click();
  await caughtUp(returned);
  await openBell(returned);
  await caughtUp(returned);
  await returned.getByRole("link", { name: "View all updates" }).click();
  await expect(returned.locator(".update-title")).toHaveText([
    "Deployment 3",
    "Deployment 2",
    "Deployment 1"
  ]);
  await returned.close();
  const reopened = await context.newPage();
  await reopened.goto(instance.origin);
  await caughtUp(reopened);
});

test("a deployment arriving while the bell is open stays unread until the bell is reopened", async ({
  page,
  instance
}) => {
  await publish(instance, [1]);
  await page.goto(instance.origin);
  await openBell(page);
  await expect.poll(() => marker(page)).toBe("1");
  await publish(instance, [1, 2]);
  await expect(page.locator("#updates-dot")).not.toHaveAttribute("hidden", { timeout: 10_000 });
  expect(await marker(page)).toBe("1");
  await expect(page.locator(".latest-update h3")).toHaveText("Deployment 1");
  await page.locator("#updates-bell").click();
  await openBell(page);
  await expect.poll(() => marker(page)).toBe("2");
  await expect(page.locator("#updates-dot")).toHaveAttribute("hidden");
});

test("returning to an older history snapshot leaves a newer deployment unread until its link loads it", async ({
  page,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin + "/updates");
  await readBell(page);
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
  await unread(history, 3);
  await unread(page, 3);
  await readBell(history);
  await caughtUp(page); // The real browser storage event updates this untouched tab.

  await publish(instance, [1, 2, 3, 4]);
  const newer = await context.newPage();
  await newer.goto(instance.origin + "/updates");
  await readBell(newer);
  await expect.poll(() => marker(history)).toBe("4");
  await history.evaluate(() => window.dispatchEvent(new Event("focus")));
  await caughtUp(history);
  expect(await marker(history)).toBe("4");
  await expect(history.locator("#update-4")).toHaveCount(0);
});

test("hidden history and returning to a visible history never mark updates read", async ({
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
  expect(await marker(page)).toBeNull();
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
    await readBell(page);
    await publish(instance, [1, 2, 3, 4]);
    await openBell(page);
    await expect(page.locator(".latest-update h3")).toHaveText("Deployment 4");
    await expect(page.locator("#updates-dot")).toHaveAttribute("hidden");
    await page.locator(".latest-update").click();
    await unread(page, 4);
    await readBell(page);
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
  await expect.poll(() => marker(page)).toBe("3");
  await expect(page.locator("#updates-dot")).toHaveAttribute("hidden");
});

test("switching people refuses a stale tab's feed and keeps each person's read marker separate", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin + "/updates");
  await readBell(page);
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

test("reopening or reloading update history stays unread until the bell is opened", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin + "/updates");
  await unread(page, 3);
  expect(await marker(page)).toBeNull();
  await page.reload();
  await unread(page, 3);
  expect(await marker(page)).toBeNull();
  await page.close();
  const returned = await context.newPage();
  await returned.goto(instance.origin + "/updates");
  await unread(returned, 3);
  await returned.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await unread(returned, 3);
  expect(await marker(returned)).toBeNull();
  await capture(returned, "history-reopened-still-unread");
  await readBell(returned);
  expect(await marker(returned)).toBe("3");
  await returned.reload();
  await caughtUp(returned);
});
