import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import development from "./test/vitest.development.config.js";

// Not on test/vitest.config.ts on purpose: its offline setup rejects external HTTP requests.
// It keeps that config's Postgres template, which the store under test saves into.
export default defineConfig({
  ...development,
  test: {
    ...development.test,
    include: ["packages/integrations/live/Pidgeon*.live.ts"],
    globalSetup: fileURLToPath(new URL("./test/postgres.ts", import.meta.url)),
    fileParallelism: false,
    // The harness prints the run's call and mint counts, the account's shared budgets.
    silent: false,
    // A test can sit out the shared budget: a 429's Retry-After, or a full key count.
    testTimeout: 300_000,
    hookTimeout: 180_000
  }
});
