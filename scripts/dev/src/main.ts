/**
 * `pnpm dev`: the local Patchy Cloud instance for this worktree.
 *
 *   pnpm dev                  start (idempotent) and print the plan; people sign in as dev personas
 *   pnpm dev --clerk          the same, signing people in through the developer's Clerk application
 *   pnpm dev --dry-run --json print the plan, touch nothing
 *   pnpm dev status | stop | logs | reset
 *   pnpm dev up [scenario]    an environment: personas, a CLI, an agent workspace
 *   pnpm dev open <person>    a browser window signed in as one of its people
 *   pnpm dev shot <person> [path]  a full-page PNG as that person, with the page's errors
 *   pnpm dev mcp-token <person> --client <name>  an agent connection's token, without consent
 *   pnpm dev compare <person> <path>...  pages before and after, from evidence instances
 *   pnpm dev film <person> <flow>        a flow recorded before and after, as mp4
 *   pnpm dev transcript <script>         CLI lines run before and after, compared
 *   pnpm dev trial "<task>"              a fresh agent tries a task before and after
 *   pnpm dev down             stop everything and delete everything up made
 *
 * A start or reset first bundles the shell broker (nothing else compiles it,
 * so a broken broker never blocks `stop`). `start` then writes
 * `.local/dev/plan.json` and spawns `supervise` detached; the
 * supervisor owns the processes (see supervisor.ts) and records their pids
 * back into the same file. Every command is scoped to the worktree that
 * contains the current directory.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Argument, CliConfig, CliError, CliOutput, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AgentConnections } from "@patchy/auth";
import { NodeCryptography } from "@patchy/core";
import { mintDevAgentConnection } from "@patchy/auth/seed";
import { layerFromUrl } from "@patchy/sql";
import { Capture, checkChromium, compareMarkdown, type Pair, shootAll } from "./compare.js";
import {
  type Before,
  type Commit,
  evidence,
  provenanceLines,
  removeEvidence,
  resolveCommits,
  scenarioFor,
  type Served,
  UncommittedChanges
} from "./evidence.js";
import { developerEnvFile } from "./developerEnv.js";
import {
  encodeManifest,
  findPerson,
  layoutFor,
  openPerson,
  printCard,
  readManifest,
  screenshot,
  setUp,
  Shot,
  tearDown
} from "./environment.js";
import { checkFfmpeg, filmMarkdown, filmSide, loadFlow, sideBySide, Take } from "./film.js";
import { type Environment, Plan, PlanJson, computePlan, findWorktree, signInOf } from "./plan.js";
import { isPortFree } from "./ports.js";
import { takeDownRecorded } from "./pidgeon.js";
import { alive, signal } from "./process.js";
import { bun, realNode } from "./runtimes.js";
import { loadScenario, Person } from "./scenario.js";
import {
  checkPr,
  draftSection,
  keyedSection,
  MAX_ATTACHMENTS,
  PartialPublication,
  type PrTarget,
  publishSection,
  sectionKey,
  TooManyAttachments
} from "./publish.js";
import { makeSanitizer, redactionLine, SECRET_SOURCES } from "./sanitize.js";
import { failureOf, layout, readPlan, writePlan } from "./state.js";
import {
  type Compared,
  loadScript,
  normalize,
  Run,
  runScript,
  type SideShell,
  sideShell,
  transcriptMarkdown
} from "./transcript.js";
import {
  type AgentShell,
  agentShell,
  Attempt,
  checkClaude,
  cleanAttempt,
  identities,
  runAgent,
  TaskRefused,
  taskRefusal,
  trialKey,
  trialMarkdown
} from "./trial.js";

class BrokerBuildFailed extends Schema.TaggedError<BrokerBuildFailed>()("BrokerBuildFailed", {
  exitCode: Schema.Number
}) {
  override get message() {
    return `The shell broker failed to build (exit ${this.exitCode}); see its errors above.`;
  }
}

class SupervisorExited extends Schema.TaggedError<SupervisorExited>()("SupervisorExited", {
  failure: Schema.optional(Schema.String),
  logFile: Schema.String
}) {
  override get message() {
    return this.failure === undefined
      ? `The supervisor exited before the server became healthy; see ${this.logFile}.`
      : `${this.failure}\nSee ${this.logFile}.`;
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

class NotHealthy extends Schema.TaggedError<NotHealthy>()("NotHealthy", { apiUrl: Schema.String }) {
  override get message() {
    return `${this.apiUrl} is not serving; run \`pnpm dev\`.`;
  }
}

class NoPlan extends Schema.TaggedError<NoPlan>()("NoPlan", { worktree: Schema.String }) {
  override get message() {
    return `No dev instance has been started in ${this.worktree}; run \`pnpm dev\`.`;
  }
}

class NotAnEnvironment extends Schema.TaggedError<NotAnEnvironment>()("NotAnEnvironment", {
  worktree: Schema.String
}) {
  override get message() {
    return `This worktree's instance signs in with Clerk. \`pnpm dev down\` deletes it (data included) so \`pnpm dev up\` can start an environment.`;
  }
}

class NotClerk extends Schema.TaggedError<NotClerk>()("NotClerk", {
  worktree: Schema.String
}) {
  override get message() {
    return `This worktree's instance signs in as dev personas. \`pnpm dev down\` deletes it (data included) so \`pnpm dev --clerk\` can start one that signs in with Clerk.`;
  }
}

class NeedsPersonas extends Schema.TaggedError<NeedsPersonas>()("NeedsPersonas", {
  worktree: Schema.String
}) {
  override get message() {
    return `This worktree's instance signs in with Clerk, which a script cannot pass. \`pnpm dev down\`, then \`pnpm dev\` starts one with dev personas.`;
  }
}

class OtherScenario extends Schema.TaggedError<OtherScenario>()("OtherScenario", {
  current: Schema.String,
  requested: Schema.String
}) {
  override get message() {
    return `This worktree's environment is the ${this.current} scenario. \`pnpm dev down\` first to start ${this.requested}.`;
  }
}

class EnvironmentPortsTaken extends Schema.TaggedError<EnvironmentPortsTaken>()(
  "EnvironmentPortsTaken",
  { apiUrl: Schema.String }
) {
  override get message() {
    return `Another process holds this environment's ports (${this.apiUrl}); its CLI and repos point there. Free them, or \`pnpm dev down\` to start over.`;
  }
}

class NoEnvironment extends Schema.TaggedError<NoEnvironment>()("NoEnvironment", {
  worktree: Schema.String
}) {
  override get message() {
    return `No environment is up in ${this.worktree}; run \`pnpm dev up\`.`;
  }
}

/**
 * Every failure an agent can act on becomes one stderr line and exit 1: each
 * handler ends in this, so `Command.run` formats it instead of `runMain`
 * printing a stack.
 */
const userFacing = <A, E extends { readonly message: string }, R>(self: Effect.Effect<A, E, R>) =>
  Effect.catch(self, (cause) => new CliError.UserError({ cause, userMessage: cause.message }));

// ---- Instance facts -------------------------------------------------------

/** Bounded: a server that accepts the socket but never answers is not healthy either. */
const healthy = (plan: Plan) =>
  HttpClient.get(`${plan.apiUrl}/healthz`).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => false)
  );

