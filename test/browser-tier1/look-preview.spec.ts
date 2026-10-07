import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { previewPage } from "../../packages/patchy/src/lookPreview.js";
import { LOOK_FIXTURES, lookFixtureDir, readLookFixture } from "../look-fixtures.js";

// `patchy look preview` from the bundled CLI, opened as a person would: a file, offline. Needs no
// instance, so it uses Playwright's own `test` rather than this suite's instance fixtures.
const repo = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(repo, "packages/patchy/dist/index.js");
const scratch: string[] = [];
test.afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "patchy-look-preview-"));
  scratch.push(dir);
  return dir;
};

/** Writes the preview of a look folder and opens it with every network request refused and recorded. */
const openPreview = (page: Page, dir: string) => {
  const state = tempDir();
  const { path: file } = JSON.parse(
    execFileSync(process.execPath, [cli, "look", "preview", dir, "--json"], {
      env: { HOME: state, PATCHY_STATE_DIR: state }
    }).toString()
  ) as { path: string };
  return openFile(page, file);
};

const openFile = async (page: Page, file: string) => {
  const requests: string[] = [];
  await page.context().route(/^(?!file:|data:)/, (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.goto(`file://${file}`);
  await page.evaluate(() => document.fonts.ready);
  return requests;
};

/** What a state can change about an element, to tell a styled state from the resting one. */
const look = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluate((element) =>
      [
        "color",
        "backgroundColor",
        "borderColor",
        "outlineStyle",
        "boxShadow",
        "textDecorationLine",
        "filter",
        "opacity"
      ]
        .map((property) =>
          getComputedStyle(element).getPropertyValue(
            property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
          )
        )
        .join("|")
    );

for (const fixture of LOOK_FIXTURES) {
  test(`the ${fixture} look's specimen shows its states, fits a phone and makes no request`, async ({
    page
  }) => {
    const requests = await openPreview(page, lookFixtureDir(fixture));

    // The states row shows hover and keyboard focus at rest, as the look styles them.
    const resting = await look(page, ".state button >> text=Resting");
    expect(await look(page, "button.specimen-hover")).not.toBe(resting);
    expect(await look(page, "button.specimen-focus")).not.toBe(resting);

    // Real keyboard focus is visible: the first Tab lands on the first link and draws a ring.
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null) return null;
      const style = getComputedStyle(element);
      return { text: element.textContent, outline: style.outlineStyle, shadow: style.boxShadow };
    });
    expect(focused?.text).toBe("spending policy");
    expect(focused?.outline !== "none" || focused.shadow !== "none").toBe(true);

    // On a phone, long labels and non-Latin names wrap; only the table scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBe(0);
    await expect(page.getByText("王秀英")).toBeVisible();
    await expect(page.getByText("أحمد الفارسي")).toBeVisible();

    expect(requests).toEqual([]);
  });
}

test("a look's embedded font and logo render offline, and its remote URLs are never fetched", async ({
  page
}) => {
  const dir = path.join(tempDir(), "look");
  cpSync(lookFixtureDir("patchy"), dir, { recursive: true });
  const fontFace = /@font-face\s*{[^}]*}/.exec(
    readFileSync(path.join(repo, "packages/core/fixtures/accept/embedded-font.html"), "utf8")
  )?.[0];
  expect(fontFace).toBeDefined();
  const css = readFileSync(path.join(dir, "look.css"), "utf8");
  // Publish refuses the remote URLs; preview still renders, and the page's CSP refuses them too.
  writeFileSync(
    path.join(dir, "look.css"),
    [
      '@import url("https://fonts.example.com/brand.css");',
      fontFace,
      css.replace(/--look-font-body:[^;]+;/, '--look-font-body: "Inter", Georgia, serif;'),
      '@layer look { body { background-image: url("https://images.example.com/paper.png"); } }'
    ].join("\n")
  );
  const requests = await openPreview(page, dir);
  expect(
    await page.evaluate(() =>
      [...document.fonts].some(
        (font) => font.family.replaceAll('"', "") === "Inter" && font.status === "loaded"
      )
    )
  ).toBe(true);
  expect(
    await page.locator("img.logo").evaluate((image: HTMLImageElement) => image.naturalWidth)
  ).toBeGreaterThan(0);
  expect(requests).toEqual([]);
});

// The compare page needs a current look, so it renders through the pure page rather than the CLI.
test("a compare page frames each look alone, and its frames refuse requests too", async ({
  page
}) => {
  const candidate = readLookFixture("linear");
  const file = path.join(tempDir(), "compare.html");
  writeFileSync(
    file,
    previewPage(
      {
        files: {
          ...candidate,
          "look.css": `@import url("https://fonts.example.com/brand.css");\n${candidate["look.css"]}`
        },
        label: "Candidate"
      },
      { files: readLookFixture("duolingo"), label: "Revision 1, the company's look" }
    )
  );
  const requests = await openFile(page, file);
  const panes = await Promise.all(
    page
      .frames()
      .filter((frame) => frame !== page.mainFrame())
      .map((frame) =>
        frame.evaluate(() => ({
          label: document.querySelector(".pane-label strong")?.textContent,
          background: getComputedStyle(document.body).backgroundColor
        }))
      )
  );
  expect(panes).toEqual([
    { label: "Candidate", background: "rgb(8, 9, 10)" },
    { label: "Revision 1, the company's look", background: "rgb(255, 255, 255)" }
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBe(0);
  expect(requests).toEqual([]);
});
