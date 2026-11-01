/**
 * `pnpm dev eval`: a suite of tasks, each given to each builder a number of
 * times, on an evidence instance at `HEAD` whose personas door only the grader
 * can open. Per run: its own company and people, a copy of the side's template
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
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { evidence, type Commit } from "../evidence.js";
import { makeSanitizer } from "../sanitize.js";
import { loadScenario, publisherToken } from "../scenario.js";
import { type Builder, BUILDERS, type BuilderId, runBuilder, type Step } from "./builders.js";
import { retireRun, seedRun, sideDatabase, sideSql } from "./fixtures.js";
import { checkBrowser, grade } from "./grade.js";
import { prepareHome, prepareTemplate, readSignIns, type SignIns } from "./home.js";
import { metricsOf } from "./metrics.js";
import { type Network, openNetwork } from "./network.js";
import { checkSandbox, resolveTools, type Tool } from "./sandbox.js";
import { classify, RunRecord, Scorecard, scorecardMarkdown } from "./scorecard.js";
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
  readonly commit: Commit;
  readonly apiUrl: string;
  /** The side's database, where runs are seeded and retired. */
  readonly database: Context.Context<SqlClient.SqlClient>;
  readonly doorKey: string;
  readonly template: string;
  readonly tools: ReadonlyArray<Tool>;
  readonly network: Network;
  readonly signIns: SignIns;
}

interface Planned {
  readonly task: Task;
  readonly builder: Builder;
  readonly repeat: number;
}

const short = (text: string, max = 110) => {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

const progress = (label: string, step: Step) =>
  Console.error(
    `  ${label.padEnd(18)}  ${(step.tool === "Bash" ? (step.exitCode === null ? step.outcome : `exit ${step.exitCode}`) : step.tool.toLowerCase()).padEnd(7)}  ${short(step.input)}`
  );

/** One run, start to finish. Setup failures come back as an `infra` record, never as an error. */
const runOne = Effect.fn("Eval.runOne")(function* (
  suite: Suite,
  planned: Planned,
  attempt: number
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { task, builder, repeat } = planned;
  const run = randomId(6);
  const label = `${task.id}/${builder.id}/${repeat}${attempt > 1 ? "+" : ""}`;
  const runDir = path.join(
    suite.dir,
    "runs",
    `${task.id}-${builder.id}-${repeat}${attempt > 1 ? `-retry` : ""}`
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
    side: "head" as const,
    commit: suite.commit.sha
  };
  const { scenario } = yield* loadScenario(suite.root, task.scenario);
  const setUp = yield* Effect.gen(function* () {
    const identities = yield* seedRun(scenario, run).pipe(Effect.provideContext(suite.database));
    const spec = yield* prepareHome({
      template: suite.template,
      home,
      apiUrl: suite.apiUrl,
      tools: suite.tools,
      network: suite.network,
      token: identities.token,
      builder,
      signIns: suite.signIns
    });
    return { identities, spec };
  }).pipe(Effect.result);
  if (setUp._tag === "Failure") {
    yield* Console.error(`  ${label.padEnd(18)}  setup failed: ${setUp.failure.message}`);
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
  yield* Console.error(`  ${label.padEnd(18)}  building as ${identities.publisher.email}`);
  const stream = yield* fs.open(path.join(runDir, "stream.jsonl"), { flag: "w" });
  const encoder = new TextEncoder();
  const log = yield* runBuilder({
    builder,
    spec,
    task: taskPrompt(task),
    timeout: Duration.minutes(task.minutes),
    record: (line) => Effect.ignore(stream.writeAll(encoder.encode(`${line}\n`))),
    onStep: (step) => progress(label, step)
  });
  const grading = grade({
    task,
    spec,
    runDir,
    people: identities.people,
    publisher: identities.publisher,
    door: { apiUrl: suite.apiUrl, key: suite.doorKey }
  });
  // The grader's own trouble gets one more try before the run counts as infrastructure.
  const first = yield* grading;
  const graded = first.infra === null ? first : yield* grading;
  yield* Effect.ignore(retireRun(scenario, run).pipe(Effect.provideContext(suite.database)));
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
    `  ${label.padEnd(18)}  ${outcome}${pass ? ", passed" : ""} in ${(log.seconds / 60).toFixed(1)} min: ${graded.checks.map((check) => `${check.name} ${check.status}`).join(", ")}`
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

/** Runs the suite at `HEAD` and writes its scorecard; returns the scorecard and where it is. */
export const runSuite = Effect.fn("Eval.runSuite")(function* (input: {
  readonly root: string;
  readonly commit: Commit;
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
  const tools = yield* resolveTools(input.root);
  const signIns = yield* readSignIns(builders);
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const suiteId = `${startedAt.replace(/[-:]/g, "").replace(/\..*$/, "")}-${input.commit.sha.slice(0, 7)}`;
  const dir = path.join(input.root, ".local", "evals", suiteId);
  yield* fs.makeDirectory(dir, { recursive: true });
  // Every task's scenario is loaded up front, so a bad one fails before any instance starts.
  for (const task of input.tasks) yield* loadScenario(input.root, task.scenario);
  const { scenario: sideScenario } = yield* loadScenario(input.root, SIDE_SCENARIO);
  const doorKey = randomId(32);
  const runs = yield* Effect.scoped(
    Effect.gen(function* () {
      const sides = yield* evidence({
        root: input.root,
        command: "eval",
        scenario: SIDE_SCENARIO,
        before: Option.none(),
        after: input.commit,
        runDir: dir,
        personasKey: doorKey
      });
      const side = sides.after;
      const network = yield* openNetwork({
        instancePort: Number(new URL(side.served.apiUrl).port),
        allow: signIns.privateHosts
      });
      const template = path.join(dir, "homes", "head");
      yield* Console.error("  head    setting up a builder's home");
      yield* prepareTemplate({
        dir: template,
        apiUrl: side.served.apiUrl,
        tools,
        network,
        token: publisherToken(sideScenario)
      });
      const suite: Suite = {
        root: input.root,
        dir,
        commit: input.commit,
        apiUrl: side.served.apiUrl,
        database: yield* Layer.build(sideSql(yield* sideDatabase(side.clone))),
        doorKey,
        template,
        tools,
        network,
        signIns
      };
      // Repeats outermost, so an interrupted suite has every task and builder at least once.
      const planned: Array<Planned> = [];
      for (let repeat = 1; repeat <= input.repeats; repeat++)
        for (const task of input.tasks)
          for (const builder of builders) planned.push({ task, builder, repeat });
      yield* Console.error(
        `Running ${planned.length} build${planned.length === 1 ? "" : "s"}, ${input.concurrency} at a time`
      );
      return yield* Effect.forEach(planned, (each) => runWithRetry(suite, each), {
        concurrency: input.concurrency
      });
    })
  );
  const card: Scorecard = { suite: suiteId, commit: input.commit.sha, startedAt, tools, runs };
  const sanitizer = yield* makeSanitizer({
    stateDirs: [],
    envs: [signIns.claude.env],
    identities: [...signIns.secrets, doorKey]
  });
  const markdown = yield* sanitizer.redact(scorecardMarkdown(card));
  const json = printJson(yield* sanitizer.redactJson(encodeScorecard(card)));
  yield* fs.writeFileString(path.join(dir, "scorecard.md"), `${markdown}\n`);
  yield* fs.writeFileString(path.join(dir, "scorecard.json"), `${json}\n`);
  return { dir, markdown, json };
});
