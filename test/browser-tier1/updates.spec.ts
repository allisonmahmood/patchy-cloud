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
const marker = (page: Page, sequence: number) =>
  page.evaluate(
    (sequence) =>
      localStorage.getItem(
        "patchy:updates:read:" +
          document.getElementById("updates-bell")!.dataset.viewerId +
          ":" +
          sequence
      ),
    sequence
  );
async function openBell(page: Page) {
  await page.locator("#updates-bell").click();
  await expect(page.locator("#updates-popover")).toBeVisible();
}
async function capture(page: Page, name: string) {
  const path = test.info().outputPath(name + ".png");
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}
async function unread(page: Page, sequences: number[]) {
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — " + sequences.length + " unread update" + (sequences.length === 1 ? "" : "s")
  );
  await expect(page.locator("#updates-dot")).not.toHaveAttribute("hidden");
  await expect(page.locator("#updates-popover-content .latest-update")).toHaveCount(
    sequences.length
  );
  await expect(page.locator("#updates-popover-content h3")).toHaveText(
    sequences.map((sequence) => "Deployment " + sequence)
  );
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
async function readUpdate(page: Page, sequence: number) {
  await page.locator("#update-" + sequence + " summary").click();
  await expect(page.locator("#update-" + sequence + " .update-read-state")).toHaveText("Read");
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
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — 4 unread updates"
  );
  await expect(page.locator(".update-read-state")).toHaveText(Array(4).fill("Unread"));
});

test("the bell lists every unread update; reading one changes only that row and survives reopening", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin);
  await unread(page, [3, 2, 1]);
  await openBell(page);
  await unread(page, [3, 2, 1]);
  expect(await marker(page, 3)).toBeNull();
  await page.locator('[data-update-link="2"]').click();
  await expect(page.locator("#update-2")).toHaveAttribute("open");
  await expect(page.locator("#update-2 .update-read-state")).toHaveText("Read");
  await expect(page.locator("#update-3 .update-read-state")).toHaveText("Unread");
  await expect(page.locator("#update-1 .update-read-state")).toHaveText("Unread");
  await unread(page, [3, 1]);
  expect(await marker(page, 2)).toBe("1");
  expect(await marker(page, 1)).toBeNull();
  await page.close();
  const returned = await context.newPage();
  await returned.goto(instance.origin + "/updates");
  await unread(returned, [3, 1]);
  await returned.reload();
  await unread(returned, [3, 1]);
  await expect(returned.locator("#update-2 .update-read-state")).toHaveText("Read");
  await readUpdate(returned, 1);
  await unread(returned, [3]);
  await capture(returned, "individual-read-state");
});

test("mark unread restores an individual update and stays unread through polls while its details remain open", async ({
  page,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin + "/updates");
  await readUpdate(page, 2);
  await page.locator("#update-2 .update-read-toggle").click();
  await expect(page.locator("#update-2 .update-read-state")).toHaveText("Unread");
  await unread(page, [3, 2, 1]);
  await publish(instance, [1, 2, 3, 4]);
  await unread(page, [4, 3, 2, 1]);
  expect(await marker(page, 2)).toBe("0");
  await page.locator("#update-2 .update-read-toggle").click();
  await unread(page, [4, 3, 1]);
});

test("mark all from the bell clears every page, and the history button handles future updates", async ({
  page,
  instance
}) => {
  const sequences = Array.from({ length: 24 }, (_, index) => index + 1);
  await publish(instance, sequences);
  await page.goto(instance.origin + "/updates?page=2");
  await unread(page, [...sequences].reverse());
  await openBell(page);
  await capture(page, "all-unread-in-bell");
  await page.locator("#updates-popover .updates-mark-all").click();
  await caughtUp(page);
  await expect(page.locator(".update-read-state")).toHaveText(Array(10).fill("Read"));
  await expect(page.locator("#updates-popover .updates-mark-all")).toBeDisabled();
  await page.locator("#updates-bell").click();
  await page.reload();
  await caughtUp(page);
  await publish(instance, [...sequences, 25, 26]);
  await unread(page, [26, 25]);
  await page.locator(".updates-history-actions .updates-mark-all").click();
  await caughtUp(page);
  expect(await marker(page, 26)).toBe("1");
});

test("mark all leaves updates arriving after the click unread", async ({ page, instance }) => {
  await publish(instance, [1, 2]);
  await page.goto(instance.origin);
  await unread(page, [2, 1]);
  await openBell(page);
  let requested!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/updates/feed", async (route) => {
    requested();
    await gate;
    await route.continue();
  });
  await page.locator("#updates-popover .updates-mark-all").click();
  await started;
  await publish(instance, [1, 2, 3]);
  release();
  await unread(page, [3]);
  expect(await marker(page, 1)).toBe("1");
  expect(await marker(page, 2)).toBe("1");
  expect(await marker(page, 3)).toBeNull();
});

test("tabs synchronize independent reads and unread reversals without overwriting another update", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin + "/updates");
  const other = await context.newPage();
  await other.goto(instance.origin + "/updates");
  await readUpdate(page, 1);
  await readUpdate(other, 2);
  await unread(page, [3]);
  await unread(other, [3]);
  await expect(other.locator("#update-1 .update-read-state")).toHaveText("Read");
  await page.locator("#update-1 .update-read-toggle").click();
  await unread(other, [3, 1]);
  await expect(other.locator("#update-1 .update-read-state")).toHaveText("Unread");
});

