import { defineConfig } from "vitest/config";

// Standalone on purpose: the offline setup rejects external HTTP requests.
export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    include: ["packages/content-store/live/**/*.live.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000
  }
});
