import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverServerModules } from "./serverModules.js";

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
