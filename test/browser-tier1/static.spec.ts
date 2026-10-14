import { test, expect } from "./fixtures.js";

// A static page sits in a srcdoc frame, where `#sellers` would otherwise name the shell's own
// address and load it into the frame, which Patchy's frame-ancestors refuses.
test("a static page's same-page link scrolls within its frame", async ({ page, instance }) => {
  const patch = await instance.publish(
    "company",
    `<!doctype html><html lang="en"><head><title>List in numbers</title></head><body>
<nav><a href="#sellers">Who sells them</a></nav>
<div style="height: 3000px"></div>
<h2 id="sellers">Sellers</h2>
</body></html>`,
    undefined,
    { tier: 0, tables: {}, files: {} }
  );
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const frame = page.frameLocator("#patch");
  const sellers = frame.getByRole("heading", { name: "Sellers" });
  await expect(sellers).not.toBeInViewport();

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await frame.getByRole("link", { name: "Who sells them" }).click();

  await expect(sellers).toBeInViewport();
  expect(page.frames().map((candidate) => candidate.url())).toEqual([
    patch.address,
    "about:srcdoc#sellers"
  ]);
  expect(requests).toEqual([]);
});
