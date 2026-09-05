import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { liveClient, liveSettings } from "../../packages/auth/live/fixtures.js";
import { startInstance, type BrowserInstance } from "./instance.js";

const decodeUpload = Schema.decodeUnknownSync(
  Schema.Struct({ publicUrl: Schema.String, scope: Schema.Literal("company") })
);
const settings = liveSettings(process.env);

type Live = BrowserInstance & {
  settings: typeof settings;
  patchUrl: string;
  seededPage: Page;
  newContext: () => Promise<BrowserContext>;
  createOutsider: () => Promise<void>;
};

/** Real Account Portal forms: no injected sessions or browser-side Clerk signIn shortcut. */
export async function signIn(page: Page, email: string, destination: (url: URL) => boolean) {
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const code = page.locator('input[autocomplete="one-time-code"]');
  await code.fill("424242");
  try {
    await page.waitForURL(destination, { timeout: 10_000 });
  } catch (error) {
    // The hosted portal can drop the first code during hydration; retype only if still there.
    if (!(await code.isVisible())) throw error;
    await code.fill("");
    await code.pressSequentially("424242", { delay: 100 });
    const submit = page.getByRole("button", { name: "Continue", exact: true });
    if (await submit.isVisible()) await submit.click();
    await page.waitForURL(destination);
  }
}

export const test = base.extend<object, { live: Live }>({
  live: [
    async ({ browser }, use, workerInfo) => {
      const client = await Effect.runPromise(
        liveClient.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))
      );
      const user = await client.users.createUser({
        emailAddress: [settings.browserEmail],
        firstName: "Browser",
        lastName: "Live",
        skipPasswordRequirement: true,
        skipLegalChecks: true
      });
      const instance = await startInstance(settings, user.id);
      const contexts: BrowserContext[] = [];
      try {
        // The instance builds workspace packages before this seed entry exists on a clean checkout.
        const { DEV_SEED } = await import("@patchy/auth/seed");
        // SDK endpoint is POST /v1/testing_tokens. Keep the token in memory, never in artifacts.
        const testingToken = await client.testingTokens.createTestingToken();
        const frontendHost = Buffer.from(
          process.env.CLERK_PUBLISHABLE_KEY!.replace(/^pk_test_/, ""),
          "base64"
        )
          .toString()
          .replace(/\$$/, "");
        const newContext = async () => {
          const { userAgent, viewport } = workerInfo.project.use;
          const context = await browser.newContext({ userAgent, viewport });
          contexts.push(context);
          await context.route(
            (url) => url.origin === `https://${frontendHost}` && url.pathname.startsWith("/v1/"),
            async (route) => {
              const url = new URL(route.request().url());
              url.searchParams.set("__clerk_testing_token", testingToken.token);
              await route.continue({ url: url.toString() });
            }
          );
          return context;
        };
        const upload = await fetch(`${instance.origin}/api/uploads`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${DEV_SEED.token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            title: "Live company patch",
            html: "<!doctype html><html><head><title>Live company patch</title></head><body><h1>Company-only browser fixture</h1></body></html>",
            scope: "company"
          }),
          signal: AbortSignal.timeout(15_000)
        });
        expect(upload.status).toBe(201);
        const { publicUrl: patchUrl } = decodeUpload(await upload.json());
        const seededPage = await (await newContext()).newPage();
        await use({
          ...instance,
          settings,
          patchUrl,
          seededPage,
          newContext,
          createOutsider: async () => {
            await client.users.createUser({
              emailAddress: [settings.outsiderEmail],
              firstName: "Outsider",
              lastName: "Live",
              skipPasswordRequirement: true,
              skipLegalChecks: true
            });
          }
        });
      } finally {
        try {
          await Promise.all(contexts.map((context) => context.close()));
        } finally {
          await instance.close();
        }
      }
    },
    { scope: "worker", timeout: 240_000 }
  ]
});

/** Reuse the seeded browser between files, including when either workflow is selected alone. */
export async function openSeededPatch(live: Live) {
  const page = live.seededPage;
  if (page.url() === "about:blank") {
    const door = await page.goto(live.patchUrl);
    expect(door?.status()).toBe(401);
    expect(door?.headers()["cache-control"]).toBe("private, no-store");
    let handshake = false;
    const observe = (url: string) => {
      if (new URL(url).searchParams.has("__clerk_handshake")) handshake = true;
    };
    page.on("request", (request) => observe(request.url()));
    await signIn(page, live.settings.browserEmail, (url) => url.href === live.patchUrl);
    expect(handshake).toBe(true);
  } else {
    expect((await page.goto(live.patchUrl))?.status()).toBe(200);
  }
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Company-only browser fixture" })
  ).toBeVisible();
  return page;
}

export { expect };
