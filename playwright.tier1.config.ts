import { defineConfig, devices } from "@playwright/test";

// Tests that fail only in desktop Chromium for a reason in the test itself, held in the headless
// shell until they're fixed. The local hotkeys test reads the patch's accessibility tree through
// `Page.getFrameTree`, which leaves out a frame in its own process.
const headlessShellOnly = /local hotkeys: the narrowest place wins/;

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
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
      grepInvert: headlessShellOnly
    },
    { name: "chromium-headless-shell", use: devices["Desktop Chrome"], grep: headlessShellOnly }
  ]
});
