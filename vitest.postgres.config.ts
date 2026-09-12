import { configDefaults, defineConfig } from "vitest/config";
import postgresConfig from "./test/vitest.config.js";

// Opt in explicitly: ordinary package discovery must never send this block to PGlite.
export default defineConfig({
  ...postgresConfig,
  test: {
    ...postgresConfig.test,
    include: ["**/src/**/*.postgres.test.ts"],
    exclude: configDefaults.exclude,
    passWithNoTests: false
  }
});
