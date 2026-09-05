import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
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

const cleanup = process.argv[2] === "--cleanup";
if (!cleanup) process.env.CLERK_TEST_RUN_ID ??= randomUUID();
const settings = liveSettings(process.env);
if (cleanup) {
  await sweep(settings);
  console.log(`Clerk sweep ${settings.runId}: zero users remain.`);
} else {
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.clerk.config.ts"],
    {
      stdio: "inherit",
      env: process.env
    }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
