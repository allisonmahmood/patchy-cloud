import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Download } from "../../packages/patchy/src/download.js";
import { test, expect } from "./fixtures.js";

const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
interface DownloadWindow extends Window {
  download: Download;
  outcome: string;
}

test("generated files wait for shell approval on both tiers, refuse 21 MiB and stay shell-local", async ({
  page,
  instance,
  browserName
}) => {
  test.skip(browserName !== "chromium", "The SDK supports Chromium desktop.");
  for (const [tier, scope] of [
    [1, "company"],
    [1, "public"],
    [2, "company"]
  ] as const) {
    const built = await build({
      stdin: {
        contents: `import { createClient, createServerClient } from "patchy/client";
const client = ${tier === 2 ? "createServerClient()" : "createClient({tables:{},files:{},uses:{}},{shared:{},connections:{}})"};
window.download = client.download; window.outcome = "idle";`,
        resolveDir: packageRoot
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife"
    });
    const server =
      tier === 2
        ? await build({
            stdin: {
              contents:
                'import { createGuest } from "patchy/server"; export default createGuest({});',
              resolveDir: packageRoot
            },
            bundle: true,
            write: false,
            platform: "browser",
            format: "esm"
          })
        : undefined;
    const patch = await instance.publish(
      scope,
      `<!doctype html><html><head><title>Generated reports</title></head><body><h1>Generated reports</h1><script>${built.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`,
      undefined,
      { tier, tables: {}, files: {}, uses: {}, ...(tier === 2 ? { handlers: {} } : {}) },
      server ? { server: server.outputFiles[0]!.text } : undefined
    );
    await page.goto(patch.address);
    const frame = page.frameLocator("#patch");
    await expect(frame.getByRole("heading", { name: "Generated reports" })).toBeVisible();
    const content = page.frames().find((candidate) => candidate.url().includes("/~content/"))!;
    const cards = page.locator(".shell-corner");
    const requests = instance.runtimeRequests.length;
    await content.evaluate(() => {
      const host = window as unknown as DownloadWindow;
      host.outcome = "pending";
      void host.download("résumé.csv", new Blob(["name\r\nÉlodie"], { type: "text/csv" })).then(
        () => {
          host.outcome = "downloaded";
        },
        (error) => {
          host.outcome = error.code;
        }
      );
    });
    await expect(cards.getByText("résumé.csv", { exact: true })).toBeVisible();
    await expect(cards.getByText("13 bytes", { exact: true })).toBeVisible();
    const card = await cards.getByRole("region", { name: "résumé.csv", exact: true }).boundingBox();
    const viewport = page.viewportSize()!;
    expect(card!.x).toBeGreaterThanOrEqual(0);
    expect(card!.y).toBeGreaterThanOrEqual(0);
    expect(card!.x + card!.width).toBeLessThanOrEqual(viewport.width);
    expect(card!.y + card!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.locator("#patch").boundingBox()).toEqual({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height
    });
    await cards
      .getByRole("button", { name: "Download", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    expect(await content.evaluate(() => (window as unknown as DownloadWindow).outcome)).toBe(
      "pending"
    );
    const handedOff = page.waitForEvent("download");
    await cards.getByRole("button", { name: "Download", exact: true }).click();
    const file = await handedOff;
    expect(file.suggestedFilename()).toBe("résumé.csv");
    expect(await readFile((await file.path())!, "utf8")).toBe("name\r\nÉlodie");
    await expect
      .poll(() => content.evaluate(() => (window as unknown as DownloadWindow).outcome))
      .toBe("downloaded");
    await content.evaluate(() => {
      const host = window as unknown as DownloadWindow;
      host.outcome = "pending";
      void host.download("discard.bin", new Uint8Array([1, 2, 3]).subarray(1)).catch((error) => {
        host.outcome = error.details.reason;
      });
    });
    await cards.getByRole("button", { name: "Not now", exact: true }).click();
    await expect
      .poll(() => content.evaluate(() => (window as unknown as DownloadWindow).outcome))
      .toBe("download_discarded");
    const refusal = await content.evaluate(async () => {
      try {
        await (window as unknown as DownloadWindow).download(
          "too-large.bin",
          new Uint8Array(21 * 1024 * 1024)
        );
        return null;
      } catch (error) {
        const failure = error as { code: string; limitId: string; value: number };
        return { code: failure.code, limitId: failure.limitId, value: failure.value };
      }
    });
    expect(refusal).toEqual({
      code: "too_large",
      limitId: "download.bytes",
      value: 20 * 1024 * 1024
    });
    await expect(cards.getByRole("alert")).toContainText("too-large.bin");
    await expect(cards.getByRole("alert")).toContainText("20 MiB");
    await expect(cards.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
    await cards.getByRole("button", { name: "Dismiss", exact: true }).click();
    await content.evaluate(() => {
      const host = window as unknown as DownloadWindow;
      host.outcome = "pending";
      void host.download("at-limit.bin", new ArrayBuffer(20 * 1024 * 1024)).then(() => {
        host.outcome = "downloaded";
      });
    });
    const boundary = page.waitForEvent("download");
    await cards.getByRole("button", { name: "Download", exact: true }).click();
    expect((await readFile((await (await boundary).path())!)).byteLength).toBe(20 * 1024 * 1024);
    await expect
      .poll(() => content.evaluate(() => (window as unknown as DownloadWindow).outcome))
      .toBe("downloaded");
    expect(
      instance.runtimeRequests
        .slice(requests)
        .filter((request) => request.body.includes('"op":"download.generated"'))
    ).toEqual([]);
  }
});
