import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { pack } from "./repoSnapshot.js";

/** A repo with the files the CLI needs, plus `files`, written under a fresh temp folder. */
const repo = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-snapshot-" });
    for (const [file, contents] of Object.entries({
      "package.json": "{}",
      "patchy.json": "{}",
      "patchy.config.ts": "",
      "index.html": "",
      ...files
    })) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
      yield* fs.writeFileString(path.join(root, file), contents);
    }
    return root;
  });

const paths = (packed: Effect.Success<ReturnType<typeof pack>>) =>
  packed.files.map((file) => file.path);

it.layer(NodeServices.layer)("repo snapshot packing", (it) => {
  it.effect("keeps what .gitignore keeps, as git reads nested rules, and never local state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* repo({
        ".gitignore": "dist/\n*.log\n",
        "src/App.tsx": "app",
        "src/debug.log": "noise",
        "fixtures/.gitignore": "*.csv\n!keep.csv\n",
        "fixtures/rows.csv": "dropped",
        "fixtures/keep.csv": "kept",
        "dist/index.html": "built",
        ".env": "SECRET=1",
        ".env.local": "SECRET=2",
        ".patchy/state.json": "{}",
        "patchy/_generated/client.ts": "generated",
        ".agents/skills/patchy-loop/SKILL.md": "release skill",
        ".agents/skills/our-house-style/SKILL.md": "our skill",
        "node_modules/x/index.js": "installed",
        "server/node_modules/y.js": "installed"
      });
      yield* fs.symlink(path.join(root, "src"), path.join(root, "linked"));
      const packed = yield* pack(root);
      assert.deepStrictEqual(paths(packed), [
        ".agents/skills/our-house-style/SKILL.md",
        ".gitignore",
        "fixtures/.gitignore",
        "fixtures/keep.csv",
        "index.html",
        "package.json",
        "patchy.config.ts",
        "patchy.json",
        "src/App.tsx"
      ]);
      assert.strictEqual(
        Buffer.from(
          packed.files.find((file) => file.path === "src/App.tsx")!.contents,
          "base64"
        ).toString(),
        "app"
      );
      assert.deepStrictEqual(packed.warnings, [
        "Symlinks aren't kept with the version, so a pull won't have linked."
      ]);
    }).pipe(Effect.scoped)
  );

  it.effect("follows git where readings diverge, and keeps the executable bit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* repo({
        // Case-sensitive git still ignores private.txt; a case-insensitive reading would not.
        ".gitignore": "private.txt\n!PRIVATE.TXT\nouter/*\n",
        "private.txt": "secret",
        // A deeper file includes again a folder the root excludes, with all that's inside it.
        "outer/.gitignore": "!keep/\n",
        "outer/keep/build.ts": "kept",
        "outer/drop.ts": "dropped",
        "examples/demo/.patchy/dev.log": "local state",
        "scripts/check.sh": "#!/bin/sh"
      });
      yield* fs.chmod(path.join(root, "scripts/check.sh"), 0o755);
      const packed = yield* pack(root);
      assert.deepStrictEqual(
        paths(packed).filter(
          (file) =>
            !["index.html", "package.json", "patchy.config.ts", "patchy.json"].includes(file)
        ),
        [".gitignore", "outer/.gitignore", "outer/keep/build.ts", "scripts/check.sh"]
      );
      assert.deepStrictEqual(
        packed.files.filter((file) => file.executable === true).map((file) => file.path),
        ["scripts/check.sh"]
      );
    }).pipe(Effect.scoped)
  );

  it.effect("refuses a repo that leaves out what the build needs or collides in one folder", () =>
    Effect.gen(function* () {
      const ignored = yield* pack(yield* repo({ ".gitignore": "patchy.config.ts\n" })).pipe(
        Effect.flip
      );
      assert.strictEqual(
        ignored.message,
        "patchy.config.ts would be left out of the repo kept with this version, so a pull couldn't rebuild the patch. Remove the .gitignore rule that excludes it."
      );
      const collided = yield* pack(yield* repo({ "src/App.tsx": "", "src/app.tsx": "" })).pipe(
        Effect.flip
      );
      assert.strictEqual(
        collided.message,
        "The repo can't be kept with the version: src/App.tsx and src/app.tsx differ only by case or Unicode form. Rename one of them."
      );
    }).pipe(Effect.scoped)
  );

  it.effect("refuses a repo over the snapshot limit, naming its largest entries", () =>
    Effect.gen(function* () {
      const root = yield* repo({
        "research/screens.bin": "x".repeat(10 * 1024 * 1024),
        "src/App.tsx": "app"
      });
      const refused = yield* pack(root).pipe(Effect.flip);
      assert.strictEqual(refused.code, "too_large");
      expect(refused.message).toMatch(
        /^The repo is 10\.0 MiB in 6 files; a version keeps at most 10\.0 MiB and 2000 files\. Largest: research\/ 1 file, 10\.0 MiB; /
      );
      expect(refused.message).toContain("Add what the patch doesn't need to .gitignore");
    }).pipe(Effect.scoped)
  );

  // Either limit can be the near one: many small files rank above a few larger ones.
  it.effect("warns near either limit, listing first the entries that use most of it", () =>
    Effect.gen(function* () {
      const heavy = yield* pack(
        yield* repo({ "assets/video.bin": "x".repeat(8.5 * 1024 * 1024), "src/App.tsx": "app" })
      );
      assert.deepStrictEqual(heavy.entries[0], {
        path: "assets/",
        files: 1,
        bytes: 8.5 * 1024 * 1024
      });
      expect(heavy.warnings).toEqual([
        expect.stringMatching(
          /^The repo is 8\.5 MiB in 6 files, near the most a version keeps: 10\.0 MiB and 2000 files\. Largest: assets\/ 1 file, 8\.5 MiB; /
        )
      ]);
      const screens = Object.fromEntries(
        Array.from({ length: 1650 }, (_, index) => [`qa/screen-${index}.png`, "png"])
      );
      const many = yield* pack(
        yield* repo({ ...screens, "fixtures/rows.json": "x".repeat(1024 * 1024) })
      );
      assert.deepStrictEqual(
        many.entries.slice(0, 2).map((entry) => entry.path),
        ["qa/", "fixtures/"]
      );
      expect(many.warnings).toEqual([
        expect.stringContaining("in 1655 files, near the most a version keeps")
      ]);
      expect(many.warnings[0]).toContain("Largest: qa/ 1650 files, 4.8 KiB; fixtures/");
    }).pipe(Effect.scoped)
  );
});
