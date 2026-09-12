import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { firefox } from "@playwright/test";
import type { Cookie } from "@playwright/test";

/** Print the sandboxed child document through window.print(), never the outer viewport.
 * An isolated browser writes to Mozilla's PDF printer, not a physical printer. */
export async function printFirefoxFrame(address: string, cookies: Cookie[], destination: string) {
  const browser = await firefox.launch({
    headless: false,
    firefoxUserPrefs: {
      "print.always_print_silent": true,
      print_printer: "Mozilla Save to PDF",
      "print.print_to_file": true,
      "print.print_to_filename": destination,
      "print.printer_Mozilla_Save_to_PDF.print_to_file": true,
      "print.printer_Mozilla_Save_to_PDF.print_to_filename": destination
    }
  });
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      return host === "127.0.0.1" || host === "localhost" ? route.continue() : route.abort();
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
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
      const pdf = await readFile(destination).catch(() => undefined);
      if (pdf?.subarray(-1024).includes(Buffer.from("%%EOF"))) break;
      if (Date.now() > deadline)
        throw new Error("The frame's native Firefox print did not save its PDF.");
      await delay(100);
    }
  } finally {
    await browser.close();
  }
}
