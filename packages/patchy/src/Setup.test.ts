import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Setup from "./Setup.js";

/** A home directory and an installed-looking `patchy` package with its bundled skill. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy setup " });
  const home = path.join(root, "home");
  mkdirSync(home);
  const installed = (prefix: string) => {
    const pkg = path.join(root, prefix, "lib/node_modules/patchy");
    const skill = path.join(pkg, "skills/patchy");
    mkdirSync(path.join(skill, "references"), { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "patchy" }));
    writeFileSync(path.join(skill, "SKILL.md"), `# Patchy from ${prefix}\n`);
    return skill;
  };
  const [agents, claude] = Setup.skillLinks(home);
  return { root, home, skill: installed("current"), installed, agents: agents!, claude: claude! };
});

it.layer(NodeFileSystem.layer)("patchy setup", (it) => {
  it.effect("links both agent skill paths to the bundled skill, and a rerun changes nothing", () =>
    Effect.gen(function* () {
      const { home, skill, agents, claude } = yield* fixture;
      const first = yield* Setup.link(home, skill);
      assert.deepStrictEqual(first, {
        linked: [agents, claude],
        skill: path.join(skill, "SKILL.md")
      });
      for (const link of [agents, claude]) {
        assert.strictEqual(readlinkSync(link), skill);
        assert.strictEqual(
          readFileSync(path.join(link, "SKILL.md"), "utf8"),
          "# Patchy from current\n"
        );
      }
      const before = lstatSync(agents, { bigint: true });
      assert.deepStrictEqual(yield* Setup.link(home, skill), first);
      const after = lstatSync(agents, { bigint: true });
      assert.strictEqual(after.ino, before.ino);
      assert.strictEqual(after.ctimeNs, before.ctimeNs);
    })
  );

  it.effect(
    "replaces links into another patchy package, including one left by a removed prefix",
    () =>
      Effect.gen(function* () {
        const { root, home, skill, installed, agents, claude } = yield* fixture;
        mkdirSync(path.dirname(agents), { recursive: true });
        mkdirSync(path.dirname(claude), { recursive: true });
        symlinkSync(installed("previous"), agents);
        symlinkSync(path.join(root, "uninstalled/lib/node_modules/patchy/skills/patchy"), claude);
        yield* Setup.link(home, skill);
        assert.strictEqual(readlinkSync(agents), skill);
        assert.strictEqual(readlinkSync(claude), skill);
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
      for (const [kind, make] of Object.entries(conflicts)) {
        const { root, home, skill, agents, claude } = yield* fixture;
        make(claude, root);
        const error = yield* Effect.flip(Setup.link(home, skill));
        assert.strictEqual(error._tag, "LocalError", kind);
        assert.strictEqual(error.code, "skill_conflict", kind);
        assert.include(error.message, claude, kind);
        assert.throws(() => lstatSync(agents), /ENOENT/, kind);
      }
    })
  );

  it.effect("removes only the links setup owns", () =>
    Effect.gen(function* () {
      const { home, skill, agents, claude } = yield* fixture;
      yield* Setup.link(home, skill);
      rmSync(claude);
      mkdirSync(claude);
      writeFileSync(path.join(claude, "SKILL.md"), "# Someone else's\n");
      const removed = yield* Setup.unlink(home, skill);
      assert.deepStrictEqual(removed.removed, [agents]);
      assert.strictEqual(removed.warnings.length, 1);
      assert.include(removed.warnings[0], claude);
      assert.throws(() => lstatSync(agents), /ENOENT/);
      assert.strictEqual(readFileSync(path.join(claude, "SKILL.md"), "utf8"), "# Someone else's\n");
      assert.deepStrictEqual((yield* Setup.unlink(home, skill)).removed, []);
    })
  );
});
