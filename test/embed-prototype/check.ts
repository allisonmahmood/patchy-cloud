/** Real Account Portal + two browser engines. Do not enable auth traces or context video. */
import {
  chromium,
  firefox,
  expect,
  devices,
  type BrowserContext,
  type Page
} from "@playwright/test";
import type * as Effect from "effect/Effect";
import type { liveClient } from "../../packages/auth/live/fixtures.js";
import type { Published } from "../browser-tier1/instance.js";
import type { startProxy } from "./proxy.js";

export async function checkBrowsers(input: {
  proxy: Awaited<ReturnType<typeof startProxy>>;
  hosts: string[];
  users: { id: string; email: string; kind: string }[];
  clerk: Effect.Success<typeof liveClient>;
  frontend: string;
  privatePatch: Published;
  publicPatch: Published;
  grant: (remove?: boolean) => Promise<void>;
  api: (path: string, method: string, body?: unknown) => Promise<Response>;
}) {
  const { proxy, hosts, clerk, privatePatch, publicPatch } = input;
  const frontend = input.frontend;
  const token = await clerk.testingTokens.createTestingToken();
  const result: {
    engine: string;
    checks: string[];
    timingMs: Record<string, number>;
    blocker?: string;
  }[] = [];
  for (const engine of ["chromium", "firefox"] as const) {
    process.stdout.write(`Embed prototype: ${engine}\n`);
    const browser =
      engine === "chromium"
        ? await chromium.launch({ args: ["--test-third-party-cookie-phaseout"] })
        : await firefox.launch({ firefoxUserPrefs: { "network.cookie.cookieBehavior": 1 } });
    const contexts: BrowserContext[] = [];
    const checks: string[] = [];
    const mark = (check: string) => {
      checks.push(check);
      process.stdout.write(`${engine}: ${check}\n`);
    };
    const timingMs: Record<string, number> = {};
    const context = async () => {
      const created = await browser.newContext({
        userAgent: engine === "chromium" ? devices["Desktop Chrome"].userAgent : undefined,
        viewport: { width: 1100, height: 800 }
      });
      created.setDefaultTimeout(20_000);
      created.setDefaultNavigationTimeout(45_000);
      contexts.push(created);
      await created.route(
        (url) =>
          (frontend ? url.hostname === frontend : url.hostname.endsWith(".clerk.accounts.dev")) &&
          url.pathname.startsWith("/v1/"),
        async (route) => {
          const url = new URL(route.request().url());
          url.searchParams.set("__clerk_testing_token", token.token);
          await route.continue({ url: url.href });
        }
      );
      return created;
    };
    const embeddedUrl = (host: string, patch = privatePatch) =>
      `${proxy.origin}/~prototype/embed?${new URLSearchParams({ host, patch: patch.patchId })}`;
    const cookieControls = new Set<Page>();
    const mount = async (page: Page, host = hosts[0]!, target = embeddedUrl(host)) => {
      if (engine === "chromium" && !cookieControls.has(page)) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setCookieControls", { enableThirdPartyCookieRestriction: true });
        // Keep the session attached: detaching restores Chrome's cookie defaults.
        cookieControls.add(page);
      }
      await page.goto(`${host}/?${new URLSearchParams({ target })}`);
    };
    const signin = async (page: Page, kind = "member", first = false) => {
      const popupPromise = page.waitForEvent("popup");
      await page
        .frameLocator("#embedded")
        .getByRole("button", { name: "Sign in to Patchy" })
        .click();
      const popup = await popupPromise;
      if (first) {
        await popup
          .getByLabel("Email address", { exact: true })
          .fill(input.users.find((user) => user.kind === kind)!.email);
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
      return popup;
    };
    const inner = (page: Page) => page.frameLocator("#embedded").frameLocator("#patch");
    const ready = async (page: Page) => {
      try {
        await expect(inner(page).getByRole("heading", { name: "Shared notes" })).toBeVisible({
          timeout: 25_000
        });
      } catch (error) {
        for (const frame of page.frames()) {
          process.stderr.write(
            `Frame ${new URL(frame.url()).pathname}: ${(await frame.locator("body").innerText()).slice(0, 400)}\n`
          );
        }
        throw error;
      }
      await expect(inner(page).locator("#identity")).not.toHaveText("Loading");
    };
    const stopped = async (page: Page) => {
      await expect(page.frameLocator("#embedded").locator("#patch")).toHaveCount(0, {
        timeout: 10_000
      });
      await expect(
        page.frameLocator("#embedded").getByRole("link", { name: "Open in Patchy" })
      ).toBeVisible();
    };
    try {
      const member = await context();
      const page = await member.newPage();
      page.on("console", (message) => {
        if (message.type() === "error")
          process.stderr.write(
            `Browser: ${message
              .text()
              .replace(/https?:\/\/[^\s"']+/g, "[url]")
              .slice(0, 300)}\n`
          );
      });
      page.on("pageerror", (error) => {
        process.stderr.write(`Page: ${error.message.slice(0, 300)}\n`);
      });
      let embeddedToken = "";
      page.on("request", (request) => {
        embeddedToken = request.headers()["x-prototype-session"] ?? embeddedToken;
      });
      await page.addInitScript(() => {
        if (location.hostname === "localhost") {
          Object.assign(window, { receivedMessages: 0 });
          addEventListener("message", () => {
            const state = window as unknown as { receivedMessages: number };
            state.receivedMessages++;
          });
        }
      });
      await mount(page);
      await expect(
        page.frameLocator("#embedded").getByRole("button", { name: "Sign in to Patchy" })
      ).toBeVisible();
      if (engine === "chromium")
        await page.screenshot({ path: ".local/embed-prototype/01-signed-out.png" });
      const popup = await signin(page, "member", true);
      await ready(page);
      mark("Real Clerk sign-in resumes the original private iframe");
      const embed = page
        .frames()
        .find((frame) => frame.url().startsWith(`${proxy.origin}/~prototype/embed`))!;
      const probe = await embed.evaluate(
        async () =>
          (await (await fetch("/~prototype/cookie-probe", { credentials: "include" })).json()) as {
            cookie: boolean;
          }
      );
      expect((await member.cookies()).some((cookie) => cookie.name === "prototype_probe")).toBe(
        true
      );
      expect(probe.cookie).toBe(false);
      mark("Unpartitioned third-party probe cookie unavailable");
      expect(
        await page
          .locator("#embedded")
          .evaluate((element) => (element as HTMLIFrameElement).contentDocument === null)
      ).toBe(true);
      expect(
        await page.evaluate(
          () => (window as unknown as { receivedMessages: number }).receivedMessages
        )
      ).toBe(0);
      expect(await page.frameLocator("#embedded").locator("#patch").getAttribute("sandbox")).toBe(
        "allow-scripts allow-modals"
      );
      expect(
        await inner(page)
          .locator("body")
          .evaluate(() => {
            try {
              return parent.document.body !== null;
            } catch {
              return false;
            }
          })
      ).toBe(false);
      mark("Host cannot read Patchy DOM; no host messages; original sandbox retained");
      await inner(page).getByRole("button", { name: "Add a note" }).click();
      await expect(inner(page).locator("#result")).toHaveText("Saved");
      await expect(inner(page).locator("#rows")).toContainText("Added from the host app");
      mark("Authenticated table write and live subscription snapshot");
      const wrongPatch = await fetch(`${proxy.origin}/api/runtime/call`, {
        method: "POST",
        headers: { "x-prototype-session": embeddedToken, "content-type": "application/json" },
        body: JSON.stringify({ patchId: publicPatch.patchId, op: "me", args: {} })
      });
      expect(wrongPatch.status).toBe(403);
      const wrongRoute = await fetch(`${proxy.origin}/machines`, {
        headers: { "x-prototype-session": embeddedToken }
      });
      expect(wrongRoute.status).toBe(403);
      mark("Embedded credential cannot select another patch or a full Patchy page");
      if (engine === "chromium")
        await page.screenshot({ path: ".local/embed-prototype/02-saved.png" });

      await popup.goto(privatePatch.address);
      await expect(popup.frameLocator("#patch").locator("#rows")).toContainText(
        "Added from the host app"
      );
      mark("The same published patch and saved data open normally in Patchy");

      await popup.goto(`${proxy.origin}/~prototype/sessions`);
      await expect(popup.getByRole("heading", { name: "Your embedded sessions" })).toBeVisible();
      let changed = Date.now();
      await popup.getByRole("button", { name: "End session", exact: true }).first().click();
      await stopped(page);
      timingMs.sessionRevoke = Date.now() - changed;
      mark("Viewer sees and ends an embedded session from Patchy");
      if (engine === "chromium")
        await page.screenshot({ path: ".local/embed-prototype/03-revoked.png" });
      await popup.close();
      await mount(page);
      await (await signin(page)).close();
      await ready(page);
      changed = Date.now();
      proxy.approved.delete(hosts[0]!);
      await stopped(page);
      timingMs.hostRemoval = Date.now() - changed;
      mark("Host removal stops live use and future private mounts");
      const refused = await fetch(embeddedUrl(hosts[0]!));
      expect(refused.status).toBe(403);
      proxy.approved.add(hosts[0]!);
      let ancestorRefused = false;
      const refusal = (message: { text(): string }) => {
        if (message.text().includes("frame-ancestors")) ancestorRefused = true;
      };
      page.on("console", refusal);
      await mount(page, hosts[1]!, embeddedUrl(hosts[0]!));
      // A CSP-blocked iframe has no queryable execution context in Firefox.
      await expect.poll(() => ancestorRefused).toBe(true);
      page.off("console", refusal);
      mark("A second actual ancestor cannot spoof the approved host parameter");

      const guestContext = await context();
      const guest = await guestContext.newPage();
      await mount(guest);
      await (await signin(guest, "guest", true)).close();
      await ready(guest);
      await inner(guest).getByRole("button", { name: "Add a note" }).click();
      await expect(inner(guest).locator("#result")).toHaveText("Saved");
      mark("Existing outside-guest grant permits the same patch operations");
      changed = Date.now();
      await input.grant(true);
      await stopped(guest);
      timingMs.guestAccessLoss = Date.now() - changed;
      mark("Removing the actual guest grant stops live use");
      await input.grant();
      const outsider = await (await context()).newPage();
      await mount(outsider);
      const outsiderPopup = await signin(outsider, "outsider", true);
      await expect(
        outsiderPopup.getByRole("heading", { name: "This patch is unavailable to you" })
      ).toBeVisible();
      await stopped(outsider);
      mark("An authenticated person without membership or a grant is refused");

      // Accelerate only this session's configured lifetime; no clock or fake authentication.
      proxy.setLifetime(4000);
      await mount(page);
      await (await signin(page)).close();
      await ready(page);
      proxy.setLifetime(300_000);
      changed = Date.now();
      await stopped(page);
      timingMs.expiryAfterReady = Date.now() - changed;
      mark("Four-second configured session expires without renewal");
      await mount(page);
      await (await signin(page)).close();
      await ready(page);
      await mount(page);
      await expect(
        page.frameLocator("#embedded").getByRole("button", { name: "Sign in to Patchy" })
      ).toBeVisible();
      mark("Reload discards the in-memory credential and offers sign-in again");
      const signout = await signin(page);
      await ready(page);
      changed = Date.now();
      await signout.evaluate(() => {
        const form = Object.assign(document.createElement("form"), {
          method: "POST",
          action: "/logout"
        });
        document.body.append(form);
        form.submit();
      });
      await stopped(page);
      timingMs.patchySignOut = Date.now() - changed;
      mark("Normal Patchy sign-out revokes the underlying Clerk session and ends the embed");
      for (const host of hosts) {
        const publicPage = await (await context()).newPage();
        await mount(publicPage, host, publicPatch.address);
        const content = publicPage.frameLocator("#embedded").frameLocator("#patch");
        await expect(content.getByRole("heading", { name: "Shared notes" })).toBeVisible();
        await expect(content.locator("#identity")).toHaveText("Public reader");
        await content.getByRole("button", { name: "Add a note" }).click();
        await expect(content.locator("#result")).toHaveText("not_available_on_public");
      }
      mark(
        "Public patch frames on either host, anonymous me and owned-table restrictions retained"
      );
      result.push({ engine, checks, timingMs });
      process.stdout.write(`${engine}: ${checks.length} checks passed\n`);
    } catch (error) {
      const blocker =
        error instanceof Error
          ? error.message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 1500)
          : "Browser check failed";
      result.push({ engine, checks, timingMs, blocker });
      process.stderr.write(`${engine}: blocker after ${checks.length} checks: ${blocker}\n`);
    } finally {
      proxy.setLifetime(300_000);
      proxy.approved.add(hosts[0]!);
      await Promise.all(contexts.map((created) => created.close()));
      await browser.close();
    }
  }
  expect(proxy.audit.credentialInUrl).toBe(false);
  expect(proxy.audit.embeddedCookies).toBe(0);
  return { browsers: result, audit: proxy.audit };
}
