import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layoutOf, writeAgent } from "./environment.js";

const API_URL = "http://env.localhost:4100";

/** An environment in a temp folder with its agent written, and a `claude` stub printing `script`'s output. */
const environmentWith = Effect.fn(function* (script: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const layout = layoutOf(path.join(dir, "environment"), path);
  yield* fs.makeDirectory(layout.workspace, { recursive: true });
  yield* writeAgent(layout, API_URL);
  const stubs = path.join(dir, "stubs");
  yield* fs.makeDirectory(stubs);
  yield* fs.writeFileString(path.join(stubs, "claude"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { dir, layout, PATH: `${stubs}:${yield* Config.String("PATH")}` };
});

/** Runs the launcher with exactly `env`, returning its exit code and stdout. */
const launch = Effect.fn(function* (agent: string, env: Record<string, string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(agent, [], { env, extendEnv: false, stdin: "ignore" })
  );
  const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
  return { exitCode: yield* child.exitCode, stdout };
});

it.layer(NodeServices.layer)("the agent launcher", (it) => {
  it.effect("aims the CLI at its instance, drops the shell's token and turns auto memory off", () =>
    Effect.gen(function* () {
      const { layout, PATH } = yield* environmentWith("env");
      const { exitCode, stdout } = yield* launch(layout.agent, {
        PATH,
        PATCHY_API_URL: "https://elsewhere.invalid",
        PATCHY_API_TOKEN: "patchy_elsewhere"
      });

      assert.strictEqual(exitCode, 0);
      const env = stdout.split("\n");
      assert.include(env, `PATCHY_API_URL=${API_URL}`);
      assert.include(env, `PATCHY_STATE_DIR=${layout.state}`);
      assert.include(env, "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
      assert.notInclude(stdout, "PATCHY_API_TOKEN");
    }).pipe(Effect.scoped)
  );

  it.effect("gives each session a temp folder of its own and deletes it when claude exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, layout, PATH } = yield* environmentWith(
        `printf 'TMPDIR=%s\\n' "$TMPDIR"; printf '%s\\n' "$@"; exit 7`
      );
      const scratch = path.join(dir, "scratch");
      yield* fs.makeDirectory(scratch);
      const session = Effect.fn(function* (env: Record<string, string>) {
        const { exitCode, stdout } = yield* launch(layout.agent, { PATH, ...env });
        assert.strictEqual(exitCode, 7);
        const lines = stdout.split("\n");
        const temp = lines[0]!.slice("TMPDIR=".length);
        assert.strictEqual(lines[lines.indexOf("--add-dir") + 1], temp);
        assert.isFalse(yield* fs.exists(temp));
        return temp;
      });

      const first = yield* session({ TMPDIR: scratch });
      const second = yield* session({ TMPDIR: scratch });
      assert.strictEqual(path.dirname(first), scratch);
      assert.strictEqual(path.dirname(second), scratch);
      assert.notStrictEqual(first, second);
      assert.strictEqual(path.dirname(yield* session({})), "/tmp");
    }).pipe(Effect.scoped)
  );

  it.effect(
    "tells the agent to make new work in the workspace, keeping a CLAUDE.md that exists",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { layout } = yield* environmentWith("true");
        const file = path.join(layout.workspace, "CLAUDE.md");

        assert.strictEqual(
          yield* fs.readFileString(file),
          "Make each new patch or page directly in this folder.\n"
        );
        yield* fs.writeFileString(file, "Your own notes.\n");
        yield* writeAgent(layout, API_URL);
        assert.strictEqual(yield* fs.readFileString(file), "Your own notes.\n");
      }).pipe(Effect.scoped)
  );
});
