import type { Page } from "@playwright/test";
import { test, expect, prepare } from "./fixtures.js";

const tier1 = { tier: 1, tables: {}, files: {} } as const;
const html = (title: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

/** How wide a table's column is, by its header, in the table's first row. */
const columnWidth = (page: Page, table: string, header: string) =>
  page.getByRole("table", { name: table }).evaluate((element, header) => {
    const index = [...element.querySelectorAll("thead th")].findIndex(
      (cell) => cell.textContent === header
    );
    return element.querySelector(`tbody tr > :nth-child(${index + 1})`)!.getBoundingClientRect()
      .width;
  }, header);

test("Needs attention and Retired and deleted keep their reasons and states readable, and a phone scrolls the table", async ({
  browser,
  instance
}) => {
  const retired = await instance.publish("company", html("Desk map"), undefined, tier1);
  await instance.lifecycle(retired.patchId, "retire");
  await instance.publish("company", html("Lunch rota"), undefined, tier1);
  // Their owner deactivated, both need the colleague, made an admin.
  await instance.platform.query("UPDATE users SET role='admin' WHERE id='usr_colleague'");
  await instance.platform.query("UPDATE users SET deactivated_at=now() WHERE id='usr_dev'");
  for (const phone of [false, true]) {
    const context = await browser.newContext(
      phone
        ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
        : { viewport: { width: 1280, height: 800 } }
    );
    try {
      await prepare(context, instance);
      await instance.session(context, "colleague");
      const page = await context.newPage();
      // Each keeps a 14rem line, and the patch beside it a 10rem one, so no word breaks.
      for (const [show, table, header] of [
        ["attention", "Patches that need attention", "Why it’s here"],
        ["off", "Retired and deleted patches", "State"]
      ] as const) {
        await page.goto(`${instance.origin}/patches?show=${show}`);
        expect(await columnWidth(page, table, header)).toBeGreaterThanOrEqual(224);
        expect(await columnWidth(page, table, "Patch")).toBeGreaterThanOrEqual(160);
        // Wider than a phone, the table scrolls in its wrapper; the page never does.
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
          phone ? 390 : 1280
        );
      }
    } finally {
      await context.close();
    }
  }
});
