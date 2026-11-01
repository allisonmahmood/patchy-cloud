// @effect-diagnostics nodeBuiltinImport:off
// Node's readdir with file types is required here: Effect FileSystem.stat follows links, and a
// snapshot has to see a link to leave it out.
/**
 * The repo snapshot `patchy publish` sends with every repo publish: each file in the patch repo
 * except what `.gitignore` excludes, what refresh regenerates, and what must never leave the
 * machine. Everyone who can open the patch can pull it, so it never holds `.env` files or
 * local state. The server checks the same limits and paths again (`@patchy/api`'s `repo.ts`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import ignore from "ignore";
import { isRepoPath, repoLimits, repoTreeProblem, type RepoFile } from "@patchy/api";
import { LocalError } from "./CliError.js";

/** Never kept, whatever `.gitignore` says: version control, installs, secrets and local state. */
const neverKept = (relative: string, name: string, directory: boolean): boolean =>
  name === ".git" ||
  name === "node_modules" ||
  name === ".patchy" ||
  name === ".DS_Store" ||
  name === ".env" ||
  name.startsWith(".env.") ||
  // Refresh writes these from the release, so a pull regenerates them.
  relative === "patchy/_generated" ||
  (directory && /^\.agents\/skills\/patchy-[^/]+$/.test(relative));

/** What the CLI reads to build and publish: a snapshot without one couldn't rebuild the patch. */
const needed = ["package.json", "patchy.json", "patchy.config.ts", "index.html", "vite.config.ts"];

/**
 * A `.gitignore`'s lines as rules of the repo's root. A pattern with a slash before its end is
 * anchored to the file's folder, and any other matches at every depth below it, as git reads
 * them. In one ordered list a deeper file's rules come later and win, and a folder one file
 * excludes and a deeper one includes again stays included for everything inside it.
 */
const rooted = (folder: string, source: string): ReadonlyArray<string> => {
  if (folder === "") return source.split(/\r?\n/);
  const base = folder.replace(/[\\*?[\]]/g, "\\$&");
  return source.split(/\r?\n/).flatMap((line) => {
    if (line.trim() === "" || line.startsWith("#")) return [];
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;
    const anchored = pattern.replace(/\/$/, "").includes("/");
    const rule = anchored ? `/${base}/${pattern.replace(/^\//, "")}` : `/${base}/**/${pattern}`;
    return [negated ? `!${rule}` : rule];
  });
};

/**
 * Matchers over every rule from the root down to one folder. Git's case sensitivity follows the
 * filesystem, so a path either reading ignores stays out: a rule never lets a file leave the
 * machine on one system that it keeps home on another.
 */
const matchers = (rules: ReadonlyArray<string>) => {
  const exact = ignore({ ignorecase: false }).add(rules);
  const folded = ignore({ ignorecase: true }).add(rules);
  return (relative: string, directory: boolean) => {
    const candidate = directory ? `${relative}/` : relative;
    return exact.ignores(candidate) || folded.ignores(candidate);
  };
};

interface Walked {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly executable: boolean;
  }>;
  readonly links: ReadonlyArray<string>;
  /** Files with a name a snapshot can't carry, such as one holding a backslash. */
  readonly unnamed: ReadonlyArray<string>;
}

/** Walks `root` for what a snapshot keeps; sizes and modes come from `from`, where it is read. */
const walk = async (root: string, from = root): Promise<Walked> => {
  const files: Array<{ path: string; bytes: number; executable: boolean }> = [];
  const links: string[] = [];
  const unnamed: string[] = [];
  interface Scope {
    readonly rules: ReadonlyArray<string>;
    readonly ignored: ReturnType<typeof matchers>;
  }
  const visit = async (directory: string, inherited: Scope): Promise<void> => {
    const absolute = path.join(root, directory);
    const entries = (await fs.readdir(absolute, { withFileTypes: true })).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    const gitignore = entries.find((entry) => entry.name === ".gitignore" && entry.isFile());
    const rules =
      gitignore === undefined
        ? inherited.rules
        : [
            ...inherited.rules,
            ...rooted(directory, await fs.readFile(path.join(absolute, ".gitignore"), "utf8"))
          ];
    const scope = gitignore === undefined ? inherited : { rules, ignored: matchers(rules) };
    for (const entry of entries) {
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      const isDirectory = entry.isDirectory();
      // A `.gitignore` is always kept, even one its parent's rules exclude, so a pulled copy
      // reads the same rules and keeps the same files at its next publish.
      const rules = entry === gitignore;
      if (
        neverKept(relative, entry.name, isDirectory) ||
        (!rules && scope.ignored(relative, isDirectory))
      )
        continue;
      if (entry.isSymbolicLink()) links.push(relative);
      else if (isDirectory) await visit(relative, scope);
      else if (!entry.isFile()) continue;
      else if (!isRepoPath(relative)) unnamed.push(relative);
      else {
        const stat = await fs.lstat(path.join(from, relative));
        files.push({ path: relative, bytes: stat.size, executable: (stat.mode & 0o111) !== 0 });
      }
    }
  };
  await visit("", { rules: [], ignored: matchers([]) });
  return { files, links, unnamed };
};