/** A plan whose supervisor is alive and whose server answers. */
const isRunning = Effect.fn("isRunning")(function* (plan: Plan) {
  return plan.pids !== undefined && (yield* alive(plan.pids.supervisor)) && (yield* healthy(plan));
});

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
 * state dir, so starting over it would race its writes: a start refuses, a
 * dry run just reports what is recorded.
 */
const currentPlan = Effect.fn("currentPlan")(function* (
  dryRun: boolean,
  environment?: Environment,
  clerk = false
) {
  const root = yield* worktree;
  const recorded = yield* readPlan(yield* stateDirOf(root));
  if (Option.isSome(recorded)) {
    const plan = recorded.value;
    // An instance keeps how it signs people in; `--clerk` never converts a personas one.
    if (clerk && signInOf(plan) === "personas") return yield* new NotClerk({ worktree: root });
    if (yield* isRunning(plan)) return plan;
    if (plan.pids && (yield* alive(plan.pids.supervisor))) {
      return dryRun ? plan : yield* new SupervisorBusy({ pid: plan.pids.supervisor });
    }
    // A stopped environment restarts on the recorded ports its CLI and repos
    // are bound to, or refuses; plain `pnpm dev` never turns it into Clerk.
    if (plan.environment !== undefined) {
      if (!(yield* isPortFree(plan.ports.server)) || !(yield* isPortFree(plan.ports.postgres)))
        return yield* new EnvironmentPortsTaken({ apiUrl: plan.apiUrl });
      return {
        worktree: plan.worktree,
        stateDir: plan.stateDir,
        ports: plan.ports,
        apiUrl: plan.apiUrl,
        databaseUrl: plan.databaseUrl,
        token: plan.token,
        environment: plan.environment,
        signIn: "personas"
      } satisfies Plan;
    }
    return yield* computePlan(root, isPortFree, environment, signInOf(plan));
  }
  return yield* computePlan(root, isPortFree, environment, clerk ? "clerk" : "personas");
});

const encodePlan = Schema.encodeSync(PlanJson);

const printPlan = (plan: Plan, json: boolean) => {
  if (json) return Console.log(encodePlan(plan));
  const pids = plan.pids
    ? `supervisor ${plan.pids.supervisor}, server ${plan.pids.server ?? "-"}, postgres ${plan.pids.postgres ?? "-"}`
    : "not started";
  return Console.log(
    [
      `Patchy Cloud dev instance for ${plan.worktree}`,
      `  API       ${plan.apiUrl}  (PATCHY_API_TOKEN=${plan.token})`,
      signInOf(plan) === "personas"
        ? `  Sign in   ${plan.apiUrl}/dev/sign-in  (dev personas, any email)`
        : `  Sign in   ${plan.apiUrl}/join  (Clerk)`,
      `  Postgres  ${plan.databaseUrl}`,
      `  State     ${plan.stateDir}  (env, plan.json, dev.log)`,
      `  Pids      ${pids}`
    ].join("\n")
  );
};

// ---- Commands -------------------------------------------------------------

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the plan as JSON"),
  Flag.withDefault(false)
);

const dryRun = Flag.Boolean("dry-run").pipe(
  Flag.withDescription("Print the plan this worktree would run with; start nothing"),
  Flag.withDefault(false)
);

const clerk = Flag.Boolean("clerk").pipe(
  Flag.withDescription(
    "Sign people in through your Clerk development application instead of as dev personas"
  ),
  Flag.withDefault(false)
);

const dev = Command.make(
  "dev",
  { json, dryRun, clerk },
  Effect.fn(function* ({ json, dryRun, clerk }) {
    const plan = yield* currentPlan(dryRun, undefined, clerk);
    if (dryRun || (yield* isRunning(plan))) return yield* printPlan(plan, json);
    yield* buildBroker(plan.worktree);
    yield* printPlan(yield* start(plan), json);
  }, userFacing)
).pipe(Command.withDescription("Start this worktree's local Patchy Cloud instance (idempotent)"));

/**
 * Bundles the shell broker the server serves. Start and reset call it before
 * they record, stop or wipe anything, so a broker that does not compile
 * leaves the instance as it was; stop, status and logs never wait on it.
 * Errors go to stderr; stdout stays the plan for `--json`.
 */
const buildBroker = Effect.fn("buildBroker")(function* (worktree: string) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const node = yield* realNode();
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(node.execPath, [path.join(worktree, "scripts/build-serving-broker.mjs")], {
      cwd: worktree,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit"
    })
  );
  if (exitCode !== 0) return yield* new BrokerBuildFailed({ exitCode });
});

/**
 * Writes the plan, spawns the supervisor detached, records its pid at once
 * (so a second start during initdb sees it and refuses), then waits for
 * `/healthz`. A supervisor that exits first is reported with the failure it
 * logged to dev.log, when it logged one. Callers build the broker first.
 */
