import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverServerModules, validateGeneratedServerModules } from "./serverModules.js";

it.layer(NodeServices.layer)("server source module discovery", (it) => {
  it.effect("uses only filenames and permits an absent or empty server directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-modules-" });
      assert.deepStrictEqual(yield* discoverServerModules(root), []);
      yield* fs.makeDirectory(path.join(root, "server"));
      assert.deepStrictEqual(yield* discoverServerModules(root), []);
      yield* fs.writeFileString(path.join(root, "server/zebra.ts"), "invalid TypeScript {");
      yield* fs.writeFileString(
        path.join(root, "server/import-rows.ts"),
        'throw new Error("no execution");'
      );
      yield* fs.writeFileString(path.join(root, "server/notes.txt"), "not a module");
      assert.deepStrictEqual(yield* discoverServerModules(root), ["import-rows", "zebra"]);
    })
  );

  it.effect("skips a module deleted between listing server/ and reading it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-modules-" });
      const deleted = path.join(root, "server/leads.ts");
      yield* fs.makeDirectory(path.join(root, "server"));
      yield* fs.writeFileString(deleted, "");
      yield* fs.writeFileString(path.join(root, "server/people.ts"), "");
      const modules = yield* discoverServerModules(root).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (file) =>
            file === deleted ? fs.remove(file).pipe(Effect.andThen(fs.stat(file))) : fs.stat(file)
        })
      );
      assert.deepStrictEqual(modules, ["people"]);
    })
  );

  it.effect("refuses missing, renamed and duplicate generated modules until refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-generated-modules-" });
      yield* fs.makeDirectory(path.join(root, "server"));
      yield* fs.makeDirectory(path.join(root, "patchy/_generated"), { recursive: true });
      yield* fs.writeFileString(path.join(root, "server/leads.ts"), "");
      const check = Effect.gen(function* () {
        yield* validateGeneratedServerModules(root, yield* discoverServerModules(root));
      });
      assert.strictEqual((yield* check.pipe(Effect.flip)).code, "stale_generated");
      const generated = path.join(root, "patchy/_generated/server.ts");
      yield* fs.writeFileString(generated, 'import type * as leads from "../../server/leads.js";');
      yield* check;
      yield* fs.rename(path.join(root, "server/leads.ts"), path.join(root, "server/deals.ts"));
      assert.strictEqual((yield* check.pipe(Effect.flip)).code, "stale_generated");
      yield* fs.writeFileString(generated, 'import type * as deals from "../../server/deals.js";');
      yield* check;
      yield* fs.writeFileString(
        generated,
        [
          'import type * as one from "../../server/deals.js";',
          'import type * as two from "../../server/deals.js";'
        ].join("\n")
      );
      assert.strictEqual((yield* check.pipe(Effect.flip)).code, "stale_generated");
    })
  );

  for (const name of ["nested", "bad.name.ts", "9leads.ts"]) {
    it.effect(`refuses ${name} instead of generating unusable handler types`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-modules-" });
        yield* fs.makeDirectory(path.join(root, "server"));
        if (name === "nested") {
          yield* fs.makeDirectory(path.join(root, "server/nested"));
          yield* fs.writeFileString(path.join(root, "server/nested/leads.ts"), "");
        } else yield* fs.writeFileString(path.join(root, "server", name), "");
        const failure = yield* discoverServerModules(root).pipe(Effect.flip);
        assert.strictEqual(failure.code, "invalid_manifest");
      })
    );
  }

  it.effect("refuses linked module files and linked server directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-modules-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-modules-outside-" });
      yield* fs.writeFileString(path.join(outside, "leads.ts"), "");
      yield* fs.makeDirectory(path.join(root, "server"));
      yield* fs.symlink(path.join(outside, "leads.ts"), path.join(root, "server/leads.ts"));
      assert.strictEqual(
        (yield* discoverServerModules(root).pipe(Effect.flip)).code,
        "invalid_manifest"
      );
      yield* fs.remove(path.join(root, "server"), { recursive: true });
      yield* fs.symlink(outside, path.join(root, "server"));
      assert.strictEqual(
        (yield* discoverServerModules(root).pipe(Effect.flip)).code,
        "invalid_manifest"
      );
    })
  );
});
