import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { LocalError } from "./CliError.js";

export const processResult = Effect.fn("processResult")(function* (
  cwd: string,
  command: string,
  args: readonly string[],
  env?: Record<string, string>
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(command, args, {
        cwd,
        env,
        extendEnv: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe"
      });
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode
        ],
        { concurrency: "unbounded" }
      );
      return { stdout, stderr, code };
    })
  ).pipe(
    Effect.mapError((cause) => new LocalError({ message: `Could not run ${command}.`, cause }))
  );
});
