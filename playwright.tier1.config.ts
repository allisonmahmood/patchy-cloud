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
  reporter: "list",
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
    { name: "firefox", use: { ...devices["Desktop Firefox"] } }
  ]
});