const start = Effect.fn("start")(function* (plan: Plan) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const files = layout(plan, path);
  yield* writePlan(plan);

  const main = yield* path.fromFileUrl(new URL(import.meta.url));
  const supervisor = yield* spawner.spawn(
    ChildProcess.make(bun, ["--conditions=development", main, "supervise"], {
      cwd: plan.worktree,
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      extendEnv: true
    })
  );
  yield* Effect.asVoid(supervisor.unref);
  yield* writePlan({ ...plan, pids: { supervisor: supervisor.pid } });

  const deadline = 240; // × 250ms: initdb on a cold state dir is the slow case
  for (let attempt = 0; attempt < deadline; attempt++) {
    if (yield* healthy(plan)) {
      const recorded = yield* readPlan(plan.stateDir);
      return Option.getOrElse(recorded, () => plan);
    }
    if (!(yield* alive(supervisor.pid))) {
      const log = yield* fs.readFileString(files.logFile).pipe(Effect.orElseSucceed(() => ""));
      return yield* new SupervisorExited({
        failure: failureOf(log, supervisor.pid),
        logFile: files.logFile
      });
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
const encodeStatus = Schema.encodeSync(StatusReport);

const renderStatus = (report: typeof StatusReport.Type) => {
  const state = (part: typeof ProcessState.Type) =>
    part === null ? "not started" : part.alive ? `pid ${part.pid}` : `pid ${part.pid} (dead)`;
  return [
    `${report.healthy ? "healthy" : "not healthy"}  ${report.apiUrl}`,
    `  supervisor  ${state(report.supervisor)}`,
    `  server      ${state(report.server)}`,
    `  postgres    ${state(report.postgres)}`
  ].join("\n");
};

const status = Command.make(
  "status",
  { json },
  Effect.fn(function* ({ json }) {
    const plan = yield* recordedPlan;
    const probe = Effect.fn(function* (pid: number | undefined) {
      return pid === undefined ? null : { pid, alive: yield* alive(pid) };
    });
    const report = {
      worktree: plan.worktree,
      apiUrl: plan.apiUrl,
      healthy: yield* healthy(plan),
      supervisor: yield* probe(plan.pids?.supervisor),
      server: yield* probe(plan.pids?.server),
      postgres: yield* probe(plan.pids?.postgres)
    };
    if (json) yield* Console.log(encodeStatus(report));
    else yield* Console.log(renderStatus(report));
    if (!report.healthy) return yield* new NotHealthy({ apiUrl: plan.apiUrl });
  }, userFacing)
).pipe(Command.withDescription("Report what is running for this worktree; exit 1 unless healthy"));

/**
 * SIGTERM the recorded supervisor and wait; state stays for the next start.
 * `say` reports progress: stdout for `stop`, stderr where stdout carries JSON.
 */
const stopInstance = Effect.fn("stop")(function* (
  plan: Plan,
  say: (line: string) => Effect.Effect<void> = Console.log
) {
  const pids = plan.pids;
  if (pids === undefined) return yield* say("Nothing recorded to stop.");
  if (yield* alive(pids.supervisor)) {
    yield* signal(pids.supervisor, "SIGTERM");
    for (let attempt = 0; attempt < 60 && (yield* alive(pids.supervisor)); attempt++) {
      yield* Effect.sleep("250 millis");
    }
  }
  // A supervisor that died without tearing down leaves its children behind;
  // those pids are recorded too, so they are still ours to stop.
  for (const pid of [pids.server, pids.postgres]) {
    if (pid !== undefined && (yield* alive(pid))) yield* signal(pid, "SIGTERM");
  }
  const leftover = yield* alive(pids.supervisor);
  yield* say(leftover ? `Supervisor ${pids.supervisor} is still running.` : "Stopped.");
});

const stop = Command.make("stop", {}, () =>
  Effect.flatMap(recordedPlan, (plan) => stopInstance(plan)).pipe(userFacing)
).pipe(Command.withDescription("Stop this worktree's instance, keeping its state"));

const logs = Command.make(
  "logs",
  {},
  Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = layout(yield* recordedPlan, path).logFile;
    if (!(yield* fs.exists(file))) return yield* Console.log("(no log yet)");
    yield* Console.log(yield* fs.readFileString(file));
  }, userFacing)
).pipe(Command.withDescription("Print this worktree's dev.log"));

const reset = Command.make(
  "reset",
  { json },
  Effect.fn(function* ({ json }) {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* worktree;
    // What the environment made in Pidgeon goes first, whatever plan.json says, while the record
    // of it is still there.
    yield* takeDownPidgeon(root);
    yield* buildBroker(root);
    const stateDir = yield* stateDirOf(root);
    // Reset is the recovery path, so an unreadable plan.json is wiped, not fatal.
    const recorded = yield* readPlan(stateDir).pipe(
      Effect.catchTags({ SchemaError: () => Effect.succeed(Option.none()) })
    );
    const environment = Option.isSome(recorded) ? recorded.value.environment : undefined;
    const signIn = Option.isSome(recorded) ? signInOf(recorded.value) : "personas";
    // An environment's workspace describes the data about to be wiped, so it goes too.
    if (environment !== undefined) yield* tearDown(root);
    if (Option.isSome(recorded)) yield* stopInstance(recorded.value, Console.error);
    yield* fs.remove(stateDir, { recursive: true, force: true });
    const plan = yield* start(yield* computePlan(root, isPortFree, environment, signIn));
    if (environment === undefined) return yield* printPlan(plan, json);
    const manifest = yield* setUp(plan, yield* loadScenario(root, environment.scenario));
    if (json) return yield* Console.log(encodeManifest(manifest));
    yield* printCard(manifest, yield* layoutFor(root));
  }, userFacing)
).pipe(
  Command.withDescription("Stop, wipe .local/dev (and an environment's workspace), and start fresh")
);

const up = Command.make(
  "up",
  {
    scenario: Argument.String("scenario").pipe(
      Argument.withDescription("A folder under scenarios/; team when omitted"),
      Argument.withDefault("team")
    ),
    json
  },
  Effect.fn(function* ({ scenario, json }) {
    const root = yield* worktree;
    const loaded = yield* loadScenario(root, scenario);
    const recorded = yield* readPlan(yield* stateDirOf(root));
    if (Option.isSome(recorded)) {
      const current = recorded.value.environment;
      if (signInOf(recorded.value) === "clerk")
        return yield* new NotAnEnvironment({ worktree: root });
      // A plain personas instance becomes the environment, keeping its data.
      if (current === undefined) yield* stopInstance(recorded.value, Console.error);
      else if (current.scenario !== scenario)
        return yield* new OtherScenario({ current: current.scenario, requested: scenario });
    }
    let plan = yield* currentPlan(false, { scenario });
    if (!(yield* isRunning(plan))) {
      yield* buildBroker(plan.worktree);
      plan = yield* start(plan);
    }
    const manifest = yield* setUp(plan, loaded);
    if (json) return yield* Console.log(encodeManifest(manifest));
    yield* printCard(manifest, yield* layoutFor(root));
  }, userFacing)
).pipe(
  Command.withDescription(
    "Bring up an environment: personas instead of Clerk, a logged-in CLI, an agent workspace and the scenario's patches"
  )
);

const open = Command.make(
  "open",
  {
    person: Argument.String("person").pipe(
      Argument.withDescription("A person's key, email or first name")
    ),
    path: Flag.String("path").pipe(
      Flag.withDescription("Where to land, such as /brightline/new-business"),
      Flag.withDefault("/")
    )
  },
  Effect.fn(function* ({ person, path }) {
    const root = yield* worktree;
    const manifest = yield* readManifest(yield* layoutFor(root));
    if (Option.isNone(manifest)) return yield* new NoEnvironment({ worktree: root });
    yield* openPerson(root, manifest.value, person, path);
  }, userFacing)
).pipe(
  Command.withDescription("Open a browser window signed in as one of the environment's people")
);

const encodeShot = Schema.encodeSync(Schema.fromJsonString(Shot, { space: 2 }));

const shot = Command.make(
  "shot",
  {
    person: Argument.String("person").pipe(
      Argument.withDescription("Any email, or an environment person's key, email or first name")
    ),
    target: Argument.String("path").pipe(
      Argument.withDescription("The page to capture, such as /company or /acme/new-business"),
      Argument.withDefault("/")
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription("Where to write the PNG; .local/shots/ when omitted"),
      Flag.optional
    ),
    json
  },
  Effect.fn(function* ({ person, target, out, json }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const plan = yield* recordedPlan;
    if (signInOf(plan) === "clerk") return yield* new NeedsPersonas({ worktree: plan.worktree });
    if (!(yield* healthy(plan))) return yield* new NotHealthy({ apiUrl: plan.apiUrl });
    let email = person;
    if (!person.includes("@")) {
      const manifest = yield* readManifest(yield* layoutFor(plan.worktree));
      if (Option.isNone(manifest)) return yield* new NoEnvironment({ worktree: plan.worktree });
      email = (yield* findPerson(manifest.value, person)).email;
    }
    const slug = `${email.split("@")[0]}${target}`
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/-+$/, "");
    const file = path.resolve(
      Option.getOrElse(out, () => path.join(plan.worktree, ".local", "shots", `${slug}.png`))
    );
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const result = yield* screenshot(plan.apiUrl, email, target, file);
    if (json) return yield* Console.log(encodeShot(result));
    yield* Console.log(
      [
        `${result.status ?? "no response"}  ${result.url}`,
        `  PNG     ${result.file}`,
        ...(result.errors.length === 0
          ? ["  Errors  none"]
          : ["  Errors", ...result.errors.map((error) => `    ${error}`)])
      ].join("\n")
    );
  }, userFacing)
).pipe(
  Command.withDescription(
    "Capture a page as one person: a full-page PNG, its HTTP status and the browser's errors"
  )
);

