import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

it.layer(NodeServices.layer)("embedded Postgres shutdown", (it) => {
  it.effect("preserves a failed command's exit status", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const code = yield* spawner.exitCode(
        ChildProcess.make(process.execPath, [
          "--import",
          import.meta.resolve("embedded-postgres"),
          "-e",
          "process.exitCode = 7;"
        ])
      );
      assert.strictEqual(code, 7);
    })
  );
});
