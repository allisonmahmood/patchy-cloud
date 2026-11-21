import { defineConfig, mergeConfig } from "vitest/config";
import postgresConfig from "./test/vitest.config.js";

export default mergeConfig(
  postgresConfig,
  defineConfig({
    test: {
      include: [
        "**/src/**/*.test.ts",
        "apps/docs/lib/**/*.test.ts",
        "apps/docs/*.test.ts",
        "lint/**/*.test.ts",
        "scripts/*.test.ts"
      ]
    }
  })
);
