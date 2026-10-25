import { defineConfig } from "vitest/config";
import base from "../../../test/vitest.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["prototype.test.ts", "catalog.test.ts", "render.test.ts"],
    testTimeout: 30_000
  }
});