const McpToken = Schema.Struct({
  token: Schema.String,
  connection: Schema.Struct({
    id: Schema.String,
    clientName: Schema.String,
    clientSite: Schema.String
  }),
  person: Schema.Struct({ email: Schema.String, name: Schema.String, company: Schema.String })
});
const encodeMcpToken = Schema.encodeSync(Schema.fromJsonString(McpToken, { space: 2 }));

const mcpToken = Command.make(
  "mcp-token",
  {
    person: Argument.String("person").pipe(
      Argument.withDescription("Any email, or an environment person's key, email or first name")
    ),
    client: Flag.String("client").pipe(
      Flag.withDescription("The client's name, as a consent page would show it, such as Codex")
    ),
    json
  },
  Effect.fn(function* ({ person, client, json }) {
    const plan = yield* recordedPlan;
    if (!(yield* healthy(plan))) return yield* new NotHealthy({ apiUrl: plan.apiUrl });
    let email = person;
    if (!person.includes("@")) {
      const manifest = yield* readManifest(yield* layoutFor(plan.worktree));
      if (Option.isNone(manifest)) return yield* new NoEnvironment({ worktree: plan.worktree });
      email = (yield* findPerson(manifest.value, person)).email;
    }
    // No document names a minted client, so its id is this instance's own address for it.
    const minted = yield* mintDevAgentConnection({
      email,
      clientName: client,
      clientId: `${plan.apiUrl}/dev/mcp-token`
    }).pipe(
      Effect.provide(
        AgentConnections.layer.pipe(
          Layer.provideMerge(layerFromUrl(Redacted.make(plan.databaseUrl)))
        )
      )
    );
    const result = { ...minted, person: { email, ...minted.person } };
    if (json) return yield* Console.log(encodeMcpToken(result));
    yield* Console.log(
      [
        `${result.connection.clientName} can act as ${result.person.name} at ${result.person.company}.`,
        `  Token       ${result.token}`,
        `  Connection  ${result.connection.id}`
      ].join("\n")
    );
  }, userFacing)
).pipe(
  Command.withDescription(
    "Mint an agent connection straight into this instance's database, with a year-long access token for launchers that take a pasted token"
  )
);

// ---- Evidence for a PR ------------------------------------------------------

class InvalidWidths extends Schema.TaggedError<InvalidWidths>()("InvalidWidths", {
  given: Schema.String
}) {
  override get message() {
    return `--width takes widths in pixels, comma-separated, such as 1280,390; got "${this.given}".`;
  }
}

class FlowBrokeAfter extends Schema.TaggedError<FlowBrokeAfter>()("FlowBrokeAfter", {
  step: Schema.String,
  reason: Schema.String,
  video: Schema.String
}) {
  override get message() {
    return `The flow failed on this branch${this.step === "" ? "" : ` at "${this.step}"`}: ${this.reason}. Its video is ${this.video}; nothing was published.`;
  }
}

const baseFlag = Flag.String("base").pipe(
  Flag.withDescription(
    "What before is: any git ref; where HEAD left origin/main, or the PR's base branch, when omitted"
  ),
  Flag.optional
);

const scenarioFlag = Flag.String("scenario").pipe(
  Flag.withDescription("The scenario both sides run; this environment's, or team, when omitted"),
  Flag.optional
);

const prFlag = Flag.Int("pr").pipe(
  Flag.withDescription(
    "Put the section in this PR's body and upload its files; the PR's head must be HEAD"
  ),
  Flag.optional
);

const evidencePerson = Argument.String("person").pipe(
  Argument.withDescription("A scenario person's key, email or first name, on both sides")
);

/**
 * What an evidence command settles before any instance starts: with `--pr`,
 * that gh can attach files and the PR's head is HEAD; the two commits, and
 * whether the working tree holds changes they don't (refused with `--pr`);
 * the scenario; and a fresh run folder under `.local/shots/`.
 */
const prepareRun = Effect.fn("prepareRun")(function* (input: {
  readonly root: string;
  readonly command: string;
  readonly key: string;
  readonly base: Option.Option<string>;
  readonly scenario: Option.Option<string>;
  readonly pr: Option.Option<number>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = Option.isSome(input.pr)
    ? Option.some(yield* checkPr(input.root, input.pr.value))
    : Option.none();
  const commits = yield* resolveCommits(input.root, {
    base: input.base,
    baseBranch: Option.map(target, (pr) => pr.baseRefName)
  });
  if (commits.dirty) {
    if (Option.isSome(target)) return yield* new UncommittedChanges();
    yield* Console.error(
      `Uncommitted changes aren't included: the evidence is of ${commits.after.sha.slice(0, 7)}.`
    );
  }
  const scenario = yield* scenarioFor(input.root, input.scenario);
  const stamp = DateTime.formatIso(yield* DateTime.now)
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "");
  const runDir = `.local/shots/${input.command}-${input.key}-${stamp}`;
  yield* fs.makeDirectory(path.join(input.root, runDir), { recursive: true });
  return { target, commits, scenario, runDir };
});

/**
 * The person on both sides. "After" must have them; a "before" whose
 * scenario lacks them becomes unavailable, and the evidence shows after only.
 */
const personOnBothSides = Effect.fn("personOnBothSides")(function* (
  before: Before,
  after: Served,
  query: string
) {
  const person = yield* findPerson(after, query);
  if (before.status !== "served") return { person, before, beforeEmail: person.email };
  const there = yield* findPerson(before.side.served, query).pipe(Effect.option);
  if (Option.isSome(there)) return { person, before, beforeEmail: there.value.email };
  const unavailable: Before = {
    status: "unavailable",
    commit: before.side.commit,
    reason: `Its scenario has no one matching "${query}".`
  };
  return { person, before: unavailable, beforeEmail: person.email };
});

const SideReport = Schema.Struct({
  status: Schema.Literals(["served", "unavailable", "skipped"]),
  sha: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  apiUrl: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String)
});

const sideReport = (before: Before): typeof SideReport.Type =>
  before.status === "served"
    ? {
        status: "served",
        sha: before.side.commit.sha,
        label: before.side.commit.label,
        apiUrl: before.side.served.apiUrl,
        reason: null
      }
    : before.status === "unavailable"
      ? {
          status: "unavailable",
          sha: before.commit.sha,
          label: before.commit.label,
          apiUrl: null,
          reason: before.reason
        }
      : { status: "skipped", sha: null, label: null, apiUrl: null, reason: null };

