import { defineConfig } from "vitest/config";

// Every vitest config in the repo builds on this one.
export default defineConfig({
  resolve: {
    conditions: ["development"]
  },
  test: {
    // Node 24's V8 can free a Wasm wrapper twice and abort a fork running PGlite
    // (nodejs/node#66366). V8 flags are process-wide, so this goes on the fork itself.
    // Remove it once CI's Node 24 is a release with the backport (nodejs/node#66376).
    execArgv: process.versions.node.startsWith("24.") ? ["--no-wasm-code-gc"] : []
  }
});
