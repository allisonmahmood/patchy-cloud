import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Download } from "../../packages/patchy/src/download.js";
import { test, expect } from "./fixtures.js";

const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
interface DownloadWindow extends Window {
  download: Download;
  outcome: string;
  retryDownload(): void;
  pendingDownloads: Record<string, string>;
}

test("generated files wait for shell approval on both tiers, refuse 21 MiB and stay shell-local", async ({
  page,
  instance,
  browserName
}) => {
  test.skip(browserName !== "chromium", "The SDK supports Chromium desktop.");
  // Only broker admission differs by tier and scope, so the full flow runs once and
  // the other configurations approve one small file.
  for (const [tier, scope, full] of [
    [1, "company", true],
    [1, "public", false],
    [2, "company", false]
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
    if (full) {
      const card = await cards
        .getByRole("region", { name: "résumé.csv", exact: true })
        .boundingBox();
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
    }
    const handedOff = page.waitForEvent("download");
    await cards.getByRole("button", { name: "Download", exact: true }).click();
    const file = await handedOff;
    expect(file.suggestedFilename()).toBe("résumé.csv");
    expect(await readFile((await file.path())!, "utf8")).toBe("name\r\nÉlodie");
    await expect
      .poll(() => content.evaluate(() => (window as unknown as DownloadWindow).outcome))
      .toBe("downloaded");
    if (full) {
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
      for (const inputKind of ["view", "buffer"] as const) {
        await content.evaluate((kind) => {
          const host = window as unknown as DownloadWindow;
          const encoded = new TextEncoder().encode("row\r\nvalue");
          const input = kind === "view" ? encoded : encoded.buffer;
          host.retryDownload = () => {
            host.outcome = "pending";
            void host.download("reused.csv", input).then(
              () => {
                host.outcome = "downloaded";
              },
              (error) => {
                host.outcome = error.details?.reason ?? error.code;
              }
            );
          };
          host.retryDownload();
        }, inputKind);
        await cards.getByRole("button", { name: "Not now", exact: true }).click();
        await expect
          .poll(() => content.evaluate(() => (window as unknown as DownloadWindow).outcome))
          .toBe("download_discarded");
        await content.evaluate(() => (window as unknown as DownloadWindow).retryDownload());
        await expect(cards.getByText("10 bytes", { exact: true })).toBeVisible();
        const retried = page.waitForEvent("download");
        await cards.getByRole("button", { name: "Download", exact: true }).click();
        expect(await readFile((await (await retried).path())!, "utf8")).toBe("row\r\nvalue");
      }
      await content.evaluate(() => {
        const host = window as unknown as DownloadWindow;
        host.pendingDownloads = {};
        for (const name of ["first-large.bin", "second-large.bin"]) {
          host.pendingDownloads[name] = "pending";
          void host.download(name, new ArrayBuffer(20 * 1024 * 1024)).catch((error) => {
            host.pendingDownloads[name] = error.details.reason ?? error.code;
          });
        }
      });
      for (const name of ["first-large.bin", "second-large.bin"])
        await expect(cards.getByRole("region", { name, exact: true })).toContainText("20 MB");
      expect(
        await content.evaluate(() => (window as unknown as DownloadWindow).pendingDownloads)
      ).toEqual({ "first-large.bin": "pending", "second-large.bin": "pending" });
      await cards
        .getByRole("region", { name: "first-large.bin", exact: true })
        .getByRole("button", { name: "Not now", exact: true })
        .click();
      await content.evaluate(() => {
        const host = window as unknown as DownloadWindow;
        host.pendingDownloads["replacement-large.bin"] = "pending";
        void host
          .download("replacement-large.bin", new ArrayBuffer(20 * 1024 * 1024))
          .catch((error) => {
            host.pendingDownloads["replacement-large.bin"] = error.details.reason ?? error.code;
          });
      });
      await expect(
        cards.getByRole("region", { name: "replacement-large.bin", exact: true })
      ).toContainText("20 MB");
      for (const name of ["second-large.bin", "replacement-large.bin"])
        await cards
          .getByRole("region", { name, exact: true })
          .getByRole("button", { name: "Not now", exact: true })
          .click();
      await expect
        .poll(() => content.evaluate(() => (window as unknown as DownloadWindow).pendingDownloads))
        .toEqual({
          "first-large.bin": "download_discarded",
          "second-large.bin": "download_discarded",
          "replacement-large.bin": "download_discarded"
        });
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
    }
    expect(
      instance.runtimeRequests
        .slice(requests)
        .filter((request) => request.body.includes('"op":"download.generated"'))
    ).toEqual([]);
  }
});
