// Bundle all dependencies: the release installs offline, without registry access or scripts.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(repoRoot, "packages/patchy");
const distDir = path.join(packageDir, "dist");
const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
const rootSkillsDir = path.join(repoRoot, "skills");
const packageSkillsDir = path.join(packageDir, "skills");
const publicEntries = ["config", "client", "dev"];

const literals = async (file) => {
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const values = {};
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer;
      if (
        ts.isIdentifier(declaration.name) &&
        value &&
        (ts.isStringLiteral(value) || ts.isNumericLiteral(value))
      ) {
        values[declaration.name.text] = ts.isNumericLiteral(value)
          ? Number(value.text)
          : value.text;
      }
    }
  }
  return values;
};
const api = await literals(path.join(repoRoot, "packages/api/src/schemas.ts"));
const runtime = await literals(path.join(packageDir, "src/release.ts"));
// API cannot depend on patchy (the CLI bundles API). Fail the build rather than
// let its independent wire constants or current release drift from the artifact.
if (
  api.CURRENT_RELEASE !== packageJson.version ||
  api.MANIFEST_VERSION !== runtime.MANIFEST_VERSION ||
  api.WIRE_VERSION !== runtime.WIRE_VERSION
) {
  throw new Error("Patchy package version and API/runtime release constants disagree.");
}

await rm(distDir, { recursive: true, force: true });
const common = {
  bundle: true,
  format: "esm",
  sourcemap: true,
  tsconfig: path.join(packageDir, "tsconfig.json")
};
const requireBanner =
  "import { createRequire as __createRequire } from 'node:module'; import { fileURLToPath as __fileURLToPath } from 'node:url'; import { dirname as __dirnameOf } from 'node:path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameOf(__filename);";
await esbuild.build({
  ...common,
  entryPoints: [path.join(packageDir, "src/index.ts")],
  outfile: path.join(distDir, "index.js"),
  platform: "node",
  target: "node22",
  banner: { js: `#!/usr/bin/env node\n${requireBanner}` }
});
await esbuild.build({
  ...common,
  entryPoints: ["config", "client"].map((name) => path.join(packageDir, `src/${name}.ts`)),
  outdir: distDir,
  platform: "browser",
  target: "es2022",
  // Config builders stay lightweight; executeConfig loads the separate Node bundle on demand.
  external: ["./executeConfig.js"]
});
await esbuild.build({
  ...common,
  entryPoints: ["dev", "executeConfig", "executeConfigChild"].map((name) =>
    path.join(packageDir, `src/${name}.ts`)
  ),
  outdir: distDir,
  platform: "node",
  target: "node22",
  banner: { js: requireBanner }
});
const declarations = await rollup({
  input: Object.fromEntries(
    publicEntries.map((name) => [name, path.join(packageDir, `src/${name}.ts`)])
  ),
  plugins: [dts({ tsconfig: path.join(packageDir, "tsconfig.build.json") })]
});
try {
  await declarations.write({
    dir: distDir,
    format: "es",
    entryFileNames: "[name].d.ts",
    chunkFileNames: "_types/[name]-[hash].d.ts"
  });
} finally {
  await declarations.close();
}
await chmod(path.join(distDir, "index.js"), 0o755);
await access(path.join(rootSkillsDir, "patchy/SKILL.md"));
await rm(packageSkillsDir, { recursive: true, force: true });
await cp(rootSkillsDir, packageSkillsDir, { recursive: true });
await copyFile(path.join(repoRoot, "LICENSE"), path.join(packageDir, "LICENSE"));

if (!process.argv.includes("--bundle-only")) {
  const artifactsDir = path.join(packageDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules/npm/bin/npm-cli.js"),
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      artifactsDir
    ],
    { cwd: packageDir, stdio: "inherit" }
  );
  const name = `patchy-${packageJson.version}.tgz`;
  const tarball = await readFile(path.join(artifactsDir, name));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  await writeFile(
    path.join(artifactsDir, "release.json"),
    JSON.stringify(
      {
        release: packageJson.version,
        integrity,
        manifestVersion: api.MANIFEST_VERSION,
        wireVersion: api.WIRE_VERSION
      },
      null,
      2
    ) + "\n"
  );
}
if (process.argv.includes("--stage-for-server")) {
  await import("./copy-sdk-artifact.mjs");
}