/** What `--json` prints for every evidence command: the commits, the section and where it went. */
const Report = Schema.Struct({
  key: Schema.String,
  scenario: Schema.String,
  before: SideReport,
  after: Schema.Struct({ sha: Schema.String, label: Schema.String, apiUrl: Schema.String }),
  /** The section with its markers, as it goes in the PR body. */
  section: Schema.String,
  /** The local files the section references, relative to the worktree root. */
  files: Schema.Array(Schema.String),
  /** Without `--pr`: where the section was written, and the gh line that publishes it. */
  sectionFile: Schema.NullOr(Schema.String),
  gh: Schema.NullOr(Schema.String),
  /** With `--pr`: the PR, and files that did not upload. */
  published: Schema.NullOr(
    Schema.Struct({ url: Schema.String, attached: Schema.Int, failed: Schema.Array(Schema.String) })
  )
});

const encodeCompareReport = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      command: Schema.Literal("compare"),
      ...Report.fields,
      person: Person,
      captures: Schema.Array(Capture)
    }),
    { space: 2 }
  )
);
const encodeFilmReport = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      command: Schema.Literal("film"),
      ...Report.fields,
      person: Person,
      takes: Schema.Array(Take)
    }),
    { space: 2 }
  )
);

/**
 * With `--pr`, puts the section in the PR body and uploads its files;
 * otherwise writes it beside them with the gh line that would. Either way the
 * local files stay.
 */
const deliver = Effect.fn("deliver")(function* (input: {
  readonly root: string;
  readonly target: Option.Option<PrTarget>;
  readonly command: string;
  readonly key: string;
  readonly markdown: string;
  readonly files: ReadonlyArray<string>;
  readonly runDir: string;
}) {
  const section = keyedSection(input.command, input.key, input.markdown);
  const files = input.files;
  if (Option.isSome(input.target)) {
    const published = yield* publishSection({ ...input, pr: input.target.value });
    return {
      section,
      files,
      sectionFile: null,
      gh: null,
      published: { url: published.url, attached: published.attached, failed: published.failed }
    };
  }
  const draft = yield* draftSection(input);
  return {
    section,
    files,
    sectionFile: draft.file,
    gh: draft.gh,
    published: null
  };
});

/** The human ending: the section, then where it went or the gh line that sends it. */
const printDelivery = Effect.fn("printDelivery")(function* (
  root: string,
  delivered: Effect.Success<ReturnType<typeof deliver>>
) {
  yield* Console.log(["", delivered.section, ""].join("\n"));
  if (delivered.published === null)
    return yield* Console.log(
      [
        `Wrote ${delivered.sectionFile}. Put it in the PR body, then from ${root}:`,
        `  ${delivered.gh}`,
        "Or run again with --pr <number> to do both."
      ].join("\n")
    );
  yield* Console.log(
    `Published to ${delivered.published.url}, ${delivered.published.attached} file(s) attached.`
  );
});

/** A partial publication is printed first, then exits 1. */
const failPartial = (delivered: Effect.Success<ReturnType<typeof deliver>>) =>
  delivered.published !== null && delivered.published.failed.length > 0
    ? Effect.fail(
        new PartialPublication({ url: delivered.published.url, failed: delivered.published.failed })
      )
    : Effect.void;

const compare = Command.make(
  "compare",
  {
    person: evidencePerson,
    targets: Argument.String("path").pipe(
      Argument.withDescription("Pages to capture, such as / or /acme/new-business"),
      Argument.atLeast(1)
    ),
    width: Flag.String("width").pipe(
      Flag.withDescription("Viewport widths in pixels, comma-separated"),
      Flag.withDefault("1280,390")
    ),
    base: baseFlag,
    scenario: scenarioFlag,
    pr: prFlag,
    key: Flag.String("key").pipe(
      Flag.withDescription("Names this section in the PR body; the person when omitted"),
      Flag.optional
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the commits, files, statuses and section as JSON"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({ person: query, targets, width, base, scenario, pr, key, json }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* worktree;
    const widths = width.split(",").map((w) => Number(w.trim()));
    if (widths.some((w) => !Number.isInteger(w) || w < 200 || w > 3840))
      return yield* new InvalidWidths({ given: width });
    // Both sides of every page at every width, before anything starts.
    const most = targets.length * widths.length * 2;
    if (most > MAX_ATTACHMENTS && Option.isSome(pr))
      return yield* new TooManyAttachments({ count: most });
    yield* checkChromium();
    const sectionName = sectionKey(Option.getOrElse(key, () => query));
    const run = yield* prepareRun({
      root,
      command: "compare",
      key: sectionName,
      base,
      scenario,
      pr
    });
    const captured = yield* Effect.scoped(
      Effect.gen(function* () {
        const sides = yield* evidence({
          root,
          command: "compare",
          scenario: run.scenario,
          before: Option.some(run.commits.before),
          after: run.commits.after,
          runDir: path.join(root, run.runDir)
        });
        const { person, before, beforeEmail } = yield* personOnBothSides(
          sides.before,
          sides.after.served,
          query
        );
        yield* Console.error(
          `Capturing ${targets.length} page(s) at ${widths.join(", ")}px as ${person.name}`
        );
        const shoot = (side: "before" | "after", apiUrl: string, email: string) =>
          shootAll({ root, sides: [{ side, apiUrl }], email, targets, widths, runDir: run.runDir });
        const captures = [
          ...(before.status === "served"
            ? yield* shoot("before", before.side.served.apiUrl, beforeEmail)
            : []),
          ...(yield* shoot("after", sides.after.served.apiUrl, person.email))
        ];
        return { person, before, after: sides.after, captures };
      })
    );
    const at = (side: "before" | "after", target: string, w: number) =>
      captured.captures.find(
        (capture) => capture.side === side && capture.target === target && capture.width === w
      );
    const pairs: Array<Pair> = [];
    for (const target of targets)
      for (const w of widths) {
        const after = at("after", target, w)!;
        const before = at("before", target, w);
        const identical =
          before !== undefined &&
          Buffer.from(yield* fs.readFile(path.join(root, before.file))).equals(
            yield* fs.readFile(path.join(root, after.file))
          );
        pairs.push({ target, width: w, before, after, identical });
      }
    const { markdown, files } = compareMarkdown({
      provenance: {
        command: "compare",
        scenario: run.scenario,
        before: captured.before,
        after: run.commits.after
      },
      person: captured.person,
      pairs
    });
    const delivered = yield* deliver({
      root,
      target: run.target,
      command: "compare",
      key: sectionName,
      markdown,
      files,
      runDir: run.runDir
    });
    if (json)
      yield* Console.log(
        encodeCompareReport({
          command: "compare",
          key: sectionName,
          scenario: run.scenario,
          person: captured.person,
          before: sideReport(captured.before),
          after: { ...run.commits.after, apiUrl: captured.after.served.apiUrl },
          captures: captured.captures,
          ...delivered
        })
      );
    else {
      yield* Console.log(
        captured.captures
          .map(
            (capture) =>
              `${capture.side.padEnd(6)}  ${String(capture.width).padStart(4)}px  ${capture.status ?? "---"}  ${capture.target}  ${capture.errors.length === 0 ? "no errors" : `${capture.errors.length} error(s)`}${capture.clipped === null ? "" : `  (${capture.clipped})`}`
          )
          .join("\n")
      );
      yield* printDelivery(root, delivered);
    }
    yield* failPartial(delivered);
  }, userFacing)
).pipe(
  Command.withDescription(
    "Screenshot pages before and after, as one person, on throwaway instances at both commits, and lay them out for the PR"
  )
);

