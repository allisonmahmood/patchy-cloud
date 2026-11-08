import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

interface Watched {
  __refused: string[];
}

/** Records every CSP refusal on every page the context opens, from before its first byte. */
const watchRefusals = (context: BrowserContext) =>
  context.addInitScript(() => {
    const watched = window as unknown as Watched;
    watched.__refused = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      watched.__refused.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

/** How the page's text is drawn, once its fonts have settled. */
const typeface = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily.split(",")[0]?.replaceAll('"', ""),
    geist: [...document.fonts].find((face) => face.family.replaceAll('"', "") === "Geist")?.status,
    refused: (window as unknown as Watched).__refused
  }));
};

const inGeist = { body: "Geist", geist: "loaded", refused: [] };

test("first-party pages draw in Geist, signed in or out, and nothing is refused", async ({
  page,
  context,
  instance
}) => {
  await watchRefusals(context);
  await page.goto(`${instance.origin}/`);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  expect(await typeface(page)).toEqual(inGeist);

  await instance.session(context, "none");
  for (const path of ["/nothing-here", "/~shell/notice/stream_limit?return=/"]) {
    await page.goto(`${instance.origin}${path}`);
    expect(await typeface(page), path).toEqual(inGeist);
  }
});

test("a running patch's shell fetches none of the app's fonts", async ({ page, instance }) => {
  const patch = await instance.publish("company");
  const fonts: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/assets/fonts/")) fonts.push(request.url());
  });
  await page.goto(patch.address);
  await expect(page.frameLocator("#patch").locator("body")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(fonts).toEqual([]);
});
