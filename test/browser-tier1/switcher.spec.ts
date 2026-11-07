import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { test, expect, installSessionRefreshBoundary } from "./fixtures.js";
import type { Instance } from "./instance.js";

// Patchy's switcher on Mod+Shift+K: the menu over a running patch and on Patchy's own pages.
// Playwright's key presses are trusted, as a person's are; on Linux, where these run, Mod is Ctrl.
const chord = "ControlOrMeta+Shift+K";
const tier1 = { tier: 1, tables: {}, files: {} } as const;
const patchHtml = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1><input id="field" aria-label="Field"></body></html>`;
const publish = (instance: Instance, title: string, scope: "company" | "public" = "company") =>
  instance.publish(scope, patchHtml(title), undefined, tier1);

const menu = (page: Page) => page.getByRole("dialog", { name: "Go to" });
const search = (page: Page) => menu(page).getByRole("combobox", { name: "Go to" });
const titles = (page: Page) => menu(page).locator('[role="option"] .command-title');
const lit = (page: Page) =>
  menu(page).locator('[role="option"][aria-selected="true"] .command-title');
const group = (page: Page, name: string) =>
  menu(page).getByRole("group", { name }).locator(".command-title");
const places = ["Home", "All patches", "Your agents", "People", "Integrations", "What’s new"];
const patchFrame = (page: Page): Frame =>
  page.frames().find((frame) => frame.url().includes("/~content/"))!;
const field = (page: Page) => page.frameLocator("#patch").getByRole("textbox", { name: "Field" });
/** The patch's field: whether it has focus, and its selection. */
const cursor = (page: Page) =>
  patchFrame(page).evaluate(() => {
    const input = window.document.getElementById("field") as HTMLInputElement;
    return [window.document.activeElement === input, input.selectionStart, input.selectionEnd];
  });
/**
 * Opens the menu with `title` lit. Right after a page loads, its list may still be on the way, and
 * a menu open when it lands keeps its selection, so this closes and opens again until it shows.
 */
const openAt = async (page: Page, title: string) => {
  await expect(async () => {
    if (!(await menu(page).isVisible())) await page.keyboard.press(chord);
    const shown = await lit(page).textContent({ timeout: 1_000 });
    if (shown === title) return;
    await page.keyboard.press("Escape");
    throw new Error(`${shown} is lit, not ${title}`);
  }).toPass({ timeout: 15_000 });
};
/** When the tab's copy of the list was last saved, in the page's clock. */
const savedAt = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("patchy.switcher") ?? "{}").savedAt as number | undefined
  );
/** Goes to `path` and waits for its switcher to keep the list it asked for. */
const listedAt = async (page: Page, path: string) => {
  const before = (await savedAt(page)) ?? 0;
  await page.goto(path);
  await expect.poll(() => savedAt(page)).toBeGreaterThan(before);
};
/** Opens `patch` and waits for its frame to take focus from the shell. */
const visit = async (page: Page, patch: { address: string }) => {
  await page.goto(patch.address);
  await expect(field(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.document.activeElement?.id)).toBe("patch");
};

test("over a patch, ⌘⇧K ↵ flips back, typing filters, and Escape puts the cursor back", async ({
  page,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  const sales = await publish(instance, "Sales HQ");
  await visit(page, crew);
  await visit(page, sales);
  await field(page).fill("hello world");
  await patchFrame(page).evaluate(() =>
    (window.document.getElementById("field") as HTMLInputElement).setSelectionRange(2, 5)
  );

  // The patch to flip back to comes first and lit; the patch on screen is never a row.
  await openAt(page, "Crew rota");
  await expect(search(page)).toBeFocused();
  await expect(titles(page)).not.toContainText(["Sales HQ"]);
  await expect(group(page, "This patch")).toHaveText(["Overview", "Versions", "Log", "Settings"]);
  await expect(group(page, "Patchy")).toHaveText(places);
  await expect(search(page)).toHaveAttribute(
    "aria-activedescendant",
    (await menu(page).locator('[aria-selected="true"]').getAttribute("id"))!
  );

  // Typing filters; nothing matching offers All patches.
  await page.keyboard.type("crew");
  await expect(titles(page)).toHaveText(["Crew rota"]);
  await page.keyboard.type("zzz");
  await expect(menu(page).getByRole("status")).toHaveText("No patches match “crewzzz”");
  await expect(titles(page)).toHaveText(["All patches"]);

  // Escape puts the cursor back in the patch's field, selection and all.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect.poll(() => cursor(page)).toEqual([true, 2, 5]);
  await page.keyboard.type("x");
  await expect(field(page)).toHaveValue("hex world");

  // ⌘⇧K ↵ flips back, and from there to the patch it left.
  await page.keyboard.press(chord);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(crew.address);
  await expect(field(page)).toBeVisible();
  await openAt(page, "Sales HQ");

  // The arrows wrap; the chord again closes it, as Escape does.
  await page.keyboard.press("ArrowUp");
  await expect(lit(page)).toHaveText("What’s new");
  await page.keyboard.press("ArrowDown");
  await expect(lit(page)).toHaveText("Sales HQ");
  await page.keyboard.press(chord);
  await expect(menu(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.document.activeElement?.id)).toBe("patch");

  // Inside the open menu the mouse works: hover lights a row, the scrim closes, a click opens.
  await page.keyboard.press(chord);
  await menu(page).getByRole("option", { name: "Versions" }).hover();
  await expect(lit(page)).toHaveText("Versions");
  await expect(search(page)).toBeFocused();
  await page.mouse.click(8, 8);
  await expect(menu(page)).toBeHidden();
  await page.keyboard.press(chord);
  await menu(page).getByRole("option", { name: "Versions" }).click();
  await expect(page).toHaveURL(new RegExp(`/patches/${crew.name}/versions$`));
});

test("opens on Home, flips to the patch the tab left, and puts focus back where it was", async ({
  page,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  await visit(page, crew);
  await page.goto(`${instance.origin}/patches`);
  const searchPatches = page.locator("#app-search");
  await searchPatches.fill("crew");
  await openAt(page, "Crew rota");
  // The page's own place isn't offered; there is no This patch off a patch.
  await expect(group(page, "Patchy")).toHaveText(places.filter((place) => place !== "All patches"));
  await expect(menu(page).getByRole("group", { name: "This patch" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(searchPatches).toBeFocused();

  await page.goto(`${instance.origin}/`);
  for (const button of await page.getByRole("button", { name: "Later" }).all())
    await button.click();
  await openAt(page, "Crew rota");
  await expect(group(page, "Patchy")).toHaveText(places.filter((place) => place !== "Home"));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(crew.address);
});

test("a guest's menu holds the patches shared with them, never This patch, and a revoked one goes on refresh", async ({
  page,
  context,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  const galley = await publish(instance, "Galley orders");
  await instance.guest(crew.patchId, true);
  await instance.guest(galley.patchId, true);
  await instance.session(context, "guest");
  await visit(page, crew);
  await visit(page, galley);
  await openAt(page, "Crew rota");
  // A shared patch says whose it is.
  await expect(menu(page).locator('[aria-selected="true"] .command-detail')).toHaveText(
    "Patchy Dev"
  );
  await expect(menu(page).getByRole("group", { name: "This patch" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The menu paints from the tab's copy at once; the refresh that lands replaces it.
  await instance.guest(crew.patchId, false);
  const answer = Promise.withResolvers<void>();
  await page.route("**/switcher.json", async (route) => {
    await answer.promise;
    await route.continue();
  });
  await page.reload();
  await page.keyboard.press(chord);
  await expect(lit(page)).toHaveText("Crew rota");
  answer.resolve();
  await expect(titles(page)).toHaveText(places);
  await expect(menu(page)).toBeVisible();
});

test("ignores another viewer's copy, and works with storage denied", async ({
  page,
  context,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  await visit(page, crew);
  await listedAt(page, `${instance.origin}/patches`);
  // A copy as the tab would keep it, naming a patch the list never had.
  const plant = (viewer: string) =>
    page.evaluate((viewer) => {
      const entry = JSON.parse(sessionStorage.getItem("patchy.switcher")!);
      entry.viewer = viewer;
      entry.list.viewer.id = viewer;
      entry.list.patches.push({
        ...entry.list.patches[0],
        id: "planted",
        name: "planted",
        title: "Secret plans"
      });
      entry.current = "planted";
      sessionStorage.setItem("patchy.switcher", JSON.stringify(entry));
    }, viewer);
  await page.route("**/switcher.json", () => {});
  await plant("usr_dev");
  await page.reload();
  await page.keyboard.press(chord);
  await expect(lit(page)).toHaveText("Secret plans");
  await plant("usr_colleague");
  await page.reload();
  await page.keyboard.press(chord);
  await expect(titles(page)).toHaveText(places.filter((place) => place !== "All patches"));
  await page.unroute("**/switcher.json");

  // Storage the browser refuses: the menu still lists, from memory.
  const denied = await context.newPage();
  await denied.addInitScript(() =>
    Object.defineProperty(window, "sessionStorage", {
      get: () => {
        throw new DOMException("Storage is disabled.", "SecurityError");
      }
    })
  );
  const sales = await publish(instance, "Sales HQ");
  await visit(denied, sales);
  await openAt(denied, "Crew rota");
});

test("a stale session gets its list back, a signed-out one forgets it, and an exhausted retry keeps it", async ({
  page,
  context,
  instance
}) => {
  let refresh: () => Promise<string | null> = () => instance.session(context);
  let refreshes = 0;
  await installSessionRefreshBoundary(context, () => {
    refreshes++;
    return refresh();
  });
  await page.clock.install();
  const crew = await publish(instance, "Crew rota");
  await visit(page, crew);
  const asked: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/switcher.json") asked.push(response.status());
  });
  const stale = async () => {
    await listedAt(page, `${instance.origin}/patches`);
    asked.length = 0;
    await instance.session(context, "expired");
    // Over a minute old, so opening asks again.
    await page.clock.fastForward(61_000);
  };

  // Refreshable: the session refreshes once and the list comes back, with what's new in it.
  await stale();
  await publish(instance, "Fuel log");
  await page.keyboard.press(chord);
  await expect.poll(() => asked).toEqual([401, 200]);
  await page.keyboard.type("fuel");
  await expect(titles(page)).toHaveText(["Fuel log"]);
  expect(refreshes).toBe(1);
  await page.keyboard.press("Escape");

  // Refreshed, but still stale: the copy stays.
  await stale();
  refresh = async () => {
    await instance.session(context, "expired");
    return "still-stale";
  };
  await page.keyboard.press(chord);
  await expect.poll(() => asked).toEqual([401, 401]);
  await expect(lit(page)).toHaveText("Crew rota");
  expect(await page.evaluate(() => sessionStorage.getItem("patchy.switcher"))).not.toBeNull();
  await page.keyboard.press("Escape");

  // Signed out: the list, the flip and the tab's copy all go.
  await instance.session(context);
  await stale();
  refresh = () => instance.session(context, "none");
  await page.keyboard.press(chord);
  await expect(titles(page)).toHaveText(places.filter((place) => place !== "All patches"));
  expect(await page.evaluate(() => sessionStorage.getItem("patchy.switcher"))).toBeNull();
});

test("on a host without the switcher the key is claimed and nothing opens; without its list, places only", async ({
  page,
  instance
}) => {
  await page.route("**/~shell/switcher.js*", (route) => route.fulfill({ status: 404 }));
  await page.goto(`${instance.origin}/patches`);
  await page.keyboard.press(chord);
  expect(
    await page.evaluate(() => (window as Window & { patchySwitcher?: unknown }).patchySwitcher)
  ).toBe(true);
  await expect(page.locator("#patchy-switcher")).toHaveCount(0);
  await page.unroute("**/~shell/switcher.js*");

  const crew = await publish(instance, "Crew rota");
  await visit(page, crew);
  await page.route("**/switcher.json", (route) =>
    route.fulfill({
      status: 404,
      contentType: "text/html",
      body: "<!doctype html><h1>Not found</h1>"
    })
  );
  await page.goto(`${instance.origin}/patches`);
  await page.keyboard.press(chord);
  await expect(titles(page)).toHaveText(places.filter((place) => place !== "All patches"));
});

test("a public patch's shell claims the key and loads no switcher", async ({ page, instance }) => {
  const open = await publish(instance, "Timetable", "public");
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  await visit(page, open);
  await field(page).click();
  await page.keyboard.press(chord);
  await page.keyboard.press("a");
  await expect(field(page)).toHaveValue("a");
  await expect(page.locator("#patchy-switcher")).toHaveCount(0);
  expect(requested).not.toContain("/~shell/switcher.js");
  expect(requested).not.toContain("/switcher.json");
});

test.describe("over the starting cover", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Tier 2 targets Chromium desktop.");

  /** A tier 2 patch, so it has a starting cover while its tools start. */
  const publishTool = async (instance: Instance) => {
    const server = await build({
      stdin: {
        contents: `import { query, createGuest, t } from "patchy/server";
