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
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The shortcut setting reaches a patch by its frame's name, which each engine sets for itself.
    // CI runs Chromium; these run here with `--project firefox` or `--project webkit`.
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: "shortcut-setting.spec.ts"
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testMatch: "shortcut-setting.spec.ts" }
  ]
});
