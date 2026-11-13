// @effect-diagnostics nodeBuiltinImport:off -- The cluster probe spawns with node:child_process: Effect's spawner signals a child's process group when it exits non-zero, which would stop Postgres itself and hide whether the exit hook did.
import { spawn } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const embeddedPostgres = import.meta.resolve("embedded-postgres");
/** Node with embedded-postgres loaded first, as every process that starts a cluster has it. */
const nodeArgs = (code: string, ...args: ReadonlyArray<string>) => [
  "--import",
  embeddedPostgres,
  "--input-type=module",
  "-e",
  code,
  ...args
];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** SIGKILLs whichever of `pids` still run, and waits until none does. */
const killAndWait = (pids: ReadonlyArray<number>) => {
  const owned = pids.filter((pid) => pid > 0);
  return Effect.sync(() => {
    for (const pid of owned) if (alive(pid)) process.kill(pid, "SIGKILL");
    return owned.some(alive);
  }).pipe(
    Effect.flatMap((running) => (running ? Effect.fail("still running") : Effect.void)),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
    Effect.ignore
  );
};

/** Starts a cluster in its second argument, prints the postmaster's pid, then exits 5 with it running. */
const exitWithClusterRunning = `
  import { readFileSync } from "node:fs";
  import { createServer } from "node:net";
  import path from "node:path";
  const [, specifier, databaseDir] = process.argv;
  const { default: EmbeddedPostgres } = await import(specifier);
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const postgres = new EmbeddedPostgres({ databaseDir, port, persistent: true, onLog() {}, onError() {} });
  await postgres.initialise();
  await postgres.start();
  console.log(readFileSync(path.join(databaseDir, "postmaster.pid"), "utf8").split("\\n")[0]);
  process.exit(5);
`;

// Real processes on real time: a test clock would freeze every poll below.
it.layer(NodeServices.layer, { excludeTestServices: true })("embedded Postgres shutdown", (it) => {
  it.effect("preserves a failed command's exit status", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const code = yield* spawner.exitCode(
        ChildProcess.make(process.execPath, nodeArgs("process.exitCode = 7;"))
      );
      assert.strictEqual(code, 7);
    })
  );

  it.effect(
    "stops a running cluster on process.exit, keeping its code and printing nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const databaseDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-pg-exit-" });
        const probe = spawn(
          process.execPath,
          nodeArgs(exitWithClusterRunning, embeddedPostgres, databaseDir),
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        const output = { stdout: "", stderr: "" };
        probe.stdout.on("data", (chunk) => (output.stdout += chunk));
        probe.stderr.on("data", (chunk) => (output.stderr += chunk));
        const closed = new Promise<number | null>((resolve, reject) => {
          probe.once("error", reject);
          probe.once("close", resolve);
        });
        // Registered before anything waits and after the directory, so a run that fails or times
        // out still stops the probe and its cluster, and the directory goes only after both. It
        // runs after the assertions, so it can never be what stopped Postgres.
        yield* Effect.addFinalizer(() =>
          fs.readFileString(path.join(databaseDir, "postmaster.pid")).pipe(
            Effect.map((pidFile) => Number(pidFile.split("\n")[0])),
            Effect.orElseSucceed(() => 0),
            Effect.flatMap((cluster) => killAndWait([probe.pid ?? 0, cluster]))
          )
        );

        const code = yield* Effect.promise(() => closed);
        const postmaster = Number(output.stdout.trim());
        assert.isAbove(postmaster, 0, output.stderr);
        assert.strictEqual(code, 5);
        assert.strictEqual(output.stderr, "");
        // Nothing here signals Postgres: only the hook in the exited process can have stopped it.
        yield* Effect.sync(() => alive(postmaster)).pipe(
          Effect.flatMap((running) => (running ? Effect.fail("still running") : Effect.void)),
          Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 })
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect("stops on a hangup with 128 plus its signal", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          nodeArgs(`console.log("ready"); setInterval(() => {}, 1000);`)
        )
      );
      yield* child.stdout.pipe(Stream.take(1), Stream.runDrain);
      yield* child.kill({ killSignal: "SIGHUP" });
      assert.strictEqual(yield* child.exitCode, 129);
    }).pipe(Effect.scoped)
  );
});
