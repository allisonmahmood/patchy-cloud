/**
 * Running another program as one step of a command, with its progress shown.
 * The evidence commands use it for git, pnpm, gh and ffmpeg: stdout comes back
 * to the caller, stderr streams to ours line by line under a prefix, so a slow
 * side shows what it is doing and a failure's reason is already on screen.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { StepExited, StepUnavailable } from "./environment.js";

export interface StepOptions {
  readonly cwd: string;
  /** A closed environment; the caller's when omitted. */
  readonly env?: Record<string, string>;
  /** Marks each stderr line, such as `before` or `gh`. */
  readonly prefix: string;
}

/** Runs `command` to completion and returns its stdout and exit code, whatever the code. */
export const spawnStep = Effect.fn("Steps.spawnStep")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  options: StepOptions
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          stdin: "ignore",
          ...(options.env === undefined
            ? { extendEnv: true }
            : { env: options.env, extendEnv: false })
        })
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => Console.error(`  ${options.prefix.padEnd(6)}  ${line}`))
          ),
          handle.exitCode
        ],
        { concurrency: "unbounded" }
      );
      return { stdout, exitCode: Number(exitCode) };
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new StepUnavailable({ step, cause }))
    })
  );
});

/** Runs `command` and returns its trimmed stdout; a non-zero exit fails the step. */
export const stepOutput = Effect.fn("Steps.stepOutput")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  options: StepOptions
) {
  const { stdout, exitCode } = yield* spawnStep(step, command, args, options);
  if (exitCode !== 0) return yield* new StepExited({ step, exitCode });
  return stdout.trim();
});
