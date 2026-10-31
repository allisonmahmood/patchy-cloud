import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { realNode } from "./runtimes.js";

it.layer(NodeServices.layer)("realNode", (it) => {
  it.effect("answers the binary and version of the node first on PATH", () =>
    Effect.gen(function* () {
      const node = yield* realNode();
      assert.match(node.version, /^\d+\.\d+\.\d+$/);
      assert.isTrue((yield* Path.Path).isAbsolute(node.execPath));
    })
  );

  it.effect("refuses a node first on PATH that is really Bun", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      // The Bun that `package.json` pins, under the name a person's shell looks for.
      const pinned = path.resolve(import.meta.dirname, "../../../node_modules/.bin/bun");
      yield* fs.symlink(pinned, path.join(dir, "node"));
      const PATH = `${dir}:${yield* Config.String("PATH")}`;
      const error = yield* realNode().pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PATH }))),
        Effect.flip
      );
      assert.strictEqual(error._tag, "NodeMissing");
    })
  );
});
