/**
 * A repo snapshot on the wire: the files of the patch repo one version was published from, as
 * `patchy publish` sends them and `patchy pull` gets them back. The CLI checks a snapshot before
 * sending it and the server checks it again with the same rules, so the two never disagree.
 */
import * as Schema from "effect/Schema";
import { registry } from "@patchy/limits/registry";

/** The contract caps on one snapshot: decoded file bytes and files. */
export const repoLimits = {
  bytes: registry["publish.repo.bytes"].default,
  files: registry["publish.repo.files"].default
} as const;

const utf8 = new TextEncoder();

/**
 * Relative POSIX segments, none of them empty, `.` or `..`, with no backslash or control
 * character and at most 1,024 UTF-8 bytes in all.
 */
export const isRepoPath = (path: string): boolean =>
  utf8.encode(path).length <= 1024 &&
  !/[\u0000-\u001f\u007f\\]/u.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export const RepoPath = Schema.String.check(
  Schema.makeFilter((path: string) => isRepoPath(path) || "Invalid repo path.", {
    title: "RepoPath"
  })
);

/**
 * Padded standard base64. `Schema.isBase64` repeats a group per four characters, which overflows
 * the stack on a snapshot-sized file; one character class runs in linear time.
 */
const Base64 = Schema.String.check(
  Schema.makeFilter(
    (text: string) =>
      (text.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(text)) || "Invalid base64.",
    { title: "Base64" }
  )
);

/**
 * One file of a snapshot: its path in the repo, its bytes in base64, and `executable` when its
 * owner could run it, so a pulled script still runs.
 */
export const RepoFile = Schema.Struct({
  path: RepoPath,
  contents: Base64,
  executable: Schema.optionalKey(Schema.Literal(true))
});
export type RepoFile = typeof RepoFile.Type;

export const RepoSnapshot = Schema.Array(RepoFile);

/**
 * How a version can be pulled: `repo` from its snapshot, or `file` for a page published from one
 * HTML file, which pulls as that file.
 */
export const RepoKind = Schema.Literals(["repo", "file"]);

/** What a version's snapshot holds, without its contents. */
export const RepoSummary = Schema.Struct({
  files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});

/** Decoded bytes of contents the snapshot's base64 check accepted, without decoding them. */
export const base64Bytes = (contents: string): number =>
  (contents.length / 4) * 3 - (contents.endsWith("==") ? 2 : contents.endsWith("=") ? 1 : 0);

/**
 * A path as a case-insensitive filesystem compares it. Upper then lower case folds what lower
 * case alone keeps apart, such as `ς` and `Σ` or `ſ` and `S`; it errs toward calling two names
 * one, which refuses a snapshot rather than letting a pull overwrite a file.
 */
const fold = (path: string) => path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");

/**
 * Why these paths can't all be written into one folder on every machine, or undefined. Paths that
 * differ only by case or Unicode form collide on macOS and Windows, and no path can be both a file
 * and a folder.
 */
export const repoTreeProblem = (paths: ReadonlyArray<string>): string | undefined => {
  const files = new Map<string, string>();
  for (const path of paths) {
    const key = fold(path);
    const other = files.get(key);
    if (other !== undefined)
      return other === path
        ? `${path} appears twice.`
        : `${other} and ${path} differ only by case or Unicode form.`;
    files.set(key, path);
  }
  for (const path of paths) {
    const parts = fold(path).split("/");
    for (let end = 1; end < parts.length; end++) {
      const file = files.get(parts.slice(0, end).join("/"));
      if (file !== undefined) return `${file} is a file, but ${path} needs it to be a folder.`;
    }
  }
  return undefined;
};