/** Bytes as a person reads them. */
export const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** A top-level file, or folder ending in `/`, of a snapshot, with the files and bytes it holds. */
export interface Entry {
  readonly path: string;
  readonly files: number;
  readonly bytes: number;
}

/** How much of the nearer limit a snapshot, or one of its entries, uses. */
const share = ({ files, bytes }: Pick<Entry, "files" | "bytes">) =>
  Math.max(files / repoLimits.files, bytes / repoLimits.bytes);

/** Past this share of either limit, publish warns before the repo reaches it. */
const warnShare = 0.8;

/**
 * The snapshot's top-level files and folders, the ones using most of either limit first, then the
 * larger: where an agent starts trimming.
 */
const entries = (files: Walked["files"]): ReadonlyArray<Entry> => {
  const totals = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const [first, ...rest] = file.path.split("/");
    const entry = rest.length === 0 ? first! : `${first}/`;
    const total = totals.get(entry) ?? { files: 0, bytes: 0 };
    totals.set(entry, { files: total.files + 1, bytes: total.bytes + file.bytes });
  }
  return [...totals]
    .map(([path, total]) => ({ path, ...total }))
    .sort((left, right) => share(right) - share(left) || right.bytes - left.bytes);
};

/** An entry as a person reads it; a folder says how many files it holds. */
export const formatEntry = (entry: Entry): string =>
  entry.path.endsWith("/")
    ? `${entry.path} ${entry.files} ${entry.files === 1 ? "file" : "files"}, ${formatBytes(entry.bytes)}`
    : `${entry.path} ${formatBytes(entry.bytes)}`;

const largest = (list: ReadonlyArray<Entry>) => list.slice(0, 5).map(formatEntry).join("; ");

const limitsText = `${formatBytes(repoLimits.bytes)} and ${repoLimits.files} files`;

const measure = (files: Walked["files"]) => {
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  return { bytes, listed: entries(files), size: `${formatBytes(bytes)} in ${files.length} files` };
};

const overLimits = (files: Walked["files"]) =>
  files.length > repoLimits.files || measure(files).bytes > repoLimits.bytes;

const tooLarge = (files: Walked["files"]) => {
  const { listed, size } = measure(files);
  return new LocalError({
    message: `The repo is ${size}; a version keeps at most ${limitsText}. Largest: ${largest(listed)}. Add what the patch doesn't need to .gitignore, then publish again.`,
    code: "too_large"
  });
};

const readFailure = (cause: unknown) =>
  new LocalError({ message: "Could not read the repo to keep it with the version.", cause });

/**
 * The paths a snapshot of `root` keeps, found as `pack` finds them, for a dry run to copy. It
 * refuses a repo publish would refuse whatever its description sync wrote: patchy.json is the one
 * kept file that sync rewrites, so a repo over the limits without it is over them anyway.
 */
export const scan = Effect.fn("RepoSnapshot.scan")(function* (root: string) {
  const walked = yield* Effect.tryPromise({ try: () => walk(root), catch: readFailure });
  if (overLimits(walked.files.filter((file) => file.path !== "patchy.json")))
    return yield* tooLarge(walked.files);
  return walked.files.map((file) => file.path);
});

/** What a dry run's copy holds whole: preparation writes the first, and refuses links in both others. */
const copiedWhole = ["patchy/_generated", "server", "agent"];

/**
 * Fills `copy` from `root`: the `kept` files and `copiedWhole` as copies, and a link back to
 * `root` for everything else, so a build in `copy` reads what it would read in `root`.
 */
