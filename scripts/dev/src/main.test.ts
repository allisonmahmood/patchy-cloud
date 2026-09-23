import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import rootPackage from "../../../package.json" with { type: "json" };
import { computePlan } from "./plan.js";
import { alive } from "./process.js";
import { writePlan } from "./state.js";

const repoRoot = new URL("../../../", import.meta.url);

/**
 * A disposable worktree whose broker source does not compile. It borrows the
 * real runner and dependencies by symlink, so `.local/dev` lands here.
 */
const brokenWorktree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* path.fromFileUrl(repoRoot);
  const dir = yield* fs.makeTempDirectoryScoped();
  yield* fs.makeDirectory(path.join(dir, ".git"));
  yield* fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"));
  yield* fs.makeDirectory(path.join(dir, "scripts"));
  yield* fs.symlink(path.join(root, "scripts/dev"), path.join(dir, "scripts/dev"));
  yield* fs.copyFile(
    path.join(root, "scripts/build-serving-broker.mjs"),
    path.join(dir, "scripts/build-serving-broker.mjs")
  );
  yield* fs.makeDirectory(path.join(dir, "packages/serving/src"), { recursive: true });
  yield* fs.writeFileString(path.join(dir, "packages/serving/src/broker.ts"), "export const = ;\n");
  return dir;
});

/** `pnpm dev <args>` as pnpm runs it: the root script with the arguments appended. */
const pnpmDev = Effect.fn(function* (cwd: string, args: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("sh", ["-c", `${rootPackage.scripts.dev} ${args}`], { cwd, stdin: "ignore" })
  );
  const stderr = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString);
  return { exitCode: yield* child.exitCode, stderr };
});

it.layer(NodeServices.layer)("pnpm dev with a broker that does not compile", (it) => {
  it.effect(
    "stop still stops the recorded supervisor",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const worktree = yield* brokenWorktree;
        const supervisor = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
        );
        const plan = yield* computePlan(worktree, () => Effect.succeed(true));
        yield* writePlan({ ...plan, pids: { supervisor: supervisor.pid } });

        const stop = yield* pnpmDev(worktree, "stop");

        assert.strictEqual(stop.exitCode, 0, stop.stderr);
        assert.isFalse(yield* alive(supervisor.pid));
        assert.isTrue(yield* fs.exists(path.join(worktree, ".local/dev/plan.json")));
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "reset fails on the build before stopping or wiping anything",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const worktree = yield* brokenWorktree;
        const supervisor = yield* spawner.spawn(
          ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
        );
        const plan = yield* computePlan(worktree, () => Effect.succeed(true));
        yield* writePlan({ ...plan, pids: { supervisor: supervisor.pid } });

        const reset = yield* pnpmDev(worktree, "reset");

        assert.strictEqual(reset.exitCode, 1);
        assert.include(reset.stderr, "broker.ts");
        assert.isTrue(yield* alive(supervisor.pid));
        assert.isTrue(yield* fs.exists(path.join(worktree, ".local/dev/plan.json")));
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect(
    "start fails on the build before recording anything",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const worktree = yield* brokenWorktree;

        const start = yield* pnpmDev(worktree, "");

        assert.strictEqual(start.exitCode, 1);
        assert.include(start.stderr, "broker.ts");
        assert.isFalse(yield* fs.exists(path.join(worktree, ".local/dev/plan.json")));
      }).pipe(Effect.scoped),
    30_000
  );
});
