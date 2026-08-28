// Bundles the Effect CLI into one file, Effect included (a packed CLI has no
// node_modules to resolve `effect` from). Mirrors scripts/build-cli-bundle.mjs.
import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(dir, "dist/patchy.js");

const result = await esbuild.build({
  entryPoints: [path.join(dir, "src/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  metafile: true,
  // undici (CJS, via @effect/platform-node's NodeServices) calls require() for
  // node builtins; ESM output needs a require to hand it.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  },
  tsconfig: path.join(dir, "tsconfig.json"),
  define: { __PATCHY_VERSION__: JSON.stringify("0.0.1-slice") }
});
await chmod(outfile, 0o755);
const { size } = await stat(outfile);
const inputs = Object.keys(result.metafile.inputs);
console.log(`bundled ${outfile}: ${(size / 1024).toFixed(0)} KiB from ${inputs.length} modules`);
console.log(`effect modules: ${inputs.filter((i) => i.includes("node_modules/effect/")).length}`);