const film = Command.make(
  "film",
  {
    person: evidencePerson,
    flow: Argument.String("flow").pipe(
      Argument.withDescription(
        "A module whose default export drives the page: async ({ page, step }) => {}"
      )
    ),
    start: Flag.String("path").pipe(
      Flag.withDescription("Where the flow starts, signed in"),
      Flag.withDefault("/")
    ),
    width: Flag.Int("width").pipe(
      Flag.withDescription("Viewport width in pixels"),
      Flag.withDefault(1280)
    ),
    afterOnly: Flag.Boolean("after-only").pipe(
      Flag.withDescription("Film this branch only"),
      Flag.withDefault(false)
    ),
    base: baseFlag,
    scenario: scenarioFlag,
    pr: prFlag,
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the commits, takes, files and section as JSON"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({
    person: query,
    flow: flowArg,
    start,
    width,
    afterOnly,
    base,
    scenario,
    pr,
    json
  }) {
    const path = yield* Path.Path;
    const root = yield* worktree;
    if (!Number.isInteger(width) || width < 200 || width > 3840)
      return yield* new InvalidWidths({ given: String(width) });
    yield* checkChromium();
    yield* checkFfmpeg(root);
    const flowFile = path.resolve(flowArg);
    const flow = yield* loadFlow(flowFile);
    const name = path.basename(flowFile).replace(/\.[^.]+$/, "");
    const sectionName = sectionKey(name);
    const run = yield* prepareRun({ root, command: "film", key: sectionName, base, scenario, pr });
    const filmed = yield* Effect.scoped(
      Effect.gen(function* () {
        const sides = yield* evidence({
          root,
          command: "film",
          scenario: run.scenario,
          before: afterOnly ? Option.none<Commit>() : Option.some(run.commits.before),
          after: run.commits.after,
          runDir: path.join(root, run.runDir)
        });
        const { person, before, beforeEmail } = yield* personOnBothSides(
          sides.before,
          sides.after.served,
          query
        );
        const take = (side: "before" | "after", apiUrl: string, email: string, label: string) =>
          filmSide({ root, side, apiUrl, email, start, flow, width, label, runDir: run.runDir });
        yield* Console.error(`Filming ${name} as ${person.name}`);
        const takes: Array<Take> = [];
        if (before.status === "served")
          takes.push(
            yield* take(
              "before",
              before.side.served.apiUrl,
              beforeEmail,
              `Before: ${before.side.commit.sha.slice(0, 7)}`
            )
          );
        takes.push(
          yield* take(
            "after",
            sides.after.served.apiUrl,
            person.email,
            `After: ${run.commits.after.sha.slice(0, 7)}`
          )
        );
        return { person, before, after: sides.after, takes };
      })
    );
    const after = filmed.takes.at(-1)!;
    const video =
      filmed.takes.length === 2
        ? yield* sideBySide(root, filmed.takes[0]!, after, `${run.runDir}/side-by-side.mp4`)
        : after.file;
    const { markdown, files } = filmMarkdown({
      name,
      person: filmed.person,
      provenance: provenanceLines({
        command: "film",
        scenario: run.scenario,
        before: filmed.before,
        after: run.commits.after
      }),
      takes: filmed.takes,
      video
    });
    // A flow broken on this branch keeps its footage locally and publishes nothing.
    const broken = after.failure;
    const delivered = yield* deliver({
      root,
      target: broken === null ? run.target : Option.none(),
      command: "film",
      key: sectionName,
      markdown,
      files,
      runDir: run.runDir
    });
    if (json)
      yield* Console.log(
        encodeFilmReport({
          command: "film",
          key: sectionName,
          scenario: run.scenario,
          person: filmed.person,
          before: sideReport(filmed.before),
          after: { ...run.commits.after, apiUrl: filmed.after.served.apiUrl },
          takes: filmed.takes,
          ...delivered
        })
      );
    else if (broken === null) yield* printDelivery(root, delivered);
    else yield* Console.log(["", delivered.section, ""].join("\n"));
    if (broken !== null)
      return yield* new FlowBrokeAfter({ step: broken.step, reason: broken.message, video });
    yield* failPartial(delivered);
  }, userFacing)
).pipe(
  Command.withDescription(
    "Record a Playwright flow before and after, as one person, on throwaway instances at both commits, as captioned mp4s for the PR"
  )
);

class InvalidTimeout extends Schema.TaggedError<InvalidTimeout>()("InvalidTimeout", {
  given: Schema.Number
}) {
  override get message() {
    return `--timeout takes whole seconds from 1 to 3600; got ${this.given}.`;
  }
}

class LineTimedOut extends Schema.TaggedError<LineTimedOut>()("LineTimedOut", {
  line: Schema.Int,
  timeout: Schema.Int
}) {
  override get message() {
    return `Line ${this.line} of the script timed out after ${this.timeout} s on this branch, so nothing was published; the section is above. Fix the line or raise --timeout.`;
  }
}

