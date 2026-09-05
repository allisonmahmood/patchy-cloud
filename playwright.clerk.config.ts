import { defineConfig, devices } from "@playwright/test";
import { liveSettings } from "./packages/auth/live/fixtures.js";

liveSettings(process.env);

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: ".local/clerk-results",
  use: {
    ...devices["Desktop Chrome"],
    // Clerk's HTTP handshake needs Chrome, not HeadlessChrome, to retain Secure cookies.
    userAgent: devices["Desktop Chrome"].userAgent.replace("HeadlessChrome", "Chrome"),
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    // Auth traces contain session credentials; never persist or upload them.
    trace: "off",
    screenshot: "off",
    video: "off"
  }
});
