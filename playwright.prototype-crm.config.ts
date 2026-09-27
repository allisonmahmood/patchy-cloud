// PROTOTYPE for #315: the boundary proofs, `pnpm test:prototype-crm`.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/prototype-crm",
  testMatch: "*.spec.ts",
  globalSetup: "./test/prototype-crm/setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: ".local/prototype-crm-results/playwright",
  use: { actionTimeout: 15_000, navigationTimeout: 30_000, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }]
});
