/**
 * `pnpm dev eval`: a suite of tasks, each given to each builder a number of
 * times on each side, the base commit and `HEAD` (or `HEAD` alone), each side
 * an evidence instance whose personas door only the grader can open. Per run: its own company and people, a copy of the side's template
 * HOME, the builder in its sandbox within the task's minutes, grading, and its
 * people retired. A run whose setup or model provider failed is retried once.
 *
 * Everything lands in `.local/evals/<suite>/`: per run the raw stream, the
 * builder's HOME (its working folder and the published source), screenshots
 * and `run.json`; then `scorecard.json` and `scorecard.md`. Raw streams and
 * homes stay on this machine; the scorecard is redacted.
 */
import * as Console from "effect/Console";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import type * as SqlClient from "effect/sql/SqlClient";
import { evidence, type Commit, type Side } from "../evidence.js";
import { realNode } from "../runtimes.js";
import { makeSanitizer } from "../sanitize.js";
import { loadScenario, type Scenario } from "../scenario.js";
import { type Builder, BUILDERS, type BuilderId, runBuilder, type Step } from "./builders.js";
import { retireRun, seedRun, sideDatabase, sideSql } from "./fixtures.js";
import { checkBrowser, grade } from "./grade.js";
import {
  fileSecrets,
  prepareHome,
  prepareTemplate,
  readSignIns,
  type SignIns,
  type ToolVersion
} from "./home.js";
import { metricsOf } from "./metrics.js";
import { type Network, openNetwork } from "./network.js";
import { checkSandbox, readToolchain, type Toolchain } from "./sandbox.js";
import { classify, RunRecord, Scorecard, scorecardMarkdown, scorecardRun } from "./scorecard.js";
import { type Task, taskPrompt } from "./task.js";

const encodeRecord = Schema.encodeSync(Schema.fromJsonString(RunRecord, { space: 2 }));
const encodeScorecard = Schema.encodeSync(Scorecard);
const printJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const randomId = (length: number) =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]
  ).join("");

/** The scenario every side comes up on; each run seeds its own task's scenario beside it. */
const SIDE_SCENARIO = "team";

interface Suite {
  readonly root: string;
  readonly dir: string;
  readonly doorKey: string;
  readonly signIns: SignIns;
  /** Secrets read from runs' own credential files after they ended, refreshed tokens included. */
  readonly seen: Ref.Ref<ReadonlyArray<string>>;
}

/** One side of the comparison, up for the suite: its instance and what its runs start from. */
interface SideContext {
  readonly name: "base" | "head";
  readonly commit: Commit;
  readonly apiUrl: string;
  /** The side's database, where runs are seeded and retired. */
  readonly database: Context.Context<SqlClient.SqlClient>;
  /** The side's template HOME: its release's CLI and global skill. */
  readonly template: string;
  readonly network: Network;
}

interface Planned {
  readonly task: Task;
  readonly builder: Builder;
  readonly repeat: number;
  readonly side: SideContext;
}

