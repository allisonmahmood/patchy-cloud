import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development"]
  },
  test: {
    // Multi-session SDK invariants have their own mandatory real-Postgres job.
    exclude: [...configDefaults.exclude, "**/*.postgres.test.ts"],
    setupFiles: [fileURLToPath(new URL("./setup.ts", import.meta.url))],
    globalSetup: fileURLToPath(new URL("./postgres.ts", import.meta.url))
  }
});
