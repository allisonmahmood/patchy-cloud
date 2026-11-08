import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { test, expect, installSessionRefreshBoundary } from "./fixtures.js";
import type { Instance } from "./instance.js";

// Patchy's switcher on Mod+Shift+K: the menu over a running patch and on Patchy's own pages.
// Playwright's key presses are trusted, as a person's are; on Linux, where these run, Mod is Ctrl.
const chord = "ControlOrMeta+Shift+K";
const tier1 = { tier: 1, tables: {}, files: {} } as const;
// Each patch says in the console every key its own listeners hear, and when its form submits.
const patchHtml = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title><script>
for (const type of ["keydown", "keyup"]) addEventListener(type, (event) => console.log("patch heard " + type + " " + event.key), true);
</script></head><body><h1>${title}</h1><form onsubmit="console.log('patch submitted'); return false"><input id="field" aria-label="Field"></form></body></html>`;
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
/** The patch's field: whether it has the keyboard, and its selection. */
const cursor = (page: Page) =>
  patchFrame(page).evaluate(() => {
    const input = window.document.getElementById("field") as HTMLInputElement;
    const focused = window.document.hasFocus() && window.document.activeElement === input;
    return [focused, input.selectionStart, input.selectionEnd];
  });
/** The patch's console lines: the keys its own listeners heard, and its form's submits. */
const patchLines = (page: Page) => {
  const lines: string[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("patch ")) lines.push(message.text());
  });
  return lines;
};
/** Opens the menu with `title` lit, the list having filled it. */
const openAt = async (page: Page, title: string) => {
  await page.keyboard.press(chord);
  await expect(lit(page)).toHaveText(title);
};
/** When the tab's copy of the list was last saved, in the page's clock; none on a blank tab. */
const savedAt = (page: Page) =>
  page.evaluate(() => {
    try {
      return JSON.parse(sessionStorage.getItem("patchy.switcher") ?? "{}").savedAt as
        number | undefined;
    } catch {
      return undefined;
    }
  });
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
  await expect(search(page)).toBeFocused();
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

test("⌘⇧K ↵ flips back three times running, and an ↵ before the menu has the keyboard never reaches the patch", async ({
  page,
  instance
}) => {
  const lines = patchLines(page);
  const crew = await publish(instance, "Crew rota");
  const sales = await publish(instance, "Sales HQ");
  await visit(page, crew);
  await visit(page, sales);
  for (const [from, to] of [
    [sales, crew],
    [crew, sales],
    [sales, crew]
  ] as const) {
    await expect(page).toHaveURL(from.address);
    await field(page).click();
    await page.keyboard.press(chord);
    await expect(search(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(to.address);
    await expect(field(page)).toBeVisible();
  }
  // The two presses back to back, as fast as the browser takes them: an Enter that comes before
  // the menu has the keyboard is dropped, never the patch's, and one that comes after flips.
  await field(page).click();
  await page.keyboard.press(chord);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => page.url() === sales.address || (await search(page).isVisible()))
    .toBe(true);
  // Let anything the patch heard reach the console.
  await page.waitForTimeout(200);
  expect(lines.filter((line) => /Enter|submitted/.test(line))).toEqual([]);
});

test("the switcher itself tells the patch it is there, so keys around a slow open stay the menu's", async ({
  page,
  instance
}) => {
  const lines = patchLines(page);
  const crew = await publish(instance, "Crew rota");
  // A patch that keeps telling itself it lost focus, to release keys meant for the menu.
  const blurry = await instance.publish(
    "company",
    `<!doctype html><title>Blurry</title><script>