/** Encoded, not yet a string: the sanitizer redacts its strings first, so the JSON stays valid. */
const encodeTranscriptReport = Schema.encodeSync(
  Schema.Struct({
    command: Schema.Literal("transcript"),
    ...Report.fields,
    /** Each line of the script, redacted and normalized as the section shows it. */
    lines: Schema.Array(
      Schema.Struct({
        line: Schema.Int,
        caption: Schema.NullOr(Schema.String),
        command: Schema.String,
        before: Schema.NullOr(Run),
        after: Run
      })
    ),
    /** The sources a secret was redacted from. */
    redacted: Schema.Array(Schema.Literals(SECRET_SOURCES))
  })
);
const printJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const transcript = Command.make(
  "transcript",
  {
    script: Argument.String("script").pipe(
      Argument.withDescription(
        "A text file: each non-blank line is a command; a # line captions the commands after it"
      )
    ),
    timeout: Flag.Int("timeout").pipe(
      Flag.withDescription("Seconds a line may run before it is killed"),
      Flag.withDefault(60)
    ),
    base: baseFlag,
    scenario: scenarioFlag,
    pr: prFlag,
    json: Flag.Boolean("json").pipe(
      Flag.withDescription(
        "Print the commits, each line's exit code, output and time, and the section as JSON"
      ),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({ script, timeout, base, scenario, pr, json }) {
    const path = yield* Path.Path;
    const root = yield* worktree;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
      return yield* new InvalidTimeout({ given: timeout });
    const file = path.resolve(script);
    const lines = yield* loadScript(file);
    const name = path.basename(file).replace(/\.[^.]+$/, "");
    const sectionName = sectionKey(name);
    const run = yield* prepareRun({
      root,
      command: "transcript",
      key: sectionName,
      base,
      scenario,
      pr
    });
    const ran = yield* Effect.scoped(
      Effect.gen(function* () {
        const sides = yield* evidence({
          root,
          command: "transcript",
          scenario: run.scenario,
          before: Option.some(run.commits.before),
          after: run.commits.after,
          runDir: path.join(root, run.runDir)
        });
        const afterShell = yield* sideShell(root, sides.after);
        let before = sides.before;
        let beforeShell: SideShell | null = null;
        if (before.status === "served") {
          const found = yield* Effect.option(sideShell(root, before.side));
          if (Option.isSome(found)) beforeShell = found.value;
          else
            before = {
              status: "unavailable",
              commit: before.side.commit,
              reason: "Its environment isn't where this checkout looks for it."
            };
        }
        const shells = beforeShell === null ? [afterShell] : [beforeShell, afterShell];
        // Both sides' state is read before either runs, and again after every line.
        const sanitizer = yield* makeSanitizer({
          stateDirs: shells.map((shell) => shell.state),
          envs: shells.map((shell) => shell.env)
        });
        const limit = Duration.seconds(timeout);
        yield* Console.error(`Running ${lines.length} line(s) on each side`);
        const beforeRuns =
          beforeShell === null
            ? null
            : {
                shell: beforeShell,
                runs: yield* runScript({ shell: beforeShell, lines, timeout: limit, sanitizer })
              };
        const afterRuns = yield* runScript({ shell: afterShell, lines, timeout: limit, sanitizer });
        return {
          before,
          after: sides.after,
          beforeRuns,
          afterShell,
          afterRuns,
          sanitizer
        };
      })
    );
    const { sanitizer } = ran;
    // Secrets go first, while each is still whole; then each side's origin and paths.
    const clean = Effect.fn(function* (result: Run, shell: SideShell) {
      return {
        ...result,
        stdout: normalize(yield* sanitizer.redact(result.stdout), shell.placeholders),
        stderr: normalize(yield* sanitizer.redact(result.stderr), shell.placeholders)
      } satisfies Run;
    });
    const compared: Array<Compared & { readonly line: number }> = [];
    for (const [index, line] of lines.entries())
      compared.push({
        line: line.line,
        caption: line.caption === null ? null : yield* sanitizer.redact(line.caption),
        command: yield* sanitizer.redact(line.command),
        before:
          ran.beforeRuns === null
            ? null
            : yield* clean(ran.beforeRuns.runs[index]!, ran.beforeRuns.shell),
        after: yield* clean(ran.afterRuns[index]!, ran.afterShell)
      });
    const markdown = yield* sanitizer.redact(
      transcriptMarkdown({
        name,
        provenance: provenanceLines({
          command: "transcript",
          scenario: run.scenario,
          before: ran.before,
          after: run.commits.after
        }),
        redaction: redactionLine(yield* sanitizer.matched),
        lines: compared
      })
    );
    // A line that timed out on this branch keeps the section local and publishes nothing.
    const timedOut = compared.find((line) => line.after.timedOut);
    const delivered = yield* deliver({
      root,
      target: timedOut === undefined ? run.target : Option.none(),
      command: "transcript",
      key: sectionName,
      markdown,
      files: [],
      runDir: run.runDir
    });
    if (json)
      yield* Console.log(
        printJson(
          yield* sanitizer.redactJson(
            encodeTranscriptReport({
              command: "transcript",
              key: sectionName,
              scenario: run.scenario,
              before: sideReport(ran.before),
              after: { ...run.commits.after, apiUrl: ran.after.served.apiUrl },
              lines: compared,
              redacted: yield* sanitizer.matched,
              ...delivered
            })
          )
        )
      );
    else if (timedOut === undefined) yield* printDelivery(root, delivered);
    else yield* Console.log(["", delivered.section, ""].join("\n"));
    if (timedOut !== undefined) return yield* new LineTimedOut({ line: timedOut.line, timeout });
    yield* failPartial(delivered);
  }, userFacing)
).pipe(
  Command.withDescription(
    "Run a script of CLI lines before and after, as the scenario's signed-in CLI, on throwaway instances at both commits, and compare them for the PR"
  )
);

class InvalidBudget extends Schema.TaggedError<InvalidBudget>()("InvalidBudget", {
  flag: Schema.String,
  given: Schema.Number,
  max: Schema.Int
}) {
  override get message() {
    return `--${this.flag} takes a whole number from 1 to ${this.max}; got ${this.given}.`;
  }
}

class AgentGaveNoResult extends Schema.TaggedError<AgentGaveNoResult>()("AgentGaveNoResult", {
  detail: Schema.String
}) {
  override get message() {
    return `The agent on this branch never really tried the task (${this.detail}), so nothing was published; the section is above.`;
  }
}

/** Encoded, not yet a string: the sanitizer redacts its strings first, so the JSON stays valid. */
const encodeTrialReport = Schema.encodeSync(
  Schema.Struct({
    command: Schema.Literal("trial"),
    ...Report.fields,
    task: Schema.String,
    /** What was asked for with `--model`; each attempt names the model Claude Code ran. */
    model: Schema.String,
    budget: Schema.Struct({ maxTurns: Schema.Int, minutes: Schema.Int }),
    /** Each side's filtered log, redacted and normalized as the section shows it. */
    attempts: Schema.Struct({ before: Schema.NullOr(Attempt), after: Attempt }),
    /** The sources a secret was redacted from. */
    redacted: Schema.Array(Schema.Literals(SECRET_SOURCES))
  })
);

const trial = Command.make(
  "trial",
  {
    task: Argument.String("task").pipe(
      Argument.withDescription(
        'What the agent is asked to do, as a person would ask, such as "show me the last few log lines of new-business"'
      )
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription("The model both sides' agents run, passed to Claude Code"),
      Flag.withDefault("sonnet")
    ),
    maxTurns: Flag.Int("max-turns").pipe(
      Flag.withDescription("Turns each side's agent may take"),
      Flag.withDefault(30)
    ),
    minutes: Flag.Int("minutes").pipe(
      Flag.withDescription("Minutes each side's agent may run before it is stopped"),
      Flag.withDefault(10)
    ),
    key: Flag.String("key").pipe(
      Flag.withDescription(
        "Names this section in the PR body; the task's first words when omitted"
      ),
      Flag.optional
    ),
    base: baseFlag,
    scenario: scenarioFlag,
    pr: prFlag,
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the commits, each side's filtered log and the section as JSON"),
      Flag.withDefault(false)
    )
  },
  Effect.fn(function* ({ task, model, maxTurns, minutes, key, base, scenario, pr, json }) {
    const path = yield* Path.Path;
    const root = yield* worktree;
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200)
      return yield* new InvalidBudget({ flag: "max-turns", given: maxTurns, max: 200 });
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)
      return yield* new InvalidBudget({ flag: "minutes", given: minutes, max: 60 });
    const refused = taskRefusal(task);
    if (refused !== null) return yield* new TaskRefused({ what: refused });
    yield* checkClaude(root);
    // The run folder has a fixed name: the section's key is only known once the task is redacted.
    const run = yield* prepareRun({ root, command: "trial", key: "task", base, scenario, pr });
    const budget = { maxTurns, minutes };
    const tried = yield* Effect.scoped(
      Effect.gen(function* () {
        const sides = yield* evidence({
          root,
          command: "trial",
          scenario: run.scenario,
          before: Option.some(run.commits.before),
          after: run.commits.after,
          runDir: path.join(root, run.runDir)
        });
        const afterShell = yield* agentShell(root, sides.after);
        let before = sides.before;
        let beforeShell: AgentShell | null = null;
        if (before.status === "served") {
          // A string is why before's agent can't run.
          const found = yield* agentShell(root, before.side).pipe(
            Effect.catchTags({
              NoWorkspace: () =>
                Effect.succeed("Its environment isn't where this checkout looks for it.")
            })
          );
          if (typeof found === "string")
            before = { status: "unavailable", commit: before.side.commit, reason: found };
          else beforeShell = found;
        }
        const shells = beforeShell === null ? [afterShell] : [beforeShell, afterShell];
        // Both sides' state is read before either agent starts, every 100ms while
        // they run, and after each tool call either one makes.
        const sanitizer = yield* makeSanitizer({
          stateDirs: shells.map((shell) => shell.state),
          envs: shells.map((shell) => shell.env),
          // Both sides' agents sign in the same way, so after's environment speaks for both.
          identities: yield* identities(afterShell)
        });
        yield* Console.error(
          `Giving the task to ${shells.length === 2 ? "each side's agent" : "after's agent"} on ${model}, within ${maxTurns} turns and ${minutes} min`
        );
        const attempt = (shell: AgentShell) =>
          runAgent({ shell, task, model, maxTurns, timeout: Duration.minutes(minutes), sanitizer });
        const [beforeAttempt, afterAttempt] = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(
              Effect.ignore(sanitizer.collect).pipe(Effect.repeat(Schedule.spaced("100 millis")))
            );
            return yield* Effect.all(
              [
                beforeShell === null ? Effect.succeed(null) : attempt(beforeShell),
                attempt(afterShell)
              ],
              { concurrency: "unbounded" }
            );
          })
        );
        return {
          before,
          after: sides.after,
          beforeShell,
          afterShell,
          beforeAttempt,
          afterAttempt,
          sanitizer
        };
      })
    );
    const { sanitizer } = tried;
    const sectionName = yield* trialKey(task, key, sanitizer);
    const beforeAttempt =
      tried.beforeAttempt === null || tried.beforeShell === null
        ? null
        : yield* cleanAttempt(tried.beforeAttempt, sanitizer, tried.beforeShell.placeholders);
    const afterAttempt = yield* cleanAttempt(
      tried.afterAttempt,
      sanitizer,
      tried.afterShell.placeholders
    );
    const markdown = yield* sanitizer.redact(
      trialMarkdown({
        name: sectionName,
        task: yield* sanitizer.redact(task),
        provenance: provenanceLines({
          command: "trial",
          scenario: run.scenario,
          before: tried.before,
          after: run.commits.after
        }),
        redaction: redactionLine(yield* sanitizer.matched),
        model: afterAttempt.model ?? model,
        budget,
        before: beforeAttempt,
        after: afterAttempt
      })
    );
    // An agent on this branch that errored or gave no result never tried the task: nothing is published.
    const broken = afterAttempt.ending === "failed" || afterAttempt.ending === "no-answer";
    const delivered = yield* deliver({
      root,
      target: broken ? Option.none() : run.target,
      command: "trial",
      key: sectionName,
      markdown,
      files: [],
      runDir: run.runDir
    });
    if (json)
      yield* Console.log(
        printJson(
          yield* sanitizer.redactJson(
            encodeTrialReport({
              command: "trial",
              key: sectionName,
              scenario: run.scenario,
              before: sideReport(tried.before),
              after: { ...run.commits.after, apiUrl: tried.after.served.apiUrl },
              task,
              model,
              budget,
              attempts: { before: beforeAttempt, after: afterAttempt },
              redacted: yield* sanitizer.matched,
              ...delivered
            })
          )
        )
      );
    else if (!broken) yield* printDelivery(root, delivered);
    else yield* Console.log(["", delivered.section, ""].join("\n"));
    const costs = [beforeAttempt, afterAttempt].flatMap((attempt, index) =>
      attempt?.costUsd == null
        ? []
        : [`$${attempt.costUsd.toFixed(2)} ${index === 0 ? "before" : "after"}`]
    );
    if (costs.length > 0)
      yield* Console.error(`Claude Code put the runs at ${costs.join(" and ")}, at API prices.`);
    if (broken)
      return yield* new AgentGaveNoResult({ detail: afterAttempt.detail ?? afterAttempt.ending });
    yield* failPartial(delivered);
  }, userFacing)
).pipe(
  Command.withDescription(
    "Give a task to a fresh agent before and after, as the scenario's publisher, on throwaway instances at both commits, and show how each attempt went for the PR"
  )
);

