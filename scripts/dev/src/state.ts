/**
 * What lives under `<worktree>/.local/dev/` and how the runner reads and
 * writes it. `plan.json` is the handoff between `start` and the supervisor
 * and the record `status`/`stop` act on; `env` is what the CLI sources;
 * `dev.log` is every process's lines, including why the supervisor stopped.
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

/** Starts the supervisor's `[dev]` line in `dev.log` that says why it stopped. */
export const FAILED = "error: ";

/**
 * What the supervisor with this pid logged as the reason it stopped: the last
 * marked line between its own `supervisor pid=` line and the next run's, so
 * another run's failure is never reported for this one. `start` prints it when
 * the supervisor exits before the server is healthy.
 */
export const failureOf = (log: string, pid: number) => {
  const start = log.lastIndexOf(`[dev] supervisor pid=${pid} `);
  if (start === -1) return undefined;
  const next = log.indexOf("[dev] supervisor pid=", start + 1);
  const marker = `[dev] ${FAILED}`;
  const line = log
    .slice(start, next === -1 ? undefined : next)
    .split("\n")
    .filter((entry) => entry.includes(marker))
    .at(-1);
  return line?.slice(line.indexOf(marker) + marker.length);
};

const planFileOf = (stateDir: string, path: Path.Path) => path.join(stateDir, "plan.json");
const decodePlan = Schema.decodeUnknownEffect(PlanJson);
const encodePlan = Schema.encodeSync(PlanJson);

/** The recorded plan, if a `start` ever ran here. A corrupt file is a decode failure, not `None`. */
export const readPlan = Effect.fn("readPlan")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = planFileOf(stateDir, path);
  if (!(yield* fs.exists(file))) return Option.none();
  const text = yield* fs.readFileString(file);
  return Option.some(yield* decodePlan(text));
});

export const writePlan = Effect.fn("writePlan")(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(plan.stateDir, { recursive: true });
  yield* fs.writeFileString(planFileOf(plan.stateDir, path), encodePlan(plan));
});

/** `.local/dev/env`: `export`-free `KEY=value` lines, so both `set -a; . env` and dotenv readers take it. */
export const envFileContents = (plan: Plan) =>
  [
    `PATCHY_API_URL=${plan.apiUrl}`,
    `PATCHY_API_TOKEN=${plan.token}`,
    `DATABASE_URL=${plan.databaseUrl}`,
    `PATCHY_COMPANY_DB_ADMIN_URL=${plan.databaseUrl}`,
    `PATCHY_COMPANY_DB_URL=${plan.databaseUrl}`
  ].join("\n") + "\n";

export const writeEnv = Effect.fn("writeEnv")(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(layout(plan, path).envFile, envFileContents(plan));
});