addEventListener("keydown", (event) => console.log("patch heard keydown " + event.key), true);
setInterval(() => { dispatchEvent(new Event("blur")); document.dispatchEvent(new Event("blur")); }, 20);
</script><form onsubmit="console.log('patch submitted'); return false"><input id="field" aria-label="Field"></form>`,
    undefined,
    tier1
  );
  await visit(page, crew);
  await visit(page, blurry);
  // Readiness comes from the switcher alone: the broker, of this release or #1298's, never answers
  // hello. The menu is slow to open, 600 ms after the relay asks, while the patch still has focus.
  await page.evaluate(() => {
    const shell = window as Window & { patchySwitcher?: { open(): void; toggle(): void } };
    const switcher = shell.patchySwitcher!;
    shell.patchySwitcher = { open: () => setTimeout(switcher.open, 600), toggle: switcher.toggle };
  });
  await field(page).click();
  await page.keyboard.press(chord);
  await page.keyboard.press("Enter");
  await expect(search(page)).toBeFocused();
  // Let anything the patch heard reach the console.
  await page.waitForTimeout(200);
  // The Enter came before the menu had the keyboard: dropped, never the patch's, and no flip.
  expect(lines.filter((line) => /Enter|submitted/.test(line))).toEqual([]);
  await expect(page).toHaveURL(blurry.address);
});

test("a patch that grabs focus back never leaves the menu up while typing goes to the patch", async ({
  page,
  instance
}) => {
  const lines = patchLines(page);
  const crew = await publish(instance, "Crew rota");
  // Whenever it loses focus, it tries to take it back a moment later.
  const grabby = await instance.publish(
    "company",
    `<!doctype html><title>Grabby</title><input id="field" aria-label="Field"><script>
