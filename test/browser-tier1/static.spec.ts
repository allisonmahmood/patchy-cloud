import { test, expect } from "./fixtures.js";

// A single file is a tier 1 page framed from its content URL, so `#sellers` names the page's own
// document and a same-page link scrolls it without loading anything.
test("a single-file page's same-page link scrolls within its frame", async ({ page, instance }) => {
  const patch = await instance.publish(
    "company",
    `<!doctype html><html lang="en"><head><title>List in numbers</title></head><body>
<nav><a href="#sellers">Who sells them</a></nav>
<div style="height: 3000px"></div>
<h2 id="sellers">Sellers</h2>
</body></html>`
  );
  expect((await page.goto(patch.address))?.status()).toBe(200);
  const frame = page.frameLocator("#patch");
  const sellers = frame.getByRole("heading", { name: "Sellers" });
  await expect(sellers).not.toBeInViewport();

  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await frame.getByRole("link", { name: "Who sells them" }).click();

  await expect(sellers).toBeInViewport();
  const [shell, content] = page.frames().map((candidate) => candidate.url());
  expect(shell).toBe(patch.address);
  expect(content).toMatch(new URL(`/~content/${patch.patchId}/`, patch.address).href);
  expect(content).toMatch(/#sellers$/);
  expect(requests).toEqual([]);
});
