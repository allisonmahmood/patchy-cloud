// SDK packages the dependency's already-built release; each task owns its cache outputs.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages/patchy/artifacts");
const destination = path.join(root, "packages/sdk/artifacts");
const metadata = await readFile(path.join(source, "release.json"), "utf8");
const { release, digest } = JSON.parse(metadata);
const filename = `patchy-${release}-${digest}.tgz`;
const archiveFilename = /^patchy-[A-Za-z0-9][A-Za-z0-9.+-]*-[a-f0-9]{64}\.tgz$/;
if (!archiveFilename.test(filename))
  throw new Error("Invalid SDK archive filename in release.json.");
await mkdir(destination, { recursive: true });
await copyFile(path.join(source, filename), path.join(destination, filename));
await writeFile(path.join(destination, "release.json"), metadata);
for (const entry of await readdir(destination, { withFileTypes: true })) {
  if (entry.isFile() && entry.name !== filename && archiveFilename.test(entry.name)) {
    await rm(path.join(destination, entry.name));
  }
}
