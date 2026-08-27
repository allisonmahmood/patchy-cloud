import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["development"]
  },
  test: {
    globalSetup: fileURLToPath(new URL("./postgres.ts", import.meta.url))
  }
});
