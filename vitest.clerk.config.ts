import { randomUUID } from "node:crypto";
import { defineConfig } from "vitest/config";
import { liveSettings } from "./packages/auth/live/fixtures.js";

process.env.CLERK_TEST_RUN_ID ??= randomUUID();
liveSettings(process.env);

export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    include: ["packages/auth/live/**/*.live.ts"],
    globalSetup: ["./test/postgres.ts", "./test/clerk.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