const fill = async (root: string, copy: string, kept: ReadonlySet<string>) => {
  const above = new Set<string>();
  for (const file of [...kept, ...copiedWhole])
    for (let folder = path.posix.dirname(file); folder !== "."; folder = path.posix.dirname(folder))
      above.add(folder);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      const from = path.join(root, relative);
      const to = path.join(copy, relative);
      if (copiedWhole.includes(relative))
        await fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
      else if (kept.has(relative)) await fs.copyFile(from, to);
      else if (entry.isDirectory() && above.has(relative)) {
        await fs.mkdir(to);
        await visit(relative);
      } else await fs.symlink(from, to);
    }
  };
  await visit("");
};

/**
 * A scratch copy of the repo at `root` under the OS temp folder, removed when the scope closes,
 * for `publish --dry-run` to prepare in: writes land in the copy, and links leave the repo alone.
 */
export const mirror = Effect.fn("RepoSnapshot.mirror")(function* (
  root: string,
  kept: ReadonlyArray<string>
) {
  const copy = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => fs.mkdtemp(path.join(os.tmpdir(), "patchy-dry-run-")),
      catch: (cause) =>
        new LocalError({ message: "Could not make a folder for the dry run.", cause })
    }),
    // A copy left in the temp folder is only clutter, so removing it never fails the dry run.
    (folder) =>
      Effect.tryPromise(() => fs.rm(folder, { recursive: true, force: true })).pipe(Effect.ignore)
  );
  yield* Effect.tryPromise({
    try: () => fill(root, copy, new Set(kept)),
    catch: (cause) => new LocalError({ message: "Could not copy the repo for the dry run.", cause })
  });
  return copy;
});

/**
 * Packs the repo at `root`, read from `from`, into the snapshot its next version keeps, sorted by path, with its
 * size and top-level entries. Refuses a repo over the snapshot limits, one that leaves out a file
 * the build needs, and paths that would collide in one folder; a repo near the limits and skipped
 * links come back as warnings.
 */
export const pack = Effect.fn("RepoSnapshot.pack")(function* (root: string, from = root) {
  const walked = yield* Effect.tryPromise({
    try: () => walk(root, from),
    catch: readFailure
  });
  if (walked.unnamed.length > 0)
    return yield* new LocalError({
      message: `A version can't keep ${walked.unnamed.join(", ")}: rename it without backslashes or control characters, or add it to .gitignore.`,
      code: "invalid_manifest"
    });
  const sorted = [...walked.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const kept = new Set(sorted.map((file) => file.path));
  for (const file of needed) {
    if (kept.has(file)) continue;
    const present = yield* Effect.promise(() =>
      fs.lstat(path.join(root, file)).then(
        (stat) => stat.isFile(),
        () => false
      )
    );
    if (present)
      return yield* new LocalError({
        message: `${file} would be left out of the repo kept with this version, so a pull couldn't rebuild the patch. Remove the .gitignore rule that excludes it.`,
        code: "invalid_manifest"
      });
  }
  if (overLimits(sorted)) return yield* tooLarge(sorted);
  const { bytes, listed, size } = measure(sorted);
  const problem = repoTreeProblem(sorted.map((file) => file.path));
  if (problem !== undefined)
    return yield* new LocalError({
      message: `The repo can't be kept with the version: ${problem} Rename one of them.`,
      code: "invalid_manifest"
    });
  const files: ReadonlyArray<RepoFile> = yield* Effect.forEach(sorted, (file) =>
    Effect.tryPromise({
      try: async () => ({
        path: file.path,
        contents: (await fs.readFile(path.join(from, file.path))).toString("base64"),
        ...(file.executable ? { executable: true as const } : {})
      }),
      catch: (cause) => new LocalError({ message: `Could not read ${file.path}.`, cause })
    })
  );
  const warnings: string[] = [];
  if (share({ files: sorted.length, bytes }) >= warnShare)
    warnings.push(
      `The repo is ${size}, near the most a version keeps: ${limitsText}. Largest: ${largest(listed)}. Add what the patch doesn't need to .gitignore before it gets there.`
    );
  if (walked.links.length > 0)
    warnings.push(
      `Symlinks aren't kept with the version, so a pull won't have ${walked.links.join(", ")}.`
    );
  return { files, bytes, entries: listed, warnings };
});
