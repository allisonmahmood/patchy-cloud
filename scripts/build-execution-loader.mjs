// Bundles the execution loader worker over tsc's dist/loader.js, so built services read it
// instead of bundling it on their first process. Source checkouts bundle it on first use.
import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ["packages/execution/src/loader.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["development"],
  external: ["cloudflare:workers"],
  minify: true,
  legalComments: "none",
  metafile: true
});
for (const output of Object.values(result.metafile.outputs)) {
  const imports = output.imports.filter(({ path }) => path !== "cloudflare:workers");
  if (imports.length !== 0)
    throw new Error(
      `The execution loader retains external imports: ${imports.map(({ path }) => path).join(", ")}`
    );
}
const [loader] = result.outputFiles;
if (loader === undefined || loader.text.length === 0)
  throw new Error("The execution loader bundle is empty.");
const dist = new URL("../packages/execution/dist/", import.meta.url);
await writeFile(new URL("loader.js", dist), loader.text);
// tsc's map describes the module this bundle replaced.
await rm(new URL("loader.js.map", dist), { force: true });
