import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
const result = spawnSync("tsc", [], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const hash = createHash("sha256");
// Include code, dependency lock and shipped instructions in the build identity.
for (const file of [
  ...readdirSync("src").map((f) => `src/${f}`),
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "scripts/build.mjs",
  "scripts/release.mjs",
  "README.md",
  "SETUP.md",
].sort()) {
  hash.update(file);
  hash.update("\0");
  hash.update(readFileSync(file));
  hash.update("\0");
}
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  "dist/build-info.json",
  JSON.stringify({ version, buildId: hash.digest("hex") }) + "\n",
);
chmodSync("dist/cli.js", 0o755);
