/** #1233: use the existing Spend Requests UI inside the #1232 plain host fixture. */
import { readFile } from "node:fs/promises";
import { chromium, firefox, devices, expect, type Page } from "@playwright/test";
import type { checkBrowsers } from "./check.js";
import type { publishSpend } from "./spend.js";

type Input = Pick<
  Parameters<typeof checkBrowsers>[0],
  "proxy" | "hosts" | "users" | "clerk" | "frontend" | "privatePatch" | "api"
> & {
  republish: Awaited<ReturnType<typeof publishSpend>>["republish"];
};

export async function checkWorkflow(input: Input) {
  const { proxy, hosts, clerk, privatePatch: patch, api } = input;
  const testing = await clerk.testingTokens.createTestingToken();
  const browsers: {
    engine: string;
    checks: string[];
    timingMs: Record<string, number>;
    blocker?: string;
  }[] = [];
  for (const engine of ["chromium", "firefox"] as const) {
    const browser =
      engine === "chromium"
        ? await chromium.launch({ args: ["--test-third-party-cookie-phaseout"] })
        : await firefox.launch({ firefoxUserPrefs: { "network.cookie.cookieBehavior": 1 } });
    const context = await browser.newContext({
      userAgent: engine === "chromium" ? devices["Desktop Chrome"].userAgent : undefined,
      viewport: { width: 1100, height: 800 }
    });
    context.setDefaultTimeout(20_000);
    context.setDefaultNavigationTimeout(45_000);
    const page = await context.newPage();
    page.on("response", (response) => {
      if (response.status() >= 400) {
        // Keep file handles and other parameter values out of the diagnostics.
        const route = new URL(response.url()).pathname.split("/").slice(0, 4).join("/");
        process.stderr.write(`${engine} HTTP ${response.status()}: ${route}\n`);
      }
    });
    const checks: string[] = [];
    const timingMs: Record<string, number> = {};
    const mark = (name: string) => {
      checks.push(name);
      process.stdout.write(`${engine}: ${name}\n`);
    };
    const outer = (page: Page) => page.frameLocator("#embedded");
    const content = (page: Page) => outer(page).frameLocator("#patch");
    const signIn = async (page: Page, first = false) => {
      const opened = page.waitForEvent("popup");
      await outer(page).getByRole("button", { name: "Sign in to Patchy" }).click();
      const popup = await opened;
      if (first) {
        await popup
          .getByLabel("Email address", { exact: true })
          .fill(input.users.find((user) => user.kind === "member")!.email);
        await popup.getByRole("button", { name: "Continue", exact: true }).click();
        const code = popup.locator('input[autocomplete="one-time-code"]');
        await code.fill("424242");
        try {
          await popup
            .getByRole("button", { name: "Continue in embed", exact: true })
            .waitFor({ timeout: 12_000 });
        } catch (error) {
          if (!(await code.isVisible())) throw error;
          await code.fill("");
          await code.pressSequentially("424242", { delay: 100 });
          const submit = popup.getByRole("button", { name: "Continue", exact: true });
          if (await submit.isVisible()) await submit.click();
        }
      }
      await popup.getByRole("button", { name: "Continue in embed", exact: true }).click();
      await expect(
        content(page).getByRole("heading", { name: "Spend Requests", exact: true })
      ).toBeVisible({ timeout: 25_000 });
      await expect(
        content(page).getByRole("button", { name: "New request", exact: true }).first()
      ).toBeEnabled();
      await popup.close();
    };
    const screenshot = async (page: Page, name: string) =>
      page.screenshot({ path: `.local/embed-workflow/${engine}-${name}.png` });
    try {
      await context.route(
        (url) => url.hostname === input.frontend && url.pathname.startsWith("/v1/"),
        async (route) => {
          const url = new URL(route.request().url());
          url.searchParams.set("__clerk_testing_token", testing.token);
          await route.continue({ url: url.href });
        }
      );
      if (engine === "chromium") {
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setCookieControls", { enableThirdPartyCookieRestriction: true });
      }
      await page.addInitScript(() => {
        if (location.hostname !== "localhost") return;
        Object.assign(window, { receivedMessages: 0 });
        addEventListener("message", () => {
          const state = window as unknown as { receivedMessages: number };
          state.receivedMessages++;
        });
      });
      const target = `${proxy.origin}/~prototype/embed?${new URLSearchParams({ host: hosts[0]!, patch: patch.patchId })}`;
      const hostUrl = `${hosts[0]}/?${new URLSearchParams({ target })}`;
      await page.goto(hostUrl);
      await expect(outer(page).getByRole("button", { name: "Sign in to Patchy" })).toBeVisible();
      await screenshot(page, "01-signed-out");
      await signIn(page, true);
      const embed = page
        .frames()
        .find((frame) => frame.url().startsWith(`${proxy.origin}/~prototype/embed`))!;
      expect((await context.cookies()).some((cookie) => cookie.name === "prototype_probe")).toBe(
        true
      );
      expect(
        await embed.evaluate(
          async () =>
            (await (
              await fetch("/~prototype/cookie-probe", { credentials: "include" })
            ).json()) as { cookie: boolean }
        )
      ).toEqual({ cookie: false });
      mark("Real Clerk sign-in returns to the original host with third-party cookies unavailable");

      const samples = content(page).getByRole("button", { name: "Load sample data", exact: true });
      if (await samples.isVisible()) await samples.click();
      await expect(content(page).getByRole("table", { name: "Spend requests" })).toBeVisible();
      await content(page)
        .getByRole("tab", { name: /Needs my approval/ })
        .click();
      const row = content(page)
        .locator(".table-row")
        .filter({ has: content(page).locator(".row-receipt") })
        .first();
      const title = await row.locator(".row-title").innerText();
      await row.focus();
      await row.press("Enter");
      const drawer = content(page).getByRole("complementary", { name: "Request details" });
      await expect(drawer.getByRole("heading", { name: title, exact: true })).toBeVisible();
      const quote = drawer.getByRole("img", { name: /^Receipt:/ });
      await expect
        .poll(() => quote.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      mark("Keyboard opens an existing request and its real stored quote loads inside the sandbox");
      await quote.scrollIntoViewIfNeeded();
      await screenshot(page, "02-review");

      const openedFull = page.waitForEvent("popup");
      await outer(page).getByRole("link", { name: "Open in Patchy" }).click();
      const full = await openedFull;
      const fullContent = full.frameLocator("#patch");
      await fullContent.getByRole("tab", { name: /Needs my approval/ }).click();
      await fullContent.getByRole("row").filter({ hasText: title }).click();
      await expect(fullContent.getByRole("heading", { name: title, exact: true })).toBeVisible();
      mark("Open in Patchy opens the same published patch and request");

      // Return to the host tab after inspecting the separate full-page tab.
      await page.bringToFront();
      const note = `Approved from the embedded ${engine} workflow`;
      await drawer
        .getByPlaceholder("Add a note. Required if you reject.", { exact: true })
        .fill(note);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(drawer.getByRole("button", { name: "Approve", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(drawer.locator(".decision-summary")).toContainText("approved this");
      await expect(drawer.locator(".decision-note")).toHaveText(note);
      await expect(fullContent.locator(".decision-note")).toHaveText(note);
      mark(
        "Manager approves with the keyboard; full-page live query shows the same decision and note"
      );
      expect(page.url()).toBe(hostUrl);
      expect(
        await page
          .locator("#embedded")
          .evaluate((frame) => (frame as HTMLIFrameElement).contentDocument)
      ).toBeNull();
      expect(
        await page.evaluate(
          () => (window as unknown as { receivedMessages: number }).receivedMessages
        )
      ).toBe(0);
      expect(await outer(page).locator("#patch").getAttribute("sandbox")).toBe(
        "allow-scripts allow-modals"
      );
      mark(
        "Host URL stays put, receives no messages, and cannot read Patchy DOM; sandbox unchanged"
      );
      await screenshot(page, "03-approved");

      await page.locator("#embedded").evaluate((frame) => frame.setAttribute("width", "520"));
      const approveGeometry = await drawer
        .getByRole("button", { name: "Mark as paid", exact: true })
        .evaluate((button) => {
          const box = button.getBoundingClientRect();
          return { left: box.left, right: box.right, width: innerWidth };
        });
      expect(approveGeometry.left).toBeGreaterThanOrEqual(0);
      expect(approveGeometry.right).toBeLessThanOrEqual(approveGeometry.width);
      await drawer.getByRole("button", { name: "Close", exact: true }).press("Escape");
      await expect(drawer).toHaveCount(0);
      await content(page).getByRole("tab", { name: "All", exact: true }).click();
      await content(page).getByRole("row").filter({ hasText: title }).click();
      await expect(drawer.locator(".decision-note")).toHaveText(note);
      await expect
        .poll(() => quote.evaluate((image) => (image as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      await screenshot(page, "04-narrow");
      mark(
        "Existing drawer fits a 520px host frame; Escape and reopening preserve the saved decision"
      );
      await page.locator("#embedded").evaluate((frame) => frame.setAttribute("width", "900"));

      await drawer.getByRole("button", { name: "Download", exact: true }).click();
      const offered = outer(page).getByRole("region", { name: "Files ready to download" });
      await expect(offered).toBeVisible();
      const downloading = page.waitForEvent("download");
      await offered.getByRole("button", { name: "Download", exact: true }).click();
      const downloaded = await downloading;
      expect(await downloaded.failure()).toBeNull();
      const file = `.local/embed-workflow/${engine}-quote.svg`;
      await downloaded.saveAs(file);
      expect(await readFile(file, "utf8")).toContain("<svg");
      mark("Existing quote download completes through the shell's explicit Download confirmation");

      const originalVersion = await outer(page).locator("#patch").getAttribute("data-version-id");
      const published = await input.republish();
      expect(published.patchId).toBe(patch.patchId);
      await expect(outer(page).locator('[data-stream-status="new-version"]')).toBeVisible();
      await expect(full.locator('[data-stream-status="new-version"]')).toBeVisible();
      expect(await outer(page).locator("#patch").getAttribute("data-version-id")).toBe(
        originalVersion
      );
      mark(
        "Normal CLI publish notifies both views; the admitted embedded document stays on its version"
      );
      await outer(page).getByRole("button", { name: "Reload", exact: true }).click();
      await expect(outer(page).getByRole("button", { name: "Sign in to Patchy" })).toBeVisible();
      await signIn(page);
      const nextVersion = await outer(page).locator("#patch").getAttribute("data-version-id");
      expect(nextVersion).not.toBe(originalVersion);
      await full.reload();
      await expect(full.locator("#patch")).toHaveAttribute("data-version-id", nextVersion!);
      mark("Reload uses the newly served version in both views and the existing sign-in handoff");

      const rolledBack = await api(`patches/${patch.patchId}/rollback`, "POST", {
        versionNumber: 1
      });
      expect(rolledBack.ok).toBe(true);
      await expect(outer(page).locator('[data-stream-status="new-version"]')).toBeVisible();
      await expect(full.locator('[data-stream-status="new-version"]')).toBeVisible();
      await outer(page).getByRole("button", { name: "Reload", exact: true }).click();
      await signIn(page);
      await full.reload();
      await expect(outer(page).locator("#patch")).toHaveAttribute(
        "data-version-id",
        originalVersion!
      );
      await expect(full.locator("#patch")).toHaveAttribute(
        "data-version-id",
        (await outer(page).locator("#patch").getAttribute("data-version-id")) ?? ""
      );
      await content(page).getByRole("tab", { name: "All", exact: true }).click();
      await content(page).getByRole("row").filter({ hasText: title }).click();
      await expect(drawer.locator(".decision-note")).toHaveText(note);
      mark("Existing rollback serves the same version to both views without losing the approval");

      const began = Date.now();
      const retired = await api(`patches/${patch.patchId}/retire`, "POST", {});
      expect(retired.ok).toBe(true);
      await expect(outer(page).locator("#patch")).toHaveCount(0);
      await expect(outer(page).locator("#status")).toContainText(/ended/i);
      await expect(outer(page).getByRole("link", { name: "Open in Patchy" })).toBeVisible();
      await expect(full.locator("#patch")).toHaveCount(0);
      timingMs.retirement = Date.now() - began;
      await screenshot(page, "05-unavailable");
      mark("Retirement ends live embedded/full-page use with a safe message and Open in Patchy");
      const restored = await api(`patches/${patch.patchId}/restore`, "POST", {});
      expect(restored.ok).toBe(true);
      browsers.push({ engine, checks, timingMs });
    } catch (error) {
      // Capture only the local host; never the separate authentication tab.
      await screenshot(page, "failure");
      process.stderr.write(
        `Embedded stop code: ${await outer(page)
          .locator("#status")
          .getAttribute("data-reason")
          .catch(() => null)}\n`
      );
      process.stderr.write(
        `Session endings: ${JSON.stringify([...proxy.sessions.values()].map((session) => session.ended ?? "active"))}\n`
      );
      for (const frame of page.frames()) {
        const body = await frame
          .locator("body")
          .innerText({ timeout: 1000 })
          .catch(() => "Frame ended");
        process.stderr.write(`Workflow frame: ${body.slice(0, 350)}\n`);
      }
      const blocker =
        error instanceof Error
          ? error.message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 1500)
          : "Workflow check failed";
      process.stderr.write(`${engine}: blocker after ${checks.length} checks: ${blocker}\n`);
      browsers.push({ engine, checks, timingMs, blocker });
      // Leave the next browser an available patch even if a retirement assertion failed.
      await api(`patches/${patch.patchId}/restore`, "POST", {});
    } finally {
      await context.close();
      await browser.close();
    }
  }
  expect(proxy.audit.credentialInUrl).toBe(false);
  expect(proxy.audit.embeddedCookies).toBe(0);
  return { browsers, audit: proxy.audit };
}
