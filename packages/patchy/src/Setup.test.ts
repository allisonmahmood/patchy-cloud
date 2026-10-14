import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { rename } from "node:fs/promises";
import path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Setup from "./Setup.js";

/** A home directory and installed-looking `patchy` packages with their bundled skill. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy setup " });
  const home = path.join(root, "home");
  mkdirSync(home);
  const installed = (prefix: string, references = ["onboarding.md"]) => {
    const pkg = path.join(root, prefix, "lib/node_modules/patchy");
    const skill = path.join(pkg, "skills/patchy");
    mkdirSync(path.join(skill, "references"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "patchy" }));
    writeFileSync(path.join(skill, "SKILL.md"), `# Patchy from ${prefix}\n`);
    for (const reference of references)
      writeFileSync(path.join(skill, "references", reference), `${reference} from ${prefix}\n`);
    return skill;
  };
  const [agents, claude] = Setup.skillLinks(home);
  const copy = Setup.skillCopy(home);
  /** What an agent reads through a link: every file, relative to the skill. */
  const read = (at: string) =>
    Object.fromEntries(
      readdirSync(at, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [path.relative(at, file), readFileSync(file, "utf8")];
        })
    );
  return { root, home, skill: installed("current"), installed, agents, claude, copy, read };
});

it.layer(NodeFileSystem.layer)("patchy setup", (it) => {
  it.effect("links both agent paths to a copy under ~/.patchy, and a rerun keeps the links", () =>
    Effect.gen(function* () {
      const { home, skill, agents, claude, copy, read } = yield* fixture;
      const first = yield* Setup.link(home, skill);
      assert.deepStrictEqual(first, {
        linked: [agents, claude],
        skill: path.join(copy, "SKILL.md")
      });
      for (const link of [agents, claude]) {
        assert.strictEqual(readlinkSync(link), copy);
        assert.deepStrictEqual(read(link), read(skill));
      }
      const before = lstatSync(agents, { bigint: true });
      assert.deepStrictEqual(yield* Setup.link(home, skill), first);
      const after = lstatSync(agents, { bigint: true });
      assert.strictEqual(after.ino, before.ino);
      assert.strictEqual(after.ctimeNs, before.ctimeNs);
    })
  );

  it.effect("the skill outlives its npm prefix, and the next release's setup replaces it", () =>
    Effect.gen(function* () {
      const { root, home, installed, agents, claude, read } = yield* fixture;
      const old = installed("node 24", ["onboarding.md", "retired.md"]);
      yield* Setup.link(home, old);
      rmSync(path.join(root, "node 24"), { recursive: true });
      assert.strictEqual(
        readFileSync(path.join(claude, "SKILL.md"), "utf8"),
        "# Patchy from node 24\n"
      );

      const next = installed("node 26");
      yield* Setup.link(home, next);
      for (const link of [agents, claude]) assert.deepStrictEqual(read(link), read(next));
    })
  );

  it.effect(
    "replaces links into another patchy package, including one left by a removed prefix",
    () =>
      Effect.gen(function* () {
        const { root, home, skill, installed, agents, claude, copy } = yield* fixture;
        mkdirSync(path.dirname(agents), { recursive: true });
        mkdirSync(path.dirname(claude), { recursive: true });
        symlinkSync(installed("previous"), agents);
        symlinkSync(path.join(root, "uninstalled/lib/node_modules/patchy/skills/patchy"), claude);
        yield* Setup.link(home, skill);
        assert.strictEqual(readlinkSync(agents), copy);
        assert.strictEqual(readlinkSync(claude), copy);
      })
  );

  it.effect("refuses a directory, a file or a foreign link before changing anything", () =>
    Effect.gen(function* () {
      const conflicts = {
        directory: (at: string) => mkdirSync(at, { recursive: true }),
        file: (at: string) => {
          mkdirSync(path.dirname(at), { recursive: true });
          writeFileSync(at, "mine");
        },
        // A patchy-shaped path whose package is not patchy is someone else's.
        link: (at: string, root: string) => {
          const elsewhere = path.join(root, "checkout/patchy/skills/patchy");
          mkdirSync(elsewhere, { recursive: true });
          writeFileSync(path.join(root, "checkout/patchy/package.json"), '{"name":"patchy-cloud"}');
          mkdirSync(path.dirname(at), { recursive: true });
          symlinkSync(elsewhere, at);
        }
      };
      // A real directory is the copy's own shape, so only a file or a link conflicts there.
      const cases = [
        ...Object.entries(conflicts).map(([kind, make]) => ({ kind, make, at: "claude" as const })),
        { kind: "file", make: conflicts.file, at: "copy" as const },
        { kind: "link", make: conflicts.link, at: "copy" as const }
      ];
      for (const { kind, make, at } of cases) {
        const paths = yield* fixture;
        const label = `${kind} at ${at}`;
        make(paths[at], paths.root);
        const error = yield* Effect.flip(Setup.link(paths.home, paths.skill));
        assert.strictEqual(error._tag, "LocalError", label);
        assert.strictEqual(error.code, "skill_conflict", label);
        assert.include(error.message, paths[at], label);
        for (const other of [paths.agents, paths.claude, paths.copy].filter((p) => p !== paths[at]))
          assert.isFalse(existsSync(other), label);
      }
    })
  );

  it.effect.skipIf(process.getuid?.() === 0)(
    "a refresh that fails leaves the previous copy whole",
    () =>
      Effect.gen(function* () {
        const { home, skill, installed, claude, copy, read } = yield* fixture;
        yield* Setup.link(home, skill);
        const before = read(claude);
        const broken = installed("broken");
        chmodSync(path.join(broken, "references/onboarding.md"), 0o000);
        const error = yield* Effect.flip(Setup.link(home, broken));
        assert.include(error.message, `Could not copy the Patchy skill at ${copy}`);
        assert.deepStrictEqual(read(claude), before);
        assert.deepStrictEqual(readdirSync(path.dirname(copy)), ["patchy"]);
      })
  );

  it.effect("keeps the previous copy, and names where, when it cannot be put back", () =>
    Effect.gen(function* () {
      const { home, skill, installed, copy, read } = yield* fixture;
      yield* Setup.link(home, skill);
      const before = read(copy);
      // Every move into the copy's path fails, as a Windows lock can.
      const locked: typeof rename = (from, to) =>
        to === copy
          ? Promise.reject(Object.assign(new Error("locked"), { code: "EPERM" }))
          : rename(from, to);
      const error = yield* Effect.flip(Setup.link(home, installed("next"), locked));
      const [work, ...others] = readdirSync(path.dirname(copy));
      assert.isDefined(work);
      assert.deepStrictEqual(others, []);
      const kept = path.join(path.dirname(copy), work, "previous");
      assert.include(
        error.message,
        `(EPERM) or put the previous copy back, so it is kept at ${kept}.`
      );
      assert.deepStrictEqual(read(kept), before);
    })
  );

  it.effect("removes the copy and the links setup owns, and nothing else", () =>
    Effect.gen(function* () {
      const { home, skill, agents, claude, copy } = yield* fixture;
      yield* Setup.link(home, skill);
      rmSync(claude);
      mkdirSync(claude);
      writeFileSync(path.join(claude, "SKILL.md"), "# Someone else's\n");
      const removed = yield* Setup.unlink(home);
      assert.deepStrictEqual(removed.removed, [agents, copy]);
      assert.strictEqual(removed.warnings.length, 1);
      assert.include(removed.warnings[0], claude);
      assert.isFalse(existsSync(agents));
      assert.isFalse(existsSync(copy));
      assert.strictEqual(readFileSync(path.join(claude, "SKILL.md"), "utf8"), "# Someone else's\n");
      assert.deepStrictEqual((yield* Setup.unlink(home)).removed, []);
    })
  );
});
