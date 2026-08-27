import { defineConfig, mergeConfig } from "vitest/config";
import postgresConfig from "./test/vitest.config.js";

export default mergeConfig(
  postgresConfig,
  defineConfig({
    test: {
      include: ["**/src/**/*.test.ts"]
    }
  })
);
