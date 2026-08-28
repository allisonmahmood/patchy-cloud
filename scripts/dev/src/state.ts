/**
 * What lives under `<worktree>/.local/dev/` and how the runner reads and
 * writes it. `plan.json` is the handoff between `start` and the supervisor
 * and the record `status`/`stop` act on; `env` is what the CLI sources.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Plan, PlanJson } from "./plan.js";

export const layout = (plan: Plan, path: Path.Path) => ({
  planFile: path.join(plan.stateDir, "plan.json"),
  envFile: path.join(plan.stateDir, "env"),
  logFile: path.join(plan.stateDir, "dev.log"),
  postgresDir: path.join(plan.stateDir, "postgres"),
  storageDir: path.join(plan.stateDir, "storage")
});

const planFileOf = (stateDir: string, path: Path.Path) => path.join(stateDir, "plan.json");

/** The recorded plan, if a `start` ever ran here. A corrupt file is a decode failure, not `None`. */
export const readPlan = Effect.fn("readPlan")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = planFileOf(stateDir, path);
  if (!(yield* fs.exists(file))) return Option.none();
  const text = yield* fs.readFileString(file);
  return Option.some(yield* Schema.decodeUnknownEffect(PlanJson)(text));
});

export const writePlan = Effect.fn("writePlan")(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(plan.stateDir, { recursive: true });
  yield* fs.writeFileString(planFileOf(plan.stateDir, path), Schema.encodeSync(PlanJson)(plan));
});

/** `.local/dev/env`: `export`-free `KEY=value` lines, so both `set -a; . env` and dotenv readers take it. */
export const envFileContents = (plan: Plan) =>
  [
    `PATCHY_API_URL=${plan.apiUrl}`,
    `PATCHY_API_TOKEN=${plan.token}`,
    `DATABASE_URL=${plan.databaseUrl}`
  ].join("\n") + "\n";

export const writeEnv = Effect.fn("writeEnv")(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(layout(plan, path).envFile, envFileContents(plan));
});
