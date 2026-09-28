import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development"]
  },
  test: {
    // Real-Postgres concurrency and live service contracts have separate opt-in jobs.
    exclude: [...configDefaults.exclude, "**/*.postgres.test.ts", "**/*.live.ts"],
    setupFiles: [fileURLToPath(new URL("./setup.ts", import.meta.url))],
    globalSetup: fileURLToPath(new URL("./postgres.ts", import.meta.url))
  }
});
