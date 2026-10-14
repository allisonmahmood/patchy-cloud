// @effect-diagnostics nodeBuiltinImport:off -- Ownership needs lstat and Windows needs junctions; Effect's FileSystem follows links and takes no link type.
/**
 * `patchy setup`: register the package's bundled global skill with agents. It
 * copies the whole bundled directory to `~/.patchy/skills/patchy`, outside any
 * npm prefix, and links each agent skill path to that copy, so the skill
 * outlives the Node version that installed the CLI. Setup owns that copy, links
 * to it, and the links earlier releases made into a `patchy` package's
 * `skills/patchy` directory, including a dangling one left by an npm prefix
 * that no longer exists. Nothing else.
 */
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink as removeLink
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LocalError } from "./CliError.js";

/** The running package's bundled global skill directory, beside `dist/` in the installed package. */
const bundledSkillDir = fileURLToPath(new URL("../skills/patchy", import.meta.url));

/**
 * The skill's copy. It follows the home directory, not `PATCHY_STATE_DIR`: a
 * temporary state override is no place for a skill every agent session reads.
 */
export const skillCopy = (home: string) => path.join(home, ".patchy", "skills", "patchy");

/** Where setup links the skill: the shared agents path, then Claude Code's. */
export const skillLinks = (home: string) =>
  [
    path.join(home, ".agents", "skills", "patchy"),
    path.join(home, ".claude", "skills", "patchy")
  ] as const;

type Entry = "missing" | "current" | "owned" | "foreign";

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String }))
);
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const errno = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }));
const isLocalError = Schema.is(LocalError);

/** ` (CODE)` naming a system error, or nothing. */
const code = (cause: unknown) =>
  Option.match(errno(cause), { onNone: () => "", onSome: ({ code }) => ` (${code})` });

/** A `patchy/skills/patchy` directory whose package is `patchy`, or that is gone with its prefix. */
const packageSkill = async (target: string) => {
  const skills = path.dirname(target);
  const pkg = path.dirname(skills);
  if (
    path.basename(target) !== "patchy" ||
    path.basename(skills) !== "skills" ||
    path.basename(pkg) !== "patchy"
  )
    return false;
  try {
    const manifest = decodeManifest(await readFile(path.join(pkg, "package.json"), "utf8"));
    return Option.exists(manifest, ({ name }) => name === "patchy");
  } catch (error) {
    if (!missing(error)) return false;
    return lstat(target).then(
      () => false,
      (cause: unknown) => missing(cause)
    );
  }
};

/**
 * The copy is setup's when it is a real directory under Patchy's own home. A
 * link is `current` when it reaches the copy, even before the copy exists, and
 * `owned` when an earlier setup pointed it into a `patchy` package.
 */
const inspect = async (at: string, copy: string): Promise<Entry> => {
  const stats = await lstat(at).catch((error: unknown) =>
    missing(error) ? undefined : Promise.reject(error)
  );
  if (stats === undefined) return "missing";
  if (at === copy) return stats.isDirectory() ? "owned" : "foreign";
  if (!stats.isSymbolicLink()) return "foreign";
  const target = path.resolve(path.dirname(at), await readlink(at));
  if (target === copy) return "current";
  const resolved = await realpath(at).catch(() => undefined);
  if (resolved !== undefined && resolved === (await realpath(copy).catch(() => undefined)))
    return "current";
  return (await packageSkill(target)) ? "owned" : "foreign";
};

/** Names the step, the path and the system error code; the error itself rides as `cause`. */
const failure = (step: "inspect" | "copy" | "link" | "remove", at: string) => (cause: unknown) =>
  new LocalError({
    message: `Could not ${step} the Patchy skill at ${at}${code(cause)}.`,
    cause
  });

/** The agent links, then the copy: removal takes the links first so none dangles. */
const inspectAll = (home: string) => {
  const copy = skillCopy(home);
  return Effect.forEach([...skillLinks(home), copy], (at) =>
    Effect.tryPromise({ try: () => inspect(at, copy), catch: failure("inspect", at) }).pipe(
      Effect.map((entry) => ({ at, entry }))
    )
  );
};