addEventListener("blur", () => setTimeout(() => { window.focus(); document.getElementById("field").focus(); console.log("patch grabbed"); }, 400));
</script>`,
    undefined,
    tier1
  );
  await visit(page, crew);
  await visit(page, grabby);
  await field(page).click();
  await page.keyboard.press(chord);
  await expect(menu(page)).toBeVisible();
  await expect.poll(() => lines).toContain("patch grabbed");
  await page.keyboard.type("private");
  // Chromium lets the patch take focus, and the menu closes; Firefox keeps an inert frame from
  // taking it, and the keys stay in the menu. Never the menu up with the keys in the patch.
  if (await menu(page).isVisible()) {
    await expect(search(page)).toHaveValue("private");
    await expect(field(page)).toHaveValue("");
  } else await expect(field(page)).toHaveValue("private");
});

test("a list that lands once the menu is open lights the flip, unless the person moved first", async ({
  page,
  context,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  const sales = await publish(instance, "Sales HQ");
  await visit(page, crew);
  for (const moved of ["nothing", "the arrows", "the pointer"] as const) {
    // A fresh tab keeps nothing yet, so the menu opens on Patchy's places alone.
    const fresh = await context.newPage();
    const answer = Promise.withResolvers<void>();
    await fresh.route("**/switcher.json", async (route) => {
      await answer.promise;
      await route.continue();
    });
    await visit(fresh, sales);
    await fresh.keyboard.press(chord);
    await expect(lit(fresh)).toHaveText("Home");
    if (moved === "the arrows") await fresh.keyboard.press("ArrowDown");
    // Pointing at the row already lit chooses it too.
    if (moved === "the pointer") await lit(fresh).hover();
    answer.resolve();
    await expect(titles(fresh).first()).toHaveText("Crew rota");
    await expect(lit(fresh)).toHaveText(
      { nothing: "Crew rota", "the arrows": "All patches", "the pointer": "Home" }[moved]
    );
    await fresh.close();
  }
});

test("a click on the field's glyph or the panel leaves the keys working", async ({
  page,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  const sales = await publish(instance, "Sales HQ");
  await visit(page, crew);
  await visit(page, sales);
  await openAt(page, "Crew rota");
  await menu(page).getByText("This patch", { exact: true }).click();
  await expect(search(page)).toBeFocused();
  await menu(page).locator(".command-field .glyph").click();
  await expect(search(page)).toBeFocused();
  await page.keyboard.type("cre");
  await expect(titles(page)).toHaveText(["Crew rota"]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(crew.address);
});

test("signing out forgets the tab's list before the browser leaves", async ({
  page,
  context,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  await visit(page, crew);
  await listedAt(page, `${instance.origin}/patches`);
  // Stand in for Clerk's sign-out past the form, as tier1.spec does; the page is left either way.
  await context.route("**/logout", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Signed out</title>" })
  );
  await page.locator(".app-account").click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveTitle("Signed out");
  expect(await page.evaluate(() => sessionStorage.getItem("patchy.switcher"))).toBeNull();
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

test("someone who has opened nothing yet sees patches with nothing typed, none of them lit", async ({
  page,
  context,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  await publish(instance, "Bunk plan");
  await instance.guest(crew.patchId, true);
  // A colleague new to the company: its patches, by title, and Patchy's first place lit.
  await instance.session(context, "colleague");
  await listedAt(page, `${instance.origin}/patches`);
  await page.keyboard.press(chord);
  await expect(titles(page)).toHaveText([
    "Bunk plan",
    "Crew rota",
    ...places.slice(0, 1),
    ...places.slice(2)
  ]);
  await expect(lit(page)).toHaveText("Home");
  await page.keyboard.press("Escape");
  // A guest: what's shared with them, named with its company.
  await instance.session(context, "guest");
  await listedAt(page, `${instance.origin}/patches`);
  await page.keyboard.press(chord);
  const first = menu(page).locator('[role="option"]').first();
  await expect(first.locator(".command-title")).toHaveText("Crew rota");
  await expect(first.locator(".command-detail")).toHaveText("Patchy Dev");
  await expect(lit(page)).toHaveText("Home");
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

test("a signed-in person opens the switcher on a notice and leaves; signed out, it only claims the key", async ({
  page,
  context,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  await visit(page, crew);
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) blocked.push(message.text());
  });
  const notice = `${instance.origin}/~shell/notice/stream_replaced?return=${encodeURIComponent(new URL(crew.address).pathname)}`;
  await listedAt(page, notice);
  await expect(page.locator('[data-notice="stream_replaced"]')).toBeVisible();
  await openAt(page, "Crew rota");
  // A notice is none of Patchy's places, and no patch is on screen.
  await expect(group(page, "Patchy")).toHaveText(places);
  await expect(menu(page).getByRole("group", { name: "This patch" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(crew.address);
  expect(blocked).toEqual([]);

  await instance.session(context, "none");
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  await page.goto(notice);
  await expect(page.locator('[data-notice="stream_replaced"]')).toBeVisible();
  await page.keyboard.press(chord);
  expect(
    await page.evaluate(() => (window as Window & { patchySwitcher?: unknown }).patchySwitcher)
  ).toBe(true);
  await expect(page.locator("#patchy-switcher")).toHaveCount(0);
  expect(requested).not.toContain("/~shell/switcher.js");
  expect(requested).not.toContain("/switcher.json");
});

test("on a patch's needs-rebuild notice, the menu treats that patch as the one on screen", async ({
  page,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  const sales = await publish(instance, "Sales HQ");
  await visit(page, crew);
  await visit(page, sales);
  await instance.platform.query("UPDATE patch_versions SET wire_version=999 WHERE id=$1", [
    sales.versionId
  ]);
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) blocked.push(message.text());
  });
  expect((await page.goto(sales.address))?.status()).toBe(409);
  await expect(page.locator('[data-notice="needs_rebuild"]')).toBeVisible();
  // Never a row, never the flip: Enter goes back to the patch before it, not to this notice.
  await openAt(page, "Crew rota");
  await expect(titles(page)).not.toContainText(["Sales HQ"]);
  await expect(group(page, "This patch")).toHaveText(["Overview", "Versions", "Log", "Settings"]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(crew.address);
  expect(blocked).toEqual([]);
});

test("a member leaves their company's public patch with the key; anyone else's shell loads no switcher", async ({
  page,
  context,
  instance
}) => {
  const crew = await publish(instance, "Crew rota");
  const open = await publish(instance, "Timetable");
  // Its guest, granted while it was company-only: a public patch takes no new guests.
  await instance.guest(open.patchId, true);
  await instance.share(open.patchId, "public");
  // The company's own member opens it as any company patch: ⌘⇧K ↵ flips back.
  await visit(page, crew);
  await visit(page, open);
  await openAt(page, "Crew rota");
  await expect(group(page, "This patch")).toHaveText(["Overview", "Versions", "Log", "Settings"]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(crew.address);

  // Signed out, or its guest from another company: no switcher, so the patch keeps every key.
  for (const user of ["none", "guest"] as const) {
    await instance.session(context, user);
    const requested: string[] = [];
    const record = (request: { url(): string }) => requested.push(new URL(request.url()).pathname);
    page.on("request", record);
    await visit(page, open);
    await field(page).click();
    await page.keyboard.press(chord);
    await page.keyboard.press("a");
    await expect(field(page)).toHaveValue("a");
    await expect(page.locator("#patchy-switcher")).toHaveCount(0);
    expect(requested).not.toContain("/~shell/switcher.js");
    expect(requested).not.toContain("/switcher.json");
    page.off("request", record);
  }
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
