/**
 * `pnpm dev`: the local Patchy Cloud instance for this worktree.
 *
 *   pnpm dev                  start (idempotent) and print the plan
 *   pnpm dev --dry-run --json print the plan, touch nothing
 *   pnpm dev status | stop | logs | reset
 *
 * `start` writes `.local/dev/plan.json` and spawns `supervise` detached; the
 * supervisor owns the processes (see supervisor.ts) and records their pids
 * back into the same file. Every command is scoped to the worktree that
 * contains the current directory.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Plan, PlanJson, computePlan, findWorktree } from "./plan.js";
import { isPortFree } from "./ports.js";
import { layout, readPlan, writePlan } from "./state.js";
import { supervise } from "./supervisor.js";

class SupervisorExited extends Schema.TaggedError<SupervisorExited>()("SupervisorExited", {
  logFile: Schema.String
}) {
  override get message() {
    return `The supervisor exited before the server became healthy; see ${this.logFile}.`;
  }
}

class NotHealthyInTime extends Schema.TaggedError<NotHealthyInTime>()("NotHealthyInTime", {
  apiUrl: Schema.String,
  logFile: Schema.String
}) {
  override get message() {
    return `${this.apiUrl}/healthz did not answer in time; see ${this.logFile}.`;
  }
}

class SupervisorBusy extends Schema.TaggedError<SupervisorBusy>()("SupervisorBusy", {
  pid: Schema.Int
}) {
  override get message() {
    return `Supervisor ${this.pid} is alive but the server is not healthy (starting, or tearing down). Retry, or \`pnpm dev stop\`.`;
  }
}

class NoPlan extends Schema.TaggedError<NoPlan>()("NoPlan", { worktree: Schema.String }) {
  override get message() {
    return `No dev instance has been started in ${this.worktree}; run \`pnpm dev\`.`;
  }
}

// ---- Process facts --------------------------------------------------------

/** Signal 0 probes without sending: true while the pid exists and is ours to signal. */
const alive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

const signal = (pid: number, name: "SIGTERM") =>
  Effect.sync(() => {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone; nothing to stop.
    }
  });

const healthy = (plan: Plan) =>
  HttpClient.get(`${plan.apiUrl}/healthz`).pipe(
    Effect.map((response) => response.status === 200),
    Effect.orElseSucceed(() => false),
    Effect.provide(FetchHttpClient.layer)
  );

/** A plan whose supervisor is alive and whose server answers. */
const isRunning = (plan: Plan) => {
  const pids = plan.pids;
  if (pids === undefined) return Effect.succeed(false);
  return Effect.gen(function* () {
    return (yield* alive(pids.supervisor)) && (yield* healthy(plan));
  });
};

// ---- Plans ----------------------------------------------------------------

const worktree = Effect.gen(function* () {
  const path = yield* Path.Path;
  return yield* findWorktree(path.resolve("."));
});

const stateDirOf = (root: string) =>
  Effect.map(Path.Path, (path) => path.join(root, ".local", "dev"));

/**
 * The recorded plan if its instance is running, otherwise a fresh one. A
 * supervisor that is alive but not yet (or no longer) healthy still owns the
 * state dir, so starting over it would race its writes: refuse instead.
 */
const currentPlan = Effect.gen(function* () {
  const root = yield* worktree;
  const recorded = yield* readPlan(yield* stateDirOf(root));
  if (Option.isSome(recorded)) {
    const plan = recorded.value;
    if (yield* isRunning(plan)) return plan;
    if (plan.pids && (yield* alive(plan.pids.supervisor))) {
      return yield* new SupervisorBusy({ pid: plan.pids.supervisor });
    }
  }
  return yield* computePlan(root, isPortFree);
});

const printPlan = (plan: Plan, json: boolean) => {
  if (json) return Console.log(Schema.encodeSync(PlanJson)(plan));
  const pids = plan.pids
    ? `supervisor ${plan.pids.supervisor}, server ${plan.pids.server}, postgres ${plan.pids.postgres}`
    : "not running";
  return Console.log(
    [
      `Patchy Cloud dev instance for ${plan.worktree}`,
      `  API       ${plan.apiUrl}  (PATCHY_API_TOKEN=${plan.token})`,
      `  Postgres  ${plan.databaseUrl}`,
      `  State     ${plan.stateDir}  (env, plan.json, dev.log)`,
      `  Pids      ${pids}`
    ].join("\n")
  );
};

// ---- Commands -------------------------------------------------------------

const json = Flag.boolean("json").pipe(
  Flag.withDescription("Print the plan as JSON"),
  Flag.withDefault(false)
);

const dryRun = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Print the plan this worktree would run with; start nothing"),
  Flag.withDefault(false)
);

const dev = Command.make("dev", { json, dryRun }, ({ json, dryRun }) =>
  Effect.gen(function* () {
    const plan = yield* currentPlan;
    if (dryRun || (yield* isRunning(plan))) return yield* printPlan(plan, json);
    yield* printPlan(yield* start(plan), json);
  })
).pipe(Command.withDescription("Start this worktree's local Patchy Cloud instance (idempotent)"));

