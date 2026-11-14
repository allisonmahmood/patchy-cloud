import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import development from "./test/vitest.development.config.js";

// Not on test/vitest.config.ts on purpose: its offline setup rejects external HTTP requests, and
// this tier reads GitHub. It keeps that config's Postgres template, which the store under test
// saves into.
export default defineConfig({
  ...development,
  test: {
    ...development.test,
    include: ["packages/integrations/live/Github*.live.ts"],
    globalSetup: fileURLToPath(new URL("./test/postgres.ts", import.meta.url)),
    fileParallelism: false,
    // The harness prints the run's read count: the installation's budget is shared.
    silent: false,
    testTimeout: 180_000,
    hookTimeout: 180_000
  }
});
