import { test, expect } from "./fixtures.js";

// A single-file page, as stored tier 0 pages now are: tier 1 with no tables, files or SDK. Its
// frame loads its content URL, so a same-page link scrolls within the document it names.
test("a single-file page opens in the scripted frame and its same-page link scrolls", async ({
  page,
  instance
}) => {
  const patch = await instance.publish(
    "company",
    `<!doctype html><html lang="en"><head><title>List in numbers</title></head><body>
<nav><a href="#sellers">Who sells them</a></nav>
<div style="height: 3000px"></div>
<h2 id="sellers">Sellers</h2>
</body></html>`,
    undefined,
    { tier: 1, tables: {}, files: {} }
  );
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const shell = page.locator("#patch");
  await expect(shell).toHaveAttribute("sandbox", "allow-scripts allow-modals");
  await expect(shell).toHaveAttribute("data-content-src", /^\/~content\//);
  await expect(shell).not.toHaveAttribute("srcdoc", /.*/);
  const frame = page.frameLocator("#patch");
  const sellers = frame.getByRole("heading", { name: "Sellers" });
  await expect(sellers).not.toBeInViewport();

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await frame.getByRole("link", { name: "Who sells them" }).click();

  await expect(sellers).toBeInViewport();
  expect(page.frames()[1]?.url()).toMatch(/\/~content\/[^#]+#sellers$/);
  expect(requests).toEqual([]);
});
