import { test, expect, prepare } from "./fixtures.js";
import { loadDialog } from "./dialog.js";
import type { Page } from "@playwright/test";

const primary = (page: Page) => page.getByRole("navigation", { name: "Primary" });

test("the sidebar lights the page's place and opens Settings around its pages, for an admin and a member", async ({
  page,
  instance
}) => {
  for (const user of ["owner", "colleague"] as const) {
    await instance.session(page.context(), user);
    await page.goto(`${instance.origin}/settings/integrations`);
    const settings = primary(page).getByRole("group", { name: "Settings" });
    await expect(settings.getByRole("link")).toHaveText([
      "Teams",
      "People",
      "Integrations",
      "Agent access"
    ]);
    await expect(settings.getByRole("link", { name: "Integrations" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Integrations");
    await expect(page).toHaveTitle(/^Integrations – /);

    await page.goto(`${instance.origin}/agents`);
    await expect(primary(page).getByRole("link")).toHaveText([
      "Home",
      "All patches",
      "Your agents",
      "Settings"
    ]);
    await expect(primary(page).getByRole("link", { name: "Your agents" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(page.getByRole("link", { name: "New patch" })).toHaveAttribute("href", "/?new");
  }
});

test("on a phone the top bar's Menu holds New patch and the places without script, and its search opens on a press", async ({
  browser,
  instance
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    javaScriptEnabled: false
  });
  try {
    await prepare(context, instance);
    const page = await context.newPage();
    await page.goto(`${instance.origin}/agents`);
    await expect(primary(page)).toBeHidden();

    await page.getByRole("button", { name: "Menu" }).tap();
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New patch" })).toBeVisible();
    await expect(primary(page).getByRole("link", { name: "Your agents" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await primary(page).getByRole("link", { name: "Settings" }).tap();
    await expect(page).toHaveURL(/\/settings\/people$/);
    await expect(primary(page)).toBeHidden();

    // The search waits as its icon; pressing it focuses the field, which opens across the bar.
    const search = page.getByRole("searchbox", { name: "Search patches" });
    await page.locator(".app-search .field-prefix").tap();
    await expect(search).toBeFocused();
    expect((await search.boundingBox())!.width).toBeGreaterThan(200);
    await search.fill("crew");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/patches\?q=crew$/);
  } finally {
    await context.close();
  }
});

test("on a phone an in-page anchor lands below the sticky top bar", async ({
  browser,
  instance
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  });
  try {
    await prepare(context, instance);
    const page = await context.newPage();
    await page.goto(`${instance.origin}/agents`);
    // A target the page scrolls to, as it does to a change's permalink.
    await page.evaluate(() => {
      const target = document.createElement("h2");
      target.id = "landing";
      target.textContent = "Landing";
      target.style.marginBlock = "2000px";
      document.querySelector(".app-page")!.append(target);
      location.hash = "landing";
    });
    const bar = (await page.locator(".app-side").boundingBox())!;
    const target = (await page.locator("#landing").boundingBox())!;
    expect(bar.y).toBe(0);
    expect(Math.round(target.y)).toBe(Math.round(bar.height));
  } finally {
    await context.close();
  }
});

// The sidebar is a popover the wide frame shows in place, with Menu hidden; folded, Menu opens it.
const sidebar = (folded: boolean) =>
  `<!doctype html><html lang="en"><head><script defer src="/assets/ui.js"></script><style>#side { display: ${folded ? "none" : "block"} } #side:popover-open { display: block } [popovertarget] { display: ${folded ? "inline" : "none"} }</style></head><body><button type="button" popovertarget="side">Menu</button><div id="side" popover><a href="/~focus/dialog">New patch</a></div><main><a href="/~focus/elsewhere">Elsewhere</a></main></body></html>`;
const opened = `<!doctype html><html lang="en"><head><script defer src="/assets/ui.js"></script></head><body><section data-dialog data-close="/~focus/page" role="dialog" aria-label="New patch"><a href="/~focus/page">Close</a><input autofocus aria-label="What to build"></section></body></html>`;

test("closing a dialog puts focus back on the sidebar link that opened it, or on Menu while the sidebar is folded", async ({
  page,
  instance
}) => {
  for (const folded of [false, true]) {
    await page.route(`${instance.origin}/~focus/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          new URL(route.request().url()).pathname === "/~focus/dialog" ? opened : sidebar(folded)
      })
    );
    await page.goto(`${instance.origin}/~focus/page`);
    if (folded) await page.getByRole("button", { name: "Menu" }).click();
    await loadDialog(page, () => page.getByRole("link", { name: "New patch" }).click());
    await expect(page.getByRole("textbox", { name: "What to build" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(`${instance.origin}/~focus/page`);
    await expect(
      folded
        ? page.getByRole("button", { name: "Menu" })
        : page.getByRole("link", { name: "New patch" })
    ).toBeFocused();
    await page.unroute(`${instance.origin}/~focus/**`);
  }
});
