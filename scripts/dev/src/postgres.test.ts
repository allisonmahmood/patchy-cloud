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

/** A Node process that loads embedded-postgres, then runs `code` as a module. */
const withEmbeddedPostgres = (code: string) =>
  ChildProcess.make(process.execPath, [
    "--import",
    embeddedPostgres,
    "--input-type=module",
    "-e",
    code
  ]);

it.layer(NodeServices.layer)("embedded Postgres shutdown", (it) => {
  it.effect("preserves a failed command's exit status", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const code = yield* spawner.exitCode(withEmbeddedPostgres("process.exitCode = 7;"));
      assert.strictEqual(code, 7);
    })
  );

  it.effect(
    "stops a running cluster on process.exit, keeping its code and printing nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const databaseDir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-pg-exit-" });
        const child = yield* spawner.spawn(
          withEmbeddedPostgres(`
            import { createServer } from "node:net";
            const { default: EmbeddedPostgres } = await import(${JSON.stringify(embeddedPostgres)});
            const server = createServer().listen(0, "127.0.0.1");
            await new Promise((resolve) => server.once("listening", resolve));
            const { port } = server.address();
            await new Promise((resolve) => server.close(resolve));
            const postgres = new EmbeddedPostgres({
              databaseDir: ${JSON.stringify(databaseDir)},
              port,
              persistent: true,
              onLog() {},
              onError() {}
            });
            await postgres.initialise();
            await postgres.start();
            process.exit(5);
          `)
        );
        const [stderr, code] = yield* Effect.all(
          [child.stderr.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
          { concurrency: "unbounded" }
        );

        assert.strictEqual(code, 5);
        assert.strictEqual(stderr, "");
        // Postgres removes its pid file once it has shut down.
        yield* fs.exists(path.join(databaseDir, "postmaster.pid")).pipe(
          Effect.flatMap((running) => (running ? Effect.fail("running") : Effect.void)),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 })
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.effect("stops on a hangup with 128 plus its signal", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        withEmbeddedPostgres(`console.log("ready"); setInterval(() => {}, 1000);`)
      );
      yield* child.stdout.pipe(Stream.take(1), Stream.runDrain);
      yield* child.kill({ killSignal: "SIGHUP" });
      assert.strictEqual(yield* child.exitCode, 129);
    }).pipe(Effect.scoped)
  );
});
