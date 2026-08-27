import { readdir, readFile } from "node:fs/promises";

export async function readFixtureCorpus(kind) {
  const directory = new URL(`../packages/core/fixtures/${kind}/`, import.meta.url);
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith(".html"))
    .sort();

  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      html: await readFile(new URL(filename, directory), "utf8")
    }))
  );
}
