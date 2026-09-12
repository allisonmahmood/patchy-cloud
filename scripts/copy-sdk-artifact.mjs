// SDK packages the dependency's already-built release; each task owns its cache outputs.
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages/patchy/artifacts");
const destination = path.join(root, "packages/sdk/artifacts");
const pkg = JSON.parse(await readFile(path.join(root, "packages/patchy/package.json"), "utf8"));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await copyFile(
  path.join(source, `patchy-${pkg.version}.tgz`),
  path.join(destination, `patchy-${pkg.version}.tgz`)
);
await copyFile(path.join(source, "release.json"), path.join(destination, "release.json"));
