// @effect-diagnostics nodeBuiltinImport:off -- Ownership needs lstat and Windows needs junctions; Effect's FileSystem follows links and takes no link type.
/**
 * `patchy setup`: register the package's bundled global skill with agents by
 * linking its whole directory into each agent skill path. Setup owns a link
 * whose target is a `patchy` package's `skills/patchy` directory, including a
 * dangling one left by an npm prefix that no longer exists, and nothing else.
 */
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  symlink,
  unlink as remove
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

const inspect = async (link: string, skillDir: string): Promise<Entry> => {
  const stats = await lstat(link).catch((error: unknown) =>
    missing(error) ? undefined : Promise.reject(error)
  );
  if (stats === undefined) return "missing";
  if (!stats.isSymbolicLink()) return "foreign";
  const resolved = await realpath(link).catch(() => undefined);
  if (resolved !== undefined && resolved === (await realpath(skillDir))) return "current";
  const target = path.resolve(path.dirname(link), await readlink(link));
  return (await packageSkill(target)) ? "owned" : "foreign";
};

/** Names the step, the path and the system error code; the error itself rides as `cause`. */
const failure = (step: "inspect" | "link" | "remove", link: string) => (cause: unknown) =>
  new LocalError({
    message: `Could not ${step} the Patchy skill link at ${link}${Option.match(errno(cause), {
      onNone: () => "",
      onSome: ({ code }) => ` (${code})`
    })}.`,
    cause
  });

const inspectAll = (home: string, skillDir: string) =>
  Effect.forEach(skillLinks(home), (link) =>
    Effect.tryPromise({ try: () => inspect(link, skillDir), catch: failure("inspect", link) }).pipe(
      Effect.map((entry) => ({ link, entry }))
    )
  );

/**
 * Link every agent skill path to `skillDir`. Checks every path before changing
 * any, so a conflict leaves the machine as it was. Already-correct links are
 * left untouched. Returns the link paths and the skill's `SKILL.md`.
 */
export const link = Effect.fn("Setup.link")(function* (
  home = homedir(),
  skillDir = bundledSkillDir
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
  const entries = yield* inspectAll(home, skillDir);
  const conflicts = entries.filter(({ entry }) => entry === "foreign");
  if (conflicts.length > 0) {
    return yield* new LocalError({
      code: "skill_conflict",
      message: `${conflicts.map(({ link }) => link).join(" and ")} ${conflicts.length === 1 ? "is" : "are"} not a link patchy setup made, so setup changed nothing. Move ${conflicts.length === 1 ? "it" : "them"} aside, then run patchy setup again.`
    });
  }
  for (const { link, entry } of entries) {
    if (entry === "current") continue;
    yield* Effect.tryPromise({
      try: async () => {
        if (entry === "owned") await remove(link);
        await mkdir(path.dirname(link), { recursive: true });
        // Junctions need no Windows developer mode; POSIX ignores the type.
        await symlink(skillDir, link, "junction");
      },
      catch: failure("link", link)
    });
  }
  return { linked: entries.map(({ link }) => link), skill: manifest };
});

/** Remove the links setup owns; anything else at those paths stays, with a warning. */
export const unlink = Effect.fn("Setup.unlink")(function* (
  home = homedir(),
  skillDir = bundledSkillDir
) {
  const removed: string[] = [];
  const warnings: string[] = [];
  for (const { link, entry } of yield* inspectAll(home, skillDir)) {
    if (entry === "foreign") {
      warnings.push(`Left ${link} in place: patchy setup did not make it.`);
    } else if (entry !== "missing") {
      yield* Effect.tryPromise({ try: () => remove(link), catch: failure("remove", link) });
      removed.push(link);
    }
  }
  return { removed, warnings };
});
