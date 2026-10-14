import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layoutOf, writeLauncher } from "./environment.js";

it.layer(NodeServices.layer)("the agent launcher", (it) => {
  it.effect("starts claude without the shell's PATCHY_API_URL and PATCHY_API_TOKEN", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const dir = yield* fs.makeTempDirectoryScoped();
      const layout = layoutOf(path.join(dir, "environment"), path);
      yield* fs.makeDirectory(layout.workspace, { recursive: true });
      yield* writeLauncher(layout);
      const stubs = path.join(dir, "stubs");
      yield* fs.makeDirectory(stubs);
      yield* fs.writeFileString(path.join(stubs, "claude"), "#!/bin/sh\nenv\n", { mode: 0o755 });

      const child = yield* spawner.spawn(
        ChildProcess.make(layout.agent, [], {
          env: {
            PATH: `${stubs}:${yield* Config.String("PATH")}`,
            PATCHY_API_URL: "https://elsewhere.invalid",
            PATCHY_API_TOKEN: "patchy_elsewhere"
          },
          stdin: "ignore"
        })
      );
      const env = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);

      assert.strictEqual(yield* child.exitCode, 0);
      assert.include(env, `PATCHY_STATE_DIR=${layout.state}`);
      assert.notInclude(env, "PATCHY_API_URL");
      assert.notInclude(env, "PATCHY_API_TOKEN");
    }).pipe(Effect.scoped)
  );
});
