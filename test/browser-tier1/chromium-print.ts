import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import type { Cookie } from "@playwright/test";

/** CDP cannot print a same-process child frame. Kiosk-print the frame's own window.print()
 * in an isolated, off-screen browser, with Save as PDF rather than a physical printer. */
export async function printChromiumFrame(address: string, cookies: Cookie[], destination: string) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "patchy-chromium-print-"));
  const output = path.join(profile, "pdf");
  await mkdir(path.join(profile, "Default"));
  await mkdir(output);
  await writeFile(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({
      printing: {
        print_preview_sticky_settings: {
          appState: JSON.stringify({
            recentDestinations: [{ id: "Save as PDF", origin: "local", account: "" }],
            selectedDestinationId: "Save as PDF",
            version: 2
          })
        }
      },
      savefile: { default_directory: output }
    })
  );
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: chromium.executablePath(),
    args: ["--kiosk-printing", "--window-position=-20000,-20000", "--ozone-platform=x11"],
    viewport: { width: 1000, height: 800 }
  });
  try {
    await context.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
    });
    await context.addCookies(cookies);
    const page = context.pages()[0]!;
    const messages: string[] = [];
    page.on("console", (message) => messages.push(message.text()));
    await page.goto(address);
    await page.frameLocator("#patch").locator("#identity").waitFor();
    const frame = page.frames().find((entry) => entry.url().includes("/~content/"))!;
    await frame.evaluate(() => {
      const fixture = window as unknown as { harness: { printRows(): void } };
      fixture.harness.printRows();
      setTimeout(() => window.print(), 0);
    });
    const deadline = Date.now() + 30_000;
    while (true) {
      const name = (await readdir(output)).find((entry) => entry.endsWith(".pdf"));
      const pdf = name ? await readFile(path.join(output, name)) : undefined;
      if (pdf?.subarray(-1024).includes(Buffer.from("%%EOF"))) {
        await writeFile(destination, pdf);
        break;
      }
      if (Date.now() > deadline)
        throw new Error(
          `Native Chromium print did not save its PDF: ${messages.join("\\n")}; pages=${context.pages().map((entry) => entry.url())}`
        );
      await delay(100);
    }
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}
