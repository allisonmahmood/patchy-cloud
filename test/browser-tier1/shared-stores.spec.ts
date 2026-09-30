import { readFile } from "node:fs/promises";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, open } from "./fixtures.js";

test("shared-store refusals keep the consumer open and reshare recovers its byte reads", async ({
  page,
  instance
}) => {
  const files = { assets: { description: "Company reference files.", shared: true } };
  const source = await instance.publish("company", undefined, undefined, { files });
  const writer = await open(page, source);
  await writer.evaluate(async () => {
    await (window as unknown as FixtureWindow).harness.client.files.assets!.put(
      "nested/reference.txt",
      new TextEncoder().encode("Shared reference"),
      { contentType: "text/plain" }
    );
  });
  const consumer = await instance.publish("company", undefined, undefined, {
    files: {},
    uses: {
      library: {
        kind: "sharedStore",
        patchId: source.patchId,
        store: "assets",
        id: `${source.patchId}/assets`,
        revision: 1
      }
    }
  });
  const reader = await open(page, consumer);
  const read = () =>
    reader.evaluate(async () => {
      const store = (window as unknown as FixtureWindow).harness.client.shared.library;
      try {
        return new TextDecoder().decode(await store.get("nested/reference.txt"));
      } catch (error) {
        return typeof error === "object" && error !== null && "code" in error
          ? error.code
          : "unexpected_error";
      }
    });
  expect(await read()).toBe("Shared reference");
  expect(
    await reader.evaluate(() =>
      (window as unknown as FixtureWindow).harness.client.shared.library.url("nested/reference.txt")
    )
  ).toMatch(/^blob:/);
  const downloaded = page.waitForEvent("download");
  await reader.evaluate(() =>
    (window as unknown as FixtureWindow).harness.client.shared.library.download(
      "nested/reference.txt"
    )
  );
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("reference.txt");
  expect(await readFile((await download.path())!, "utf8")).toBe("Shared reference");
  await instance.publish(
    "company",
    undefined,
    source.patchId,
    {
      files: { assets: { ...files.assets, shared: false } }
    },
    { force: true }
  );
  expect(await read()).toBe("access_denied");
  expect(
    await reader.evaluate(async () => {
      try {
        await (window as unknown as FixtureWindow).harness.client.shared.library.url(
          "nested/reference.txt"
        );
        return "unexpected_success";
      } catch (error) {
        return typeof error === "object" && error !== null && "code" in error
          ? error.code
          : "unexpected_error";
      }
    })
  ).toBe("access_denied");
  await expect(page.locator("#patch")).toBeVisible();
  await instance.publish("company", undefined, source.patchId, { files });
  expect(await read()).toBe("Shared reference");
  expect(page.url()).toBe(consumer.address);
});
