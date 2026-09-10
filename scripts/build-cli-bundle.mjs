// Bundle JavaScript dependencies and ship the advisory lock's native prebuilds
// beside its CJS loader so the tarball installs without registry access or scripts.
import { access, chmod, copyFile, cp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = path.join(repoRoot, "packages/cli");
const distDir = path.join(cliDir, "dist");
const outfile = path.join(distDir, "index.js");
const packageJson = JSON.parse(await readFile(path.join(cliDir, "package.json"), "utf8"));
const rootSkillsDir = path.join(repoRoot, "skills");
const packageSkillsDir = path.join(cliDir, "skills");
const rootPatchySkill = path.join(rootSkillsDir, "patchy/SKILL.md");

const nativeSourceDir = path.join(cliDir, "node_modules/fs-native-extensions");
const nativeDistDir = path.join(distDir, "native");
await rm(distDir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [path.join(nativeSourceDir, "index.js")],
  outfile: path.join(nativeDistDir, "index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22"
});
await cp(path.join(nativeSourceDir, "prebuilds"), path.join(nativeDistDir, "prebuilds"), {
  recursive: true
});
// The addon resolver uses the package name and prebuilds relative to __filename.
for (const filename of ["package.json", "LICENSE"]) {
  await copyFile(path.join(nativeSourceDir, filename), path.join(nativeDistDir, filename));
}

await esbuild.build({
  entryPoints: [path.join(cliDir, "src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "native-lock",
      setup(build) {
        build.onResolve({ filter: /^fs-native-extensions$/ }, () => ({
          path: "./native/index.cjs",
          external: true
        }));
      }
    }
  ],
  target: "node22",
  sourcemap: true,
  tsconfig: path.join(cliDir, "tsconfig.json"),
  // undici (CJS, via @effect/platform-node) calls require() for node builtins;
  // ESM output needs a require to hand it.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  },
  define: {
    __PATCHY_VERSION__: JSON.stringify(packageJson.version)
  }
});

await chmod(outfile, 0o755);
await access(rootPatchySkill);
await rm(packageSkillsDir, { recursive: true, force: true });
await cp(rootSkillsDir, packageSkillsDir, { recursive: true });
await copyFile(path.join(repoRoot, "LICENSE"), path.join(cliDir, "LICENSE"));