const short = (text: string, max = 110) => {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

const progress = (label: string, step: Step) =>
  Console.error(
    `  ${label.padEnd(24)}  ${(step.tool === "Bash" ? (step.exitCode === null ? step.outcome : `exit ${step.exitCode}`) : step.tool.toLowerCase()).padEnd(7)}  ${short(step.input)}`
  );

/** One run, start to finish. Setup failures come back as an `infra` record, never as an error. */
const runOne = Effect.fn("Eval.runOne")(function* (
  suite: Suite,
  planned: Planned,
  attempt: number
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { task, builder, repeat, side } = planned;
  const run = randomId(6);
  const label = `${side.name}:${task.id}/${builder.id}/${repeat}${attempt > 1 ? "+" : ""}`;
  const runDir = path.join(
    suite.dir,
    "runs",
    `${side.name}-${task.id}-${builder.id}-${repeat}${attempt > 1 ? `-retry` : ""}`
  );
  yield* fs.makeDirectory(runDir, { recursive: true });
  const home = path.join(runDir, "home");
  const base = {
    run,
    task: task.id,
    builder: builder.id,
    model: builder.model,
    effort: builder.effort,
    repeat,
    side: side.name,
    commit: side.commit.sha
  };
  const { scenario } = yield* loadScenario(suite.root, task.scenario);
  const setUp = yield* Effect.gen(function* () {
    const identities = yield* seedRun(scenario, run).pipe(Effect.provideContext(side.database));
    const spec = yield* prepareHome({
      template: side.template,
      home,
      apiUrl: side.apiUrl,
      network: side.network,
      token: identities.token,
      builder,
      signIns: suite.signIns
    });
    return { identities, spec };
  }).pipe(Effect.result);
  if (setUp._tag === "Failure") {
    yield* Console.error(`  ${label.padEnd(24)}  setup failed: ${setUp.failure.message}`);
    return {
      ...base,
      outcome: "infra",
      pass: false,
      detail: `Setup failed: ${setUp.failure.message}`,
      target: null,
      checks: [],
      metrics: null,
      log: null,
      source: null,
      screenshots: []
    } satisfies RunRecord;
  }
  const { identities, spec } = setUp.success;
  // The run's own credential files, read after every tool call and at the end, as the trial
  // reads CLI state: a token a harness refreshes, logs and replaces is still redacted.
  const collect = Effect.gen(function* () {
    const found = [
      ...(yield* fileSecrets(path.join(home, ".codex", "auth.json"))),
      ...(yield* fileSecrets(path.join(home, ".patchy", "credentials.json")))
    ];
    if (found.length > 0) yield* Ref.update(suite.seen, (known) => [...known, ...found]);
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  yield* Console.error(`  ${label.padEnd(24)}  building as ${identities.publisher.email}`);
  const stream = yield* fs.open(path.join(runDir, "stream.jsonl"), { flag: "w" });
  const encoder = new TextEncoder();
  const log = yield* runBuilder({
    builder,
    spec,
    task: taskPrompt(task),
    timeout: Duration.minutes(task.minutes),
    record: (line) => Effect.ignore(stream.writeAll(encoder.encode(`${line}\n`))),
    onStep: (step) => collect.pipe(Effect.andThen(progress(label, step)))
  });
  const grading = grade({
    task,
    spec,
    runDir,
    people: identities.people,
    publisher: identities.publisher,
    door: { apiUrl: side.apiUrl, key: suite.doorKey }
  });
  // The grader's own trouble gets one more try before the run counts as infrastructure.
  const first = yield* grading;
  const graded = first.infra === null ? first : yield* grading;
  yield* Effect.ignore(retireRun(scenario, run).pipe(Effect.provideContext(side.database)));
  yield* collect;
  const { outcome, detail } = classify(log, graded);
  const pass = outcome === "built" && graded.checks.every((check) => check.status === "pass");
  const record = {
    ...base,
    outcome,
    pass,
    detail,
    target: graded.target,
    checks: graded.checks,
    metrics: metricsOf(log),
    log,
    source: graded.source,
    screenshots: graded.screenshots
  } satisfies RunRecord;
  yield* fs.writeFileString(path.join(runDir, "run.json"), encodeRecord(record));
  yield* Console.error(
    `  ${label.padEnd(24)}  ${outcome}${pass ? ", passed" : ""} in ${(log.seconds / 60).toFixed(1)} min: ${graded.checks.map((check) => `${check.name} ${check.status}`).join(", ")}`
  );
  return record;
});

/** A run, retried once when it was the infrastructure's fault rather than the builder's. */
const runWithRetry = (suite: Suite, planned: Planned) =>
  runOne(suite, planned, 1).pipe(
    Effect.flatMap((record) =>
      record.outcome === "infra" ? runOne(suite, planned, 2) : Effect.succeed(record)
    )
  );

export class BaseUnavailable extends Schema.TaggedError<BaseUnavailable>()("BaseUnavailable", {
  reason: Schema.String
}) {
  override get message() {
    return `The base side couldn't come up, so there's nothing to compare against: ${this.reason} Fix the base, pick another with --base, or run --only-head.`;
  }
}

export class DoorOpen extends Schema.TaggedError<DoorOpen>()("DoorOpen", {
  side: Schema.String,
  commit: Schema.String
}) {
  override get message() {
    return `The ${this.side} instance (${this.commit.slice(0, 7)}) signs anyone in without the eval's key: its commit predates the keyed personas door, so its builders could see other runs' people. Pick a base that has it.`;
  }
}

/** Requests a keyed door must refuse: its picker, and signing someone in directly without the key or with a wrong one. */
const DOOR_PROBES = [
  "/dev/sign-in",
  "/dev/sign-in?as=door-probe%40patchy.local&return=%2F",
  "/dev/sign-in?as=door-probe%40patchy.local&return=%2F&key=wrong"
];

/**
 * Whether a side's personas door refuses every request without the eval's
 * key, as every eval instance's must: the picker, and a direct sign-in with no
 * key or a wrong one. An open door signs any email in and redirects, so
 * anything but 403 is open.
 */
const checkDoor = Effect.fn("Eval.checkDoor")(function* (name: "base" | "head", side: Side) {
  for (const probe of DOOR_PROBES) {
    const status = yield* HttpClient.get(`${side.served.apiUrl}${probe}`).pipe(
      Effect.map((response) => response.status),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => 0)
    );
    if (status !== 403) return yield* new DoorOpen({ side: name, commit: side.commit.sha });
  }
});

export class ToolchainMismatch extends Schema.TaggedError<ToolchainMismatch>()(
  "ToolchainMismatch",
  { head: Schema.String, base: Schema.String }
) {
  override get message() {
    return `The two sides' builders would run different tools (head: ${this.head}; base: ${this.base}), so the comparison wouldn't be fair.`;
  }
}

const toolList = (installed: ReadonlyArray<ToolVersion>) =>
  [...installed]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => `${tool.name} ${tool.version}`)
    .join(", ");

/** The toolchain as head installed it: every `latest` replaced by the version it resolved to. */
export const pinnedTo = (
  toolchain: Toolchain,
  installed: ReadonlyArray<ToolVersion>
): Toolchain => {
  const version = (name: keyof Toolchain) =>
    installed.find((tool) => tool.name === name)?.version ?? toolchain[name];
  return {
    node: version("node"),
    pnpm: version("pnpm"),
    claude: version("claude"),
    codex: version("codex")
  };
};

/**
 * A side, up and ready for runs: its network, its template HOME (its own
 * release's CLI and global skill on the shared toolchain), its database.
 */
const setUpSide = Effect.fn("Eval.setUpSide")(function* (input: {
  readonly name: "base" | "head";
  readonly side: Side;
  readonly dir: string;
  readonly toolchain: Toolchain;
  readonly builders: ReadonlyArray<Builder>;
  readonly signIns: SignIns;
  /** This checkout's scenario every side comes up on, frozen across sides. */
  readonly scenario: Scenario;
}) {
  const path = yield* Path.Path;
  const database = yield* Layer.build(sideSql(yield* sideDatabase(input.side.clone)));
  // The template is warmed as an identity of the eval's own, seeded from this checkout's
  // scenario, so a side whose own scenario differs still accepts it; retired afterwards.
  const bootRun = randomId(6);
  const boot = yield* seedRun(input.scenario, bootRun).pipe(Effect.provideContext(database));
  const network = yield* openNetwork({
    node: (yield* realNode()).execPath,
    instancePort: Number(new URL(input.side.served.apiUrl).port),
    allow: input.signIns.privateEndpoints
  });
  const template = path.join(input.dir, "homes", input.name);
  yield* Console.error(`  ${input.name.padEnd(6)}  setting up a builder's home`);
  const installed = yield* prepareTemplate({
    dir: template,
    apiUrl: input.side.served.apiUrl,
    network,
    toolchain: input.toolchain,
    builders: input.builders,
    token: boot.token
  });
  yield* retireRun(input.scenario, bootRun).pipe(Effect.provideContext(database));
  const context: SideContext = {
    name: input.name,
    commit: input.side.commit,
    apiUrl: input.side.served.apiUrl,
    database,
    template,
    network
  };
  return { context, installed };
});

/**
 * Runs the suite on each side, `base` then `head`, or `head` alone when `base`
 * is none, and writes its scorecard; returns the scorecard and where it is.
 * Runs alternate sides, and which side goes first alternates by repeat, so
 * neither side always meets a busier machine.
 */
export const runSuite = Effect.fn("Eval.runSuite")(function* (input: {
  readonly root: string;
  readonly head: Commit;
  readonly base: Option.Option<Commit>;
  readonly tasks: ReadonlyArray<Task>;
  readonly builders: ReadonlyArray<BuilderId>;
  readonly repeats: number;
  readonly concurrency: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* checkSandbox(input.root);
  yield* checkBrowser;
  const builders = input.builders.map((id) => BUILDERS[id]);
  const toolchain = yield* readToolchain(input.root);
  const signIns = yield* readSignIns(builders);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const suiteId = `${startedAt.replace(/[-:]/g, "").replace(/\..*$/, "")}-${input.head.sha.slice(0, 7)}`;
  const dir = path.join(input.root, ".local", "evals", suiteId);
  yield* fs.makeDirectory(dir, { recursive: true });
  // Every task's scenario is loaded up front, so a bad one fails before any instance starts.
  for (const task of input.tasks) yield* loadScenario(input.root, task.scenario);
  const { scenario: sideScenario } = yield* loadScenario(input.root, SIDE_SCENARIO);
  const doorKey = randomId(32);
  const seen = yield* Ref.make<ReadonlyArray<string>>([]);
  const { installed, records } = yield* Effect.scoped(
    Effect.gen(function* () {
      const sides = yield* evidence({
        root: input.root,
        command: "eval",
        scenario: SIDE_SCENARIO,
        before: input.base,
        after: input.head,
        runDir: dir,
        personasKey: doorKey
      });
      if (sides.before.status === "unavailable")
        return yield* new BaseUnavailable({ reason: sides.before.reason });
      // Both doors before any setup: a side that would show builders other runs' people never runs.
      yield* checkDoor("head", sides.after);
      if (sides.before.status === "served") yield* checkDoor("base", sides.before.side);
      const common = { dir, builders, signIns, scenario: sideScenario };
      const head = yield* setUpSide({ ...common, toolchain, name: "head", side: sides.after });
      // Base installs exactly what head did, `latest` included, and must end up with the same.
      let base: SideContext | null = null;
      if (sides.before.status === "served") {
        const set = yield* setUpSide({
          ...common,
          toolchain: pinnedTo(toolchain, head.installed),
          name: "base",
          side: sides.before.side
        });
        if (toolList(set.installed) !== toolList(head.installed))
          return yield* new ToolchainMismatch({
            head: toolList(head.installed),
            base: toolList(set.installed)
          });
        base = set.context;
      }
      const suite: Suite = { root: input.root, dir, doorKey, signIns, seen };
      // Repeats outermost, so an interrupted suite has every task and builder at least once.
      const planned: Array<Planned> = [];
      for (let repeat = 1; repeat <= input.repeats; repeat++)
        for (const task of input.tasks)
          for (const builder of builders)
            for (const side of base === null
              ? [head.context]
              : repeat % 2 === 1
                ? [base, head.context]
                : [head.context, base])
              planned.push({ task, builder, repeat, side });
      // One uncounted build per side first, repeat 0, so neither side's measured runs pay
      // its instance's cold start; it lands in `runs/` but not in the scorecard.
      yield* Console.error("Warming each side up with one uncounted build");
      yield* Effect.forEach(
        base === null ? [head.context] : [head.context, base],
        (side) =>
          runWithRetry(suite, { task: input.tasks[0]!, builder: builders[0]!, repeat: 0, side }),
        { concurrency: "unbounded", discard: true }
      );
      yield* Console.error(
        `Running ${planned.length} build${planned.length === 1 ? "" : "s"}, ${input.concurrency} at a time`
      );
      const records = yield* Effect.forEach(planned, (each) => runWithRetry(suite, each), {
        concurrency: input.concurrency
      });
      return { installed: head.installed, records };
    })
  );
  const card: Scorecard = {
    suite: suiteId,
    commit: input.head.sha,
    base: Option.getOrNull(Option.map(input.base, (commit) => commit.sha)),
    startedAt,
    toolchain: installed,
    runs: records.map(scorecardRun)
  };
  const sanitizer = yield* makeSanitizer({
    stateDirs: [],
    envs: [signIns.claude.env],
    identities: [...signIns.secrets, doorKey, ...(yield* Ref.get(seen))]
  });
  const markdown = yield* sanitizer.redact(scorecardMarkdown(card));
  const json = printJson(yield* sanitizer.redactJson(encodeScorecard(card)));
  yield* fs.writeFileString(path.join(dir, "scorecard.md"), `${markdown}\n`);
  yield* fs.writeFileString(path.join(dir, "scorecard.json"), `${json}\n`);
  return { dir, markdown, json };
});