/**
 * Replace the copy with the bundle, dropping files the bundle no longer ships.
 * The bundle lands in a private sibling first and two renames swap it in, so a
 * failed refresh keeps the old copy and an agent never reads half of one. A
 * kill between the renames leaves no copy until the next setup.
 */
const refresh = async (skillDir: string, copy: string, move: typeof rename) => {
  const parent = path.dirname(copy);
  // Private like the state directory, which this may be the first to create.
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(path.join(parent, ".patchy-"));
  const next = path.join(work, "next");
  const previous = path.join(work, "previous");
  let keep = false;
  try {
    await cp(skillDir, next, { recursive: true });
    const moved = await move(copy, previous).then(
      () => true,
      (error: unknown) => (missing(error) ? false : Promise.reject(error))
    );
    await move(next, copy).catch(async (error: unknown) => {
      // Windows can briefly lock freshly written files; put the old copy back.
      if (!moved) throw error;
      await move(previous, copy).catch(() => {
        keep = true;
        throw new LocalError({
          message: `Could not copy the Patchy skill at ${copy}${code(error)} or put the previous copy back, so it is kept at ${previous}. Run patchy setup again, or move it back.`,
          cause: error
        });
      });
      throw error;
    });
  } finally {
    // A leftover sibling is harmless; failing to remove it must not mask the result.
    if (!keep) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Refresh the copy from `skillDir` and link every agent skill path to it.
 * Checks the copy and both links before changing any, so a conflict leaves the
 * machine as it was. Already-correct links are left untouched. Returns the link
 * paths and the copy's `SKILL.md`. `move` is `rename`; tests inject a failing one.
 */
export const link = Effect.fn("Setup.link")(function* (
  home = homedir(),
  skillDir = bundledSkillDir,
  move = rename
) {
  const manifest = path.join(skillDir, "SKILL.md");
  yield* Effect.tryPromise({
    try: () => lstat(manifest),
    catch: (cause) =>
      new LocalError({
        message: `This patchy install has no bundled skill at ${manifest}. Reinstall Patchy from your instance's /llms.txt.`,
        cause
      })
  });
  const copy = skillCopy(home);
  const entries = yield* inspectAll(home);
  const conflicts = entries.filter(({ entry }) => entry === "foreign");
  if (conflicts.length > 0) {
    return yield* new LocalError({
      code: "skill_conflict",
      message: `${conflicts.map(({ at }) => at).join(" and ")} ${conflicts.length === 1 ? "was" : "were"} not made by patchy setup, so setup changed nothing. Move ${conflicts.length === 1 ? "it" : "them"} aside, then run patchy setup again.`
    });
  }
  yield* Effect.tryPromise({
    try: () => refresh(skillDir, copy, move),
    catch: (cause) => (isLocalError(cause) ? cause : failure("copy", copy)(cause))
  });
  for (const { at, entry } of entries) {
    if (at === copy || entry === "current") continue;
    yield* Effect.tryPromise({
      try: async () => {
        if (entry === "owned") await removeLink(at);
        await mkdir(path.dirname(at), { recursive: true });
        // Junctions need no Windows developer mode; POSIX ignores the type.
        await symlink(copy, at, "junction");
      },
      catch: failure("link", at)
    });
  }
  return { linked: [...skillLinks(home)], skill: path.join(copy, "SKILL.md") };
});

/** Remove the links and copy setup owns; anything else at those paths stays, with a warning. */
export const unlink = Effect.fn("Setup.unlink")(function* (home = homedir()) {
  const copy = skillCopy(home);
  const removed: string[] = [];
  const warnings: string[] = [];
  for (const { at, entry } of yield* inspectAll(home)) {
    if (entry === "foreign") {
      warnings.push(`Left ${at} in place: patchy setup did not make it.`);
    } else if (entry !== "missing") {
      yield* Effect.tryPromise({
        try: () => (at === copy ? rm(copy, { recursive: true }) : removeLink(at)),
        catch: failure("remove", at)
      });
      removed.push(at);
    }
  }
  return { removed, warnings };
});