test("migrates the old read-through baseline and allows one older update to become unread", async ({
  page,
  instance
}) => {
  await publish(instance, [1, 2, 3, 4]);
  await page.goto(instance.origin + "/updates");
  await page.evaluate(() => {
    const viewer = document.getElementById("updates-bell")!.dataset.viewerId;
    localStorage.setItem("patchy:updates:read-through:" + viewer, "3");
  });
  await page.reload();
  await unread(page, [4]);
  await page.locator("#update-2 summary").click();
  await page.locator("#update-2 .update-read-toggle").click();
  await unread(page, [4, 2]);
  await page.reload();
  await unread(page, [4, 2]);
});

for (const failure of ["access denied", "quota exceeded"] as const) {
  test(`storage ${failure}: individual read state works in memory`, async ({ page, instance }) => {
    await publish(instance, [1, 2, 3]);
    await page.addInitScript((failure) => {
      if (failure === "access denied")
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException("Blocked", "SecurityError");
          }
        });
      else
        Storage.prototype.setItem = () => {
          throw new DOMException("Full", "QuotaExceededError");
        };
    }, failure);
    await page.goto(instance.origin + "/updates");
    await readUpdate(page, 2);
    await unread(page, [3, 1]);
    await page.locator("#update-2 .update-read-toggle").click();
    await unread(page, [3, 2, 1]);
    await page.locator(".updates-history-actions .updates-mark-all").click();
    await caughtUp(page);
    await publish(instance, [1, 2, 3, 4]);
    await unread(page, [4]);
    await page.reload();
    await unread(page, [4, 3, 2, 1]);
  });
}

test("hidden details stay unread until visible; history and bell opening alone do not read entries", async ({
  page,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.addInitScript(() =>
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" })
  );
  await page.goto(instance.origin + "/updates?release=2#update-2");
  expect(await marker(page, 2)).toBeNull();
  await expect(page.locator("#updates-bell")).toHaveAttribute("aria-label", "Updates — loading");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible"
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await unread(page, [3, 1]);
  expect(await marker(page, 2)).toBe("1");
  await openBell(page);
  await unread(page, [3, 1]);
});

test("unavailable feed cannot mark updates read and recovers without clearing them", async ({
  page,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.route("**/updates/feed", (route) =>
    route.fulfill({ status: 503, body: "unavailable" })
  );
  await page.goto(instance.origin + "/updates");
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — unavailable"
  );
  await expect(page.locator(".updates-history-actions .updates-mark-all")).toBeDisabled();
  await openBell(page);
  expect(await marker(page, 3)).toBeNull();
  await page.unroute("**/updates/feed");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await unread(page, [3, 2, 1]);
});

test("account changes reject a stale feed and keep personal read state separate", async ({
  page,
  context,
  instance
}) => {
  await publish(instance, [1, 2, 3]);
  await page.goto(instance.origin + "/updates");
  await readUpdate(page, 2);
  await instance.session(context, "colleague");
  await openBell(page);
  await expect(page.locator("#updates-bell")).toHaveAttribute(
    "aria-label",
    "Updates — unavailable"
  );
  await expect(page.locator("#updates-popover .latest-update")).toHaveCount(0);
  await page.goto(instance.origin + "/updates");
  await unread(page, [3, 2, 1]);
  await readUpdate(page, 1);
  await instance.session(context, "owner");
  await page.reload();
  await unread(page, [3, 1]);
});

test("24 updates paginate 10/10/4 while all unread entries are in the bell, including mobile", async ({
  page,
  instance
}) => {
  const sequences = Array.from({ length: 24 }, (_, index) => index + 1);
  await publish(instance, sequences);
  await page.goto(instance.origin + "/updates");
  await unread(page, [...sequences].reverse());
  await expect(page.locator(".update-entry")).toHaveCount(10);
  const navigation = page.getByRole("navigation", { name: "Update history pages" });
  await navigation.getByRole("link", { name: "Page 2", exact: true }).click();
  await expect(page.locator(".update-entry")).toHaveCount(10);
  await expect(page.locator(".update-title").first()).toHaveText("Deployment 14");
  await readUpdate(page, 12);
  await unread(
    page,
    [...sequences].reverse().filter((n) => n !== 12)
  );
  await navigation.getByRole("link", { name: "Next" }).click();
  await expect(page.locator(".update-entry")).toHaveCount(4);
  await expect(page.locator(".update-title")).toHaveText([
    "Deployment 4",
    "Deployment 3",
    "Deployment 2",
    "Deployment 1"
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await openBell(page);
  await expect(page.locator("#updates-popover .latest-update")).toHaveCount(23);
  const overflow = await page
    .locator("#updates-popover-content")
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflow).toBe(true);
  await expect(page.getByRole("link", { name: "View all updates" })).toBeVisible();
  await page.locator('[data-update-link="1"]').scrollIntoViewIfNeeded();
  await capture(page, "all-unread-mobile");
  await page.locator('[data-update-link="1"]').click();
  await expect(page.locator("#update-1")).toHaveAttribute("open");
  await expect(page.locator("#update-1 .update-read-state")).toHaveText("Read");
  await expect(navigation.locator('[aria-current="page"]')).toHaveText("3");
  await page.reload();
  await expect(page.locator("#update-1 .update-read-state")).toHaveText("Read");
  expect(await marker(page, 12)).toBe("1");
});
