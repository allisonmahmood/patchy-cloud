// SDK packages the dependency's already-built release; each task owns its cache outputs.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages/patchy/artifacts");
const destination = path.join(root, "packages/sdk/artifacts");
await mkdir(destination, { recursive: true });
for (const filename of await readdir(source)) {
  if (!/^patchy-[A-Za-z0-9][A-Za-z0-9.+-]*-[a-f0-9]{64}\.tgz$/.test(filename)) continue;
  await copyFile(path.join(source, filename), path.join(destination, filename));
}
await copyFile(path.join(source, "release.json"), path.join(destination, "release.json"));
