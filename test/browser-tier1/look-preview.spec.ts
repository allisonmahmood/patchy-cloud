import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { previewPage } from "../../packages/patchy/src/lookPreview.js";
import {
  LOOK_FIXTURES,
  embeddedFontFace,
  lookFixtureDir,
  readLookFixture
} from "../look-fixtures.js";

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

/** Whether an element draws an outline or a ring, as keyboard focus must. */
const drawsRing = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.outlineStyle !== "none" || style.boxShadow !== "none";
  });

for (const fixture of LOOK_FIXTURES) {
  test(`the ${fixture} look's specimen shows its states, fits a phone and makes no request`, async ({
    page
  }) => {
    const requests = await openPreview(page, lookFixtureDir(fixture));

    // The states row shows hover and keyboard focus at rest, as the look styles them.
    const resting = await look(page, ".state button >> text=Resting");
    expect(await look(page, "button.specimen-hover")).not.toBe(resting);
    expect(await look(page, "button.specimen-focus")).not.toBe(resting);

    // An invalid field and a disabled one each look unlike a resting field.
    const field = await look(page, '[aria-label="Resting field"]');
    expect(await look(page, '[aria-label="Invalid field"]')).not.toBe(field);
    expect(await look(page, '[aria-label="Disabled field"]')).not.toBe(field);

    // A disabled button ignores the pointer.
    const disabled = await look(page, ".state button:disabled");
    await page.locator(".state button:disabled").hover();
    expect(await look(page, ".state button:disabled")).toBe(disabled);

    // Real keyboard focus is visible: the first Tab lands on the first link and draws a ring.
    await page.keyboard.press("Tab");
    const policy = page.getByRole("link", { name: "spending policy" });
    await expect(policy).toBeFocused();
    expect(await drawsRing(policy)).toBe(true);

    // An invalid field focused from the keyboard keeps its invalid border.
    const invalid = page.getByLabel("Invalid field");
    const border = () => invalid.evaluate((element) => getComputedStyle(element).borderColor);
    const invalidBorder = await border();
    await page.getByLabel("Focused field").focus();
    await page.keyboard.press("Tab");
    await expect(invalid).toBeFocused();
    expect(await border()).toBe(invalidBorder);

    // The checkbox stays a small control beside its label, and Tab onto it draws a ring.
    const checkbox = page.getByRole("checkbox", { name: "Tell the budget owner" });
    expect(
      await checkbox.evaluate((element) => {
        // The label's text is everything after the checkbox inside its label.
        const after = document.createRange();
        after.selectNodeContents(element.parentNode ?? element);
        after.setStartAfter(element);
        const text = after.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return {
          narrower: box.width < text.width,
          sameLine: box.top < text.bottom && text.top < box.bottom
        };
      })
    ).toEqual({ narrower: true, sameLine: true });
    await page.getByLabel("Reason").focus();
    await page.keyboard.press("Tab");
    await expect(checkbox).toBeFocused();
    expect(await drawsRing(checkbox)).toBe(true);

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
  const fontFace = /@font-face\s*{[^}]*}/.exec(embeddedFontFace())?.[0];
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

/** Each frame's height while it shows its whole specimen without scrolling, else null. */
const fittedHeights = (page: Page) =>
  page.locator("iframe").evaluateAll((frames: HTMLIFrameElement[]) =>
    frames.map((frame) => {
      const document = frame.contentDocument;
      const bottom = document?.querySelector(".specimen")?.getBoundingClientRect().bottom;
      return document !== null &&
        bottom !== undefined &&
        frame.clientHeight >= bottom &&
        document.documentElement.scrollHeight <= frame.clientHeight
        ? frame.clientHeight
        : null;
    })
  );

// Comparing reads the look from an instance, so it renders through the pure page rather than the CLI.
test("a compare page frames each look alone, fits each frame to its look, and its frames refuse requests too", async ({
  page
}) => {
  const candidate = readLookFixture("linear");
  const company = readLookFixture("duolingo");
  const file = path.join(tempDir(), "compare.html");
  // A look's own full-height main, or a positioned body with uneven spacing, must neither grow
  // its frame without bound nor clip it.
  writeFileSync(
    file,
    previewPage(
      {
        files: {
          ...candidate,
          "look.css": `@import url("https://fonts.example.com/brand.css");\n${candidate["look.css"]}\n@layer look { main { min-height: 100vh; } }`
        },
        label: "Candidate"
      },
      {
        files: {
          ...company,
          "look.css": `${company["look.css"]}\n@layer look { body { position: relative; margin: 32px; padding-bottom: 64px; } main { height: 100vh; } }`
        },
        label: "Revision 1, the company's look"
      }
    )
  );
  const requests = await openFile(page, file);

  // One full-page screenshot holds both whole looks, side by side or stacked on a phone, and
  // frames shrink back when the window widens again.
  await expect.poll(() => fittedHeights(page)).toEqual([expect.any(Number), expect.any(Number)]);
  const wide = await fittedHeights(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await expect
    .poll(async () =>
      (await fittedHeights(page)).every((height, i) => height !== null && height > wide[i]!)
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => fittedHeights(page)).toEqual(wide);

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
  // A specimen's same-page link scrolls to its target, here the page around its fitted frame,
  // instead of loading this page into the frame.
  const specimen = page.frameLocator("iframe").first();
  await expect(specimen.locator("#vendors")).not.toBeInViewport();
  await specimen.getByRole("link", { name: "See all vendors" }).click();
  await expect(specimen.locator("#vendors")).toBeInViewport();
  expect(page.frames().map((frame) => frame.url())).toEqual([
    `file://${file}`,
    "about:srcdoc#vendors",
    "about:srcdoc"
  ]);
  expect(requests).toEqual([]);
});
