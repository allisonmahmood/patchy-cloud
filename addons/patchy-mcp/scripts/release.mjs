import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const staging = mkdtempSync(path.join(os.tmpdir(), "patchy-mcp-release-"));
try {
  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--pack-destination", staging],
    { cwd: root, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error(packed.stderr || "npm pack failed");
  const result = JSON.parse(packed.stdout);
  // npm 12 keys pack results by package name; earlier versions return an array.
  const metadata = Array.isArray(result) ? result[0] : result["patchy-mcp"];
  if (!metadata?.filename) throw new Error("npm pack returned no archive metadata");
  const archive = path.join(artifacts, metadata.filename);
  const data = readFileSync(path.join(staging, metadata.filename));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const sha256 = digest(data);
  if (existsSync(archive) && digest(readFileSync(archive)) !== sha256)
    throw new Error(
      `Build ${metadata.version} already exists with different contents. Bump package.json and package-lock.json versions; retain the old archive for rollback.`,
    );
  writeFileSync(archive, data);
  writeFileSync(`${archive}.sha256`, `${sha256}  ${metadata.filename}\n`);
  copyFileSync(path.join(root, "SETUP.md"), path.join(artifacts, "INSTALL.md"));
  copyFileSync(
    path.join(root, "SETUP.md"),
    path.join(artifacts, `INSTALL-${metadata.version}.md`),
  );
  const build = JSON.parse(
    readFileSync(path.join(root, "dist", "build-info.json"), "utf8"),
  );
  const release = {
    ...build,
    archive,
    sha256,
    bytes: metadata.size,
    bundled: metadata.bundled,
  };
  writeFileSync(
    path.join(artifacts, `patchy-mcp-${metadata.version}.json`),
    JSON.stringify(release, null, 2) + "\n",
  );
  console.log(JSON.stringify(release));
} finally {
  rmSync(staging, { recursive: true, force: true });
}
