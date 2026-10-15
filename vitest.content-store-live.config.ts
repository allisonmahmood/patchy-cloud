import { defineConfig } from "vitest/config";
import development from "./test/vitest.development.config.js";

// Not on test/vitest.config.ts on purpose: its offline setup rejects external HTTP requests.
export default defineConfig({
  ...development,
  test: {
    ...development.test,
    include: ["packages/content-store/live/**/*.live.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000
  }
});
