import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, homedir } from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { developerEnvFile, readDeveloperEnv } from "./dev/src/developerEnv.js";
import { liveSettings, sweep } from "../packages/auth/live/fixtures.js";

// Never fill a partial pair or mask an eligible CI run's missing secret.
if (
  !process.env.GITHUB_ACTIONS &&
  process.env.CLERK_SECRET_KEY === undefined &&
  process.env.CLERK_PUBLISHABLE_KEY === undefined
) {
  const keys = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* readDeveloperEnv(yield* developerEnvFile(homedir()));
    }).pipe(Effect.provide(NodeServices.layer))
  );
  for (const name of ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"] as const) {
    if (keys[name] !== undefined) process.env[name] = keys[name];
  }
}

const args = process.argv.slice(2);
const cleanup = args[0] === "--cleanup";
const browserOnly = args[0] === "--browser";
if ((!cleanup && !browserOnly && args.length > 0) || (cleanup && args.length > 1))
  throw new Error("Usage: pnpm test:clerk [--browser <Playwright args> | --cleanup]");
if (!cleanup) process.env.CLERK_TEST_RUN_ID ??= randomUUID();
const settings = liveSettings(process.env);
console.log(`Clerk live run: ${settings.runId}`);

let activeChild: ChildProcess | undefined;
let interrupted: NodeJS.Signals | undefined;
const onSignal = (signal: NodeJS.Signals) => {
  interrupted ??= signal;
  if (activeChild?.pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? activeChild.pid : -activeChild.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
};
const onInterrupt = () => onSignal("SIGINT");
const onTerminate = () => onSignal("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

function run(commandArgs: string[]): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const child = spawn("pnpm", ["exec", ...commandArgs], {
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32"
  });
  activeChild = child;
  child.once("error", reject);
  child.once("close", (code, signal) => {
    activeChild = undefined;
    resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
  });
  return promise;
}

let exitCode = 0;
try {
  if (!cleanup) {
    if (!browserOnly) exitCode = await run(["vitest", "run", "--config", "vitest.clerk.config.ts"]);
    if (!interrupted) {
      const browserExitCode = await run([
        "playwright",
        "test",
        "--config",
        "playwright.clerk.config.ts",
        ...(browserOnly ? args.slice(1) : [])
      ]);
      exitCode ||= browserExitCode;
    }
  }
} catch {
  console.error(`Clerk live runner failed for run ${settings.runId}.`);
  exitCode ||= 1;
} finally {
  try {
    await Effect.runPromise(
      sweep(settings).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())))
    );
    console.log(`Clerk sweep ${settings.runId}: zero users remain.`);
  } catch {
    console.error(
      `Clerk sweep failed. Retry: CLERK_TEST_RUN_ID=${settings.runId} pnpm test:clerk --cleanup`
    );
    exitCode ||= 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.exitCode = interrupted ? 128 + constants.signals[interrupted] : exitCode;
  }
}
