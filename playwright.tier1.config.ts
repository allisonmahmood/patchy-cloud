import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser-tier1",
  testMatch: "*.spec.ts",
  globalSetup: "./test/browser-tier1/setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // On CI, failures also become annotations, which the weekly flake report counts.
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  outputDir: ".local/tier1-results",
  use: {
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    acceptDownloads: true,
    trace: "off",
    screenshot: "off",
    video: "off"
  },
  projects: [
    // Desktop Chromium in new headless mode, the browser people use. Playwright's default headless
    // build, chrome-headless-shell, keeps a patch's sandboxed frame in the shell's process, so
    // focus and keyboard behaviour that breaks in desktop Chromium passes there.
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    // Firefox runs focus.spec.ts alone. It won't hand a patch's frame focus during the key event
    // that pressed a shell button, so the shell tries again once that is over; Chromium never
    // needs the second try. Fission isolation is on, as in Firefox, though Playwright's is off.
    {
      name: "firefox",
      testMatch: "focus.spec.ts",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: { firefoxUserPrefs: { "fission.webContentIsolationStrategy": 1 } }
      }
    }
  ]
});
