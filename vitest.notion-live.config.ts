import { defineConfig } from "vitest/config";
import development from "./test/vitest.development.config.js";

export default defineConfig({
  ...development,
  test: {
    ...development.test,
    include: ["packages/integrations/live/Notion.live.ts"],
    testTimeout: 30_000
  }
});
