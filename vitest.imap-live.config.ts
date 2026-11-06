import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import development from "./test/vitest.development.config.js";

// Not on test/vitest.config.ts on purpose: its offline setup rejects external HTTP requests, and
// this tier reaches mail servers in Docker. It keeps that config's Postgres template, which the
// store under test saves into.
export default defineConfig({
  ...development,
  test: {
    ...development.test,
    include: ["packages/integrations/live/Imap*.live.ts"],
    globalSetup: [
      fileURLToPath(new URL("./test/postgres.ts", import.meta.url)),
      fileURLToPath(new URL("./packages/integrations/live/imapHarness.ts", import.meta.url))
    ],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000
  }
});