export default createGuest({ rows: { count: query({ args: {}, result: t.number(), handler: () => 1 }) } });`,
        resolveDir: fileURLToPath(new URL("../../packages/patchy", import.meta.url)),
        sourcefile: "switcher-server.ts"
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      conditions: ["development"]
    });
    return instance.publish(
      "company",
      patchHtml("Tide tables"),
      undefined,
      {
        tier: 2,
        files: {},
        handlers: { "rows.count": { kind: "query", args: {}, result: { kind: "number" } } }
      },
      { server: server.outputFiles[0]!.text }
    );
  };

  test("the menu opens over the cover, and the cover clears behind it without taking focus", async ({
    page,
    instance
  }) => {
    const tool = await publishTool(instance);
    instance.holdStreamFrames(true);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.goto(tool.address, { waitUntil: "commit" });
    await expect.poll(() => instance.streamConnections.size).toBe(1);
    const cover = page.getByRole("dialog", { name: "Starting your tools" });
    await page.clock.fastForward(2_000);
    await expect(cover).toBeFocused();
    await page.keyboard.press(chord);
    await expect(search(page)).toBeFocused();
    // Closed while the cover is up, focus goes back to it.
    await page.keyboard.press("Escape");
    await expect(cover).toBeFocused();
    // Straight after the close, before the browser's own close event has come.
    await page.keyboard.press(chord);
    await expect(search(page)).toBeFocused();
    instance.holdStreamFrames(false);
    await expect(cover).toBeHidden();
    await expect(search(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => window.document.activeElement?.id)).toBe("patch");
  });

  test("a cover due while the menu is open waits for it to close", async ({ page, instance }) => {
    const tool = await publishTool(instance);
    instance.holdStreamFrames(true);
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.goto(tool.address, { waitUntil: "commit" });
    await expect.poll(() => instance.streamConnections.size).toBe(1);
    await page.keyboard.press(chord);
    await expect(search(page)).toBeFocused();
    const cover = page.getByRole("dialog", { name: "Starting your tools" });
    await page.clock.fastForward(2_000);
    await expect(cover).toBeHidden();
    await expect(search(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(cover).toBeFocused();
    instance.holdStreamFrames(false);
    await expect(cover).toBeHidden();
  });
});
