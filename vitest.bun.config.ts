import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

/**
 * The offline suite on Bun, the runtime production runs the server on:
 * `pnpm test:bun`, CI's `test (bun)`. The Node matrix still runs every file,
 * because the CLI ships these packages to people's Node.
 *
 * Left out, because they only ever run on Node:
 * - the CLI's process and dev-loop tests, which run the CLI as people do on their
 *   own Node: through `process.execPath` with Node-only flags such as
 *   `--input-type=module --eval`, Node's own HTTP dispatcher, and the repo's
 *   Vite resolved the way Node resolves it;
 * - the SDK's install tests, which spawn `process.execPath` the same way;
 * - the lint rules' tests, because Oxlint's RuleTester runs only on Node.
 */
const nodeOnly = [
  "packages/patchy/src/cli.test.ts",
  "packages/patchy/src/cliLifecycle.test.ts",
  "packages/patchy/src/cliLook.test.ts",
  "packages/patchy/src/cliPublish.test.ts",
  "packages/patchy/src/cliRepo.test.ts",
  "packages/patchy/src/cliRepoBuild.test.ts",
  "packages/patchy/src/cliRepoDescriptions.test.ts",
  "packages/patchy/src/cliRepoPublish.test.ts",
  "packages/patchy/src/cliRepoRecovery.test.ts",
  "packages/patchy/src/devLifecycle.test.ts",
  "packages/patchy/src/devServer.test.ts",
  "packages/patchy/src/devServerWatch.test.ts",
  "packages/patchy/src/help.test.ts",
  "packages/sdk/src/install.test.ts",
  "lint/rules.test.ts"
];

export default mergeConfig(base, defineConfig({ test: { exclude: nodeOnly } }));