/** Writes the plan, spawns the supervisor detached, and waits for `/healthz`. */
const start = Effect.fn("start")(function* (plan: Plan) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const files = layout(plan, path);
  yield* writePlan(plan);

  const main = yield* path.fromFileUrl(new URL(import.meta.url));
  const supervisor = yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      ["--import", "tsx", "--conditions=development", main, "supervise"],
      {
        cwd: plan.worktree,
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        extendEnv: true
      }
    )
  );
  yield* Effect.asVoid(supervisor.unref);

  const deadline = 240; // × 250ms: initdb on a cold state dir is the slow case
  for (let attempt = 0; attempt < deadline; attempt++) {
    if (yield* healthy(plan)) {
      const recorded = yield* readPlan(plan.stateDir);
      return Option.getOrElse(recorded, () => plan);
    }
    if (!(yield* alive(supervisor.pid))) {
      return yield* new SupervisorExited({ logFile: files.logFile });
    }
    yield* Effect.sleep("250 millis");
  }
  return yield* new NotHealthyInTime({ apiUrl: plan.apiUrl, logFile: files.logFile });
});

const recordedPlan = Effect.gen(function* () {
  const root = yield* worktree;
  const recorded = yield* readPlan(yield* stateDirOf(root));
  return yield* Option.match(recorded, {
    onNone: () => new NoPlan({ worktree: root }),
    onSome: Effect.succeed
  });
});

const ProcessState = Schema.NullOr(Schema.Struct({ pid: Schema.Int, alive: Schema.Boolean }));
const StatusReport = Schema.fromJsonString(
  Schema.Struct({
    worktree: Schema.String,
    apiUrl: Schema.String,
    healthy: Schema.Boolean,
    supervisor: ProcessState,
    server: ProcessState,
    postgres: ProcessState
  }),
  { space: 2 }
);

const status = Command.make("status", { json }, ({ json }) =>
  Effect.gen(function* () {
    const plan = yield* recordedPlan;
    const pids = plan.pids;
    const report = {
      worktree: plan.worktree,
      apiUrl: plan.apiUrl,
      healthy: yield* healthy(plan),
      supervisor: pids ? { pid: pids.supervisor, alive: yield* alive(pids.supervisor) } : null,
      server: pids ? { pid: pids.server, alive: yield* alive(pids.server) } : null,
      postgres: pids ? { pid: pids.postgres, alive: yield* alive(pids.postgres) } : null
    };
    if (json) return yield* Console.log(Schema.encodeSync(StatusReport)(report));
    const state = (part: typeof ProcessState.Type) =>
      part === null ? "not started" : part.alive ? `pid ${part.pid}` : `pid ${part.pid} (dead)`;
    yield* Console.log(
      [
        `${report.healthy ? "healthy" : "not healthy"}  ${plan.apiUrl}`,
        `  supervisor  ${state(report.supervisor)}`,
        `  server      ${state(report.server)}`,
        `  postgres    ${state(report.postgres)}`
      ].join("\n")
    );
  })
).pipe(Command.withDescription("Report what is running for this worktree"));

/** SIGTERM the recorded supervisor and wait; state stays for the next start. */
const stopInstance = Effect.fn("stop")(function* (plan: Plan) {
  const pids = plan.pids;
  if (pids === undefined) return yield* Console.log("Nothing recorded to stop.");
  if (yield* alive(pids.supervisor)) {
    yield* signal(pids.supervisor, "SIGTERM");
    for (let attempt = 0; attempt < 60 && (yield* alive(pids.supervisor)); attempt++) {
      yield* Effect.sleep("250 millis");
    }
  }
  // A supervisor that died without tearing down leaves its children behind;
  // those pids are recorded too, so they are still ours to stop.
  for (const pid of [pids.server, pids.postgres]) {
    if (yield* alive(pid)) yield* signal(pid, "SIGTERM");
  }
  const leftover = yield* alive(pids.supervisor);
  yield* Console.log(leftover ? `Supervisor ${pids.supervisor} is still running.` : "Stopped.");
});

const stop = Command.make("stop", {}, () => Effect.flatMap(recordedPlan, stopInstance)).pipe(
  Command.withDescription("Stop this worktree's instance, keeping its state")
);

const logs = Command.make("logs", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = layout(yield* recordedPlan, path).logFile;
    if (!(yield* fs.exists(file))) return yield* Console.log("(no log yet)");
    yield* Console.log(yield* fs.readFileString(file));
  })
).pipe(Command.withDescription("Print this worktree's dev.log"));

const reset = Command.make("reset", { json }, ({ json }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* stateDirOf(yield* worktree);
    // Reset is the recovery path, so an unreadable plan.json is wiped, not fatal.
    const recorded = yield* readPlan(stateDir).pipe(
      Effect.catchTags({ SchemaError: () => Effect.succeed(Option.none()) })
    );
    if (Option.isSome(recorded)) yield* stopInstance(recorded.value);
    yield* fs.remove(stateDir, { recursive: true, force: true });
    const plan = yield* computePlan(yield* worktree, isPortFree);
    yield* printPlan(yield* start(plan), json);
  })
).pipe(Command.withDescription("Stop, wipe .local/dev, and start a fresh seeded instance"));

/** The detached process `start` spawns. Reads the plan `start` wrote. */
const superviseCommand = Command.make("supervise", {}, () =>
  Effect.flatMap(recordedPlan, supervise).pipe(Effect.scoped)
).pipe(Command.unlisted);

/** Agent-facing surface: `--help`/`--version` only; failures are one line, no stack. */
const CliSurface = Layer.mergeAll(
  CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
  CliOutput.layer({
    ...CliOutput.defaultFormatter(),
    formatVersion: (_name, version) => version,
    formatError: (error) => error.message
  })
);

dev.pipe(
  Command.withSubcommands([status, stop, logs, reset, superviseCommand]),
  Command.run({ version: "0.0.0" }),
  Effect.scoped,
  Effect.catch((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
  Effect.provide([NodeServices.layer, CliSurface]),
  NodeRuntime.runMain
);
