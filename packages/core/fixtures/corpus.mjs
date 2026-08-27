import { readdir, readFile } from "node:fs/promises";

const fixtureKinds = ["accept", "reject"];

export async function readFixtureCorpus(kind) {
  if (!fixtureKinds.includes(kind)) {
    throw new TypeError(`Unknown HTML fixture kind: ${kind}`);
  }

  const directory = new URL(`./${kind}/`, import.meta.url);
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