/**
 * Takes down the Pidgeon test addresses the worktree's environment recorded, and their keys, before
 * the environment folder that records them goes; fails, removing nothing, when it can't.
 */
const takeDownPidgeon = Effect.fn("takeDownPidgeon")(function* (root: string) {
  const home = yield* Config.String("HOME");
  yield* takeDownRecorded((yield* layoutFor(root)).pidgeon, yield* developerEnvFile(home));
});

const down = Command.make(
  "down",
  {},
  Effect.fn(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* worktree;
    const stateDir = yield* stateDirOf(root);
    const recorded = yield* readPlan(stateDir).pipe(
      Effect.catchTags({ SchemaError: () => Effect.succeed(Option.none()) })
    );
    // What the environment made in Pidgeon goes before the folder that records it.
    yield* takeDownPidgeon(root);
    const evidenceRemoved = yield* removeEvidence(root);
    const environmentRemoved = yield* tearDown(root);
    if (Option.isSome(recorded)) yield* stopInstance(recorded.value);
    const instanceRemoved = yield* fs.exists(stateDir);
    yield* fs.remove(stateDir, { recursive: true, force: true });
    yield* Console.log(
      environmentRemoved || instanceRemoved || evidenceRemoved
        ? `Removed ${[instanceRemoved ? stateDir : "", environmentRemoved ? (yield* layoutFor(root)).dir : "", evidenceRemoved ? "the evidence checkouts" : ""].filter(Boolean).join(" and ")}. Close any agent sessions you started in the workspace.`
        : "Nothing to take down."
    );
  }, userFacing)
).pipe(
  Command.withDescription(
    "Stop everything this worktree's instance or environment started and delete what it made"
  )
);

/**
 * The detached process `start` spawns. Reads the plan `start` wrote. The
 * supervisor loads only here: embedded-postgres hooks Ctrl-C to exit the
 * process at once, which would skip every other command's finalizers.
 */
const superviseCommand = Command.make("supervise", {}, () =>
  Effect.promise(() => import("./supervisor.js")).pipe(
    Effect.flatMap(({ supervise }) => Effect.flatMap(recordedPlan, supervise)),
    Effect.scoped,
    userFacing
  )
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
  Command.withSubcommands([
    status,
    stop,
    logs,
    reset,
    up,
    open,
    shot,
    mcpToken,
    compare,
    film,
    transcript,
    trial,
    down,
    superviseCommand
  ]),
  Command.run({ version: "0.0.0" }),
  Effect.scoped,
  Effect.provide([NodeServices.layer, NodeCryptography.layer, FetchHttpClient.layer, CliSurface]),
  NodeRuntime.runMain
);
