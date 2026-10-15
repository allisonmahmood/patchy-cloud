import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Minimatch } from "minimatch";
import { expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);

// .github/labeler.yml as this repo writes it: a label applies when any changed
// file matches any of its globs.
type LabelerConfig = Record<
  string,
  ReadonlyArray<{
    readonly "changed-files": ReadonlyArray<{
      readonly "any-glob-to-any-file": ReadonlyArray<string>;
    }>;
  }>
>;

const config: LabelerConfig = parse(readFileSync(new URL(".github/labeler.yml", root), "utf8"));

// actions/labeler matches each changed path with minimatch and `dot: true`.
const areaGlobs = Object.entries(config)
  .filter(([label]) => label.startsWith("area:"))
  .flatMap(([, rules]) => rules)
  .flatMap((rule) => rule["changed-files"])
  .flatMap((match) => match["any-glob-to-any-file"])
  .map((glob) => new Minimatch(glob, { dot: true }));

// A directory has an area when a change to its package.json gets one: #471 changed
// only that and the lockfile, and any Markdown path would match area:docs' `**/*.md`.
// Directories come from git, tracked or not ignored, so checkout leftovers don't count.
it("gives every directory under apps/ and packages/ an area label", () => {
  const files = execFileSync(
    "git",
    // -z: without it git quotes paths with non-ASCII characters.
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "apps", "packages"],
    { cwd: root, encoding: "utf8" }
  ).split("\0");
  const directories = new Set(
    files
      .map((file) => file.split("/"))
      .filter((segments) => segments.length > 2)
      .map(([parent, name]) => `${parent}/${name}`)
  );

  const unlabelled = [...directories].filter(
    (dir) => !areaGlobs.some((glob) => glob.match(`${dir}/package.json`))
  );

  expect(unlabelled).toEqual([]);
});
