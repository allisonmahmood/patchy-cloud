/**
 * Expert review of what each builder published, for what checks can't see:
 * whether it was built the way an expert would build it on Patchy. Two judges
 * from two model families, each in its real harness at its highest effort:
 * Claude Code with Opus 5.5 and Codex with GPT-6.1 Sol. Both review every
 * judged run, so each builder meets one judge of its own family and one not.
 *
 * Two passes, kept apart so the thing being measured can't grade itself:
 *
 * 1. **Scoring, blind.** A judge sees the task's words and rubric, the
 *    published source, the screenshots and the check results, and Patchy's
 *    own code for how the platform really works, with every skill folder and
 *    the git history masked. It never sees the skills the builder had, which
 *    side or builder the run came from, or what the builder said.
 * 2. **Attribution, a hypothesis.** For findings of medium severity or worse,
 *    a second pass shows the judge the builder's skills and log and asks
 *    which instruction plausibly led there, or what was missing. It feeds the
 *    clusters an edit works from, never a score.
 *
 * Judges run in the same sandbox as builders, on a HOME with the toolchain
 * and nothing of Patchy's skill, and answer to a JSON Schema derived from the
 * same Effect schema that decodes their answer.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { stepOutput } from "../steps.js";
import type { Builder, BuilderLog } from "./builders.js";
import { type SignIns, signInHarness } from "./home.js";
import type { Network } from "./network.js";
import { HOME, runSandboxed, type SandboxSpec } from "./sandbox.js";
import type { Task } from "./task.js";

export const JUDGES = {
  opus: { id: "opus", harness: "claude-code", model: "claude-opus-5-5", effort: "xhigh" },
  sol: { id: "sol", harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" }
} as const satisfies Record<string, Builder>;
export type JudgeId = keyof typeof JUDGES;
export const JUDGE_IDS = Object.keys(JUDGES) as ReadonlyArray<JudgeId>;

/** What a judge scores, each from 1 to 5. */
export const DIMENSIONS = ["fit", "platform", "correctness", "ux", "code"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const Score = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }));

export const Scores = Schema.Struct({
  fit: Score,
  platform: Score,
  correctness: Score,
  ux: Score,
  code: Score
});
export type Scores = typeof Scores.Type;

export const Finding = Schema.Struct({
  severity: Schema.Literals(["high", "medium", "low"]),
  what: Schema.String,
  /** A file and line, or a screen. */
  where: Schema.String,
  why: Schema.String
});

/** A judge's scoring pass. */
export const Verdict = Schema.Struct({
  scores: Scores,
  findings: Schema.Array(Finding),
  summary: Schema.String
});
export type Verdict = typeof Verdict.Type;

/** A judge's attribution pass: per finding, the instruction that plausibly led there or what was missing. */
export const Attribution = Schema.Struct({
  links: Schema.Array(
    Schema.Struct({
      /** The finding's index in the verdict. */
      finding: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
      /** The skill file the instruction is in, as it appears under `skills/`, or null. */
      skill: Schema.NullOr(Schema.String),
      /** The instruction's exact text, or null when the problem is something missing. */
      quote: Schema.NullOr(Schema.String),
      /** What the instructions didn't say that would have prevented it, or null. */
      missing: Schema.NullOr(Schema.String),
      hypothesis: Schema.String
    })
  )
});
export type Attribution = typeof Attribution.Type;

/** What a run keeps of each judge: the scores, and why there are none when there are none. */
export const JudgeRecord = Schema.Struct({
  judge: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  scores: Schema.NullOr(Scores),
  findings: Schema.Int,
  /** Why the judge gave no verdict: its harness or provider failed, or its answer didn't decode. */
  infra: Schema.NullOr(Schema.String)
});
export type JudgeRecord = typeof JudgeRecord.Type;

const printJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const printCompact = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A JSON Schema with every object closed (`additionalProperties: false`), as
 * strict structured output requires: Codex's provider refuses an open one.
 */
export const closed = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(closed);
  if (typeof schema !== "object" || schema === null) return schema;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) result[key] = closed(value);
  return result.type === "object" ? { ...result, additionalProperties: false } : result;
};

/** A JSON Schema a harness can hold its final answer to, derived from the schema that decodes it. */
const harnessSchema = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema);
  return closed(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions }
  );
};
const VERDICT_SCHEMA = harnessSchema(Verdict);
const ATTRIBUTION_SCHEMA = harnessSchema(Attribution);
const decodeVerdict = Schema.decodeUnknownOption(Verdict);
const decodeAttribution = Schema.decodeUnknownOption(Attribution);

/** What each dimension means and its anchors, the same for every task. */
const DIMENSION_GUIDE = `## How to score

Score each dimension from 1 to 5. 5: an expert Patchy builder would ship it as is. 3: it works, with notable problems. 1: wrong or broken.

- **fit**: it does what was asked, with sensible assumptions, and nothing that wasn't.
- **platform**: it uses Patchy the way an expert would: the right tier, rules enforced where they must be, owned tables and files, live queries, the SDK's own features rather than reinventions, bounded reads.
- **correctness**: the data model, concurrent use, retries, edge cases, Patchy's limits and deadlines.
- **ux**: from the screenshots: clear, in the company look, sensible empty states, usable on a phone.
- **code**: simple, typed and maintainable; no dead code or needless machinery.`;

const SCORING_PROMPT = `You're reviewing an internal tool an AI agent built on Patchy Cloud, a private cloud where a company's internal tools, called patches, run. A colleague asked for it in the words in TASK.md.

In /work:
- TASK.md: the request, what good looks like for it, and how to score.
- source/: the tool's published source, as it is served. Absent for a single-file page.
- desktop.png and phone.png: what a colleague sees when they open it.
- checks.json: automated checks that ran against the published tool.

Patchy's own source code is at /patchy, for how its SDK and runtime really work.

Read only: don't build, run or change anything. Then answer with the JSON your output schema asks for: a score for each dimension in TASK.md, your findings most severe first (each with what, where as a file and line or a screen, and why it matters), and a one-paragraph summary.`;

const ATTRIBUTION_PROMPT = `A reviewer found the problems in /work/findings.json in an internal tool an AI agent built on Patchy Cloud. The agent built it from Patchy's instructions to agents, which are in /work/skills/ (global/ is the skill it started from, project/ the skills and AGENTS.md of the repo it worked in), and /work/log.json is what it did: its commands, their failures and its final answer.

For each finding of high or medium severity, say whether Patchy's instructions plausibly led the agent there: quote the instruction that did, exactly, with its file under skills/, or say what the instructions didn't tell it that would have prevented it. These are hypotheses, not verdicts; say so where the link is weak. Read only. Answer with the JSON your output schema asks for, one entry per finding you consider, \`finding\` being its index in findings.json.`;

/** TASK.md for the scoring pass: the words, the rubric and the scoring guide; nothing about the run. */
export const taskBrief = (task: Task) =>
  [
    "# The request",
    "",
    task.words,
    "",
    "# What good looks like",
    "",
    task.rubric,
    "",
    DIMENSION_GUIDE,
    ""
  ].join("\n");

const ClaudeAnswer = Schema.Struct({
  is_error: Schema.optional(Schema.Boolean),
  structured_output: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.NullOr(Schema.String))
});
const decodeClaudeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeAnswer));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * A judge's harness exiting non-zero, its last error line on this machine's
 * console only: the line can name local paths, so it never reaches a record.
 */
const reportFailure = (judge: Builder, exitCode: number, stderr: string) =>
  Console.error(
    `  ${judge.id}  exited ${exitCode}: ${stderr.trim().split("\n").at(-1) ?? "(nothing on stderr)"}`
  );

/** How long a judge may take over one pass at its highest effort. */
const PASS_TIMEOUT = "25 minutes";

/**
 * One pass by one judge in its sandbox: the prompt on stdin, an answer held
 * to `jsonSchema`, decoded by `schema`. A failure is the judge's trouble,
 * never the builder's: it comes back as a reason, not a verdict.
 */
const pass = Effect.fn("Eval.judgePass")(function* <A>(input: {
  readonly judge: Builder;
  readonly spec: SandboxSpec;
  readonly prompt: string;
  readonly decode: (answer: unknown) => Option.Option<A>;
  readonly jsonSchema: unknown;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decode = input.decode;
  if (input.judge.harness === "claude-code") {
    const ran = yield* runSandboxed(
      input.spec,
      "claude",
      [
        "-p",
        "--model",
        input.judge.model,
        "--effort",
        input.judge.effort,
        "--output-format",
        "json",
        "--json-schema",
        printCompact(input.jsonSchema),
        "--permission-mode",
        "bypassPermissions",
        "--no-session-persistence"
      ],
      { input: input.prompt, timeout: PASS_TIMEOUT }
    );
    if (ran.exitCode === null) return { answer: null, why: "It ran out of time." } as const;
    if (ran.exitCode !== 0) yield* reportFailure(input.judge, ran.exitCode, ran.stderr);
    // Claude Code may print a warning line before its JSON.
    const answer = decodeClaudeAnswer(ran.stdout.slice(Math.max(0, ran.stdout.indexOf("{"))));
    const decoded = Option.flatMap(answer, (each) =>
      each.is_error === true ? Option.none() : decode(each.structured_output)
    );
    return Option.isSome(decoded)
      ? ({ answer: decoded.value, why: null } as const)
      : ({ answer: null, why: "Its answer didn't decode." } as const);
  }
  const schemaFile = path.join(input.spec.home, ".eval-schema.json");
  const outFile = path.join(input.spec.home, ".eval-answer.json");
  yield* fs.writeFileString(schemaFile, printJson(input.jsonSchema));
  yield* fs.remove(outFile, { force: true });
  const ran = yield* runSandboxed(
    input.spec,
    "codex",
    [
      "exec",
      "-m",
      input.judge.model,
      "-c",
      `model_reasoning_effort=${input.judge.effort}`,
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-schema",
      `${HOME}/.eval-schema.json`,
      "-o",
      `${HOME}/.eval-answer.json`,
      "-"
    ],
    { input: input.prompt, timeout: PASS_TIMEOUT }
  );
  if (ran.exitCode === null) return { answer: null, why: "It ran out of time." } as const;
  if (ran.exitCode !== 0) yield* reportFailure(input.judge, ran.exitCode, ran.stderr);
  const text = yield* fs.readFileString(outFile).pipe(Effect.orElseSucceed(() => ""));
  const decoded = Option.flatMap(decodeJson(text), decode);
  return Option.isSome(decoded)
    ? ({ answer: decoded.value, why: null } as const)
    : ({ answer: null, why: "Its answer didn't decode." } as const);
});

/** Copies a folder, its dependencies left behind, for a judge to read. */
const copySource = Effect.fn("Eval.copySource")(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* stepOutput("Copying the published source", "cp", ["-a", "--reflink=auto", from, to], {
    cwd: path.dirname(to),
    prefix: "cp"
  });
  for (const generated of ["node_modules", ".patchy"])
    yield* fs.remove(path.join(to, generated), { recursive: true, force: true });
});

/** The repo the builder worked in: the first folder under its HOME holding a `patchy.json`. */
const workingRepo = Effect.fn("Eval.workingRepo")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const patchy = path.join(home, "Patchy");
  if (!(yield* fs.exists(patchy))) return undefined;
  for (const entry of yield* fs.readDirectory(patchy))
    if (yield* fs.exists(path.join(patchy, entry, "patchy.json"))) return path.join(patchy, entry);
  return undefined;
});

/**
 * What a blind judge mustn't read in a checkout: every skill folder, the
 * repo's own agent folders, its git history and its local state. Each is
 * hidden as what it is on this machine (in a linked worktree `.git` is a
 * file), and one that isn't there is skipped.
 */
const HIDDEN = ["skills", "packages/sdk/skills", ".agents", ".claude", ".git", ".local"];

const masksIn = Effect.fn("Eval.masksIn")(function* (checkout: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const masks: Array<{ at: string; file: boolean }> = [];
  for (const hidden of HIDDEN) {
    const info = yield* fs.stat(path.join(checkout, hidden)).pipe(Effect.option);
    if (Option.isSome(info))
      masks.push({ at: `/patchy/${hidden}`, file: info.value.type !== "Directory" });
  }
  return masks;
});

/** Everything one judge needs for one run. */
export interface Judging {
  readonly judge: Builder;
  readonly task: Task;
  /** The run's folder on this machine. */
  readonly runDir: string;
  /** The published source inside the run's folder, when the target is a repo. */
  readonly source: string | null;
  readonly screenshots: ReadonlyArray<string>;
  readonly checks: unknown;
  readonly log: BuilderLog | null;
  /** The checkout of the run's side, for Patchy's own code, its skills and history masked. */
  readonly checkout: string;
  /** The judges' template HOME: the toolchain, no Patchy skill. */
  readonly template: string;
  readonly network: Network;
  readonly signIns: SignIns;
  /** Whether to run the attribution pass; calibration scores only. */
  readonly attribute?: boolean;
}

/** What a judge said about a run: both passes, and why either is missing. */
export interface Judged {
  readonly record: JudgeRecord;
  readonly verdict: Verdict | null;
  readonly attribution: Attribution | null;
}

/**
 * Both passes by one judge on one run. The scoring pass reads a blind
 * workspace; the attribution pass, only when the verdict has findings of
 * medium severity or worse, reads another with the builder's skills and log.
 */
export const judge = Effect.fn("Eval.judge")(function* (input: Judging) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(input.runDir, "judging", input.judge.id);
  yield* fs.remove(dir, { recursive: true, force: true });
  const home = path.join(dir, "home");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* stepOutput(
    "Copying the judges' home",
    "cp",
    ["-a", "--reflink=auto", input.template, home],
    {
      cwd: dir,
      prefix: "cp"
    }
  );
  const signedIn = yield* signInHarness(home, input.judge, input.signIns);
  const base: SandboxSpec = { home, network: input.network, ...signedIn };

  // The blind workspace.
  const work = path.join(dir, "work");
  yield* fs.makeDirectory(work, { recursive: true });
  yield* fs.writeFileString(path.join(work, "TASK.md"), taskBrief(input.task));
  yield* fs.writeFileString(path.join(work, "checks.json"), printJson(input.checks));
  for (const shot of input.screenshots)
    yield* fs.copyFile(path.join(input.runDir, shot), path.join(work, path.basename(shot)));
  if (input.source !== null)
    yield* copySource(path.join(input.runDir, input.source), path.join(work, "source"));
  const scoring = yield* pass({
    judge: input.judge,
    spec: {
      ...base,
      cwd: "/work",
      binds: [
        ...(base.binds ?? []),
        { from: work, to: "/work", readOnly: true },
        { from: input.checkout, to: "/patchy", readOnly: true }
      ],
      masks: yield* masksIn(input.checkout)
    },
    prompt: SCORING_PROMPT,
    decode: decodeVerdict,
    jsonSchema: VERDICT_SCHEMA
  });
  const record = (scores: Scores | null, findings: number, infra: string | null): JudgeRecord => ({
    judge: input.judge.id,
    model: input.judge.model,
    effort: input.judge.effort,
    scores,
    findings,
    infra
  });
  if (scoring.answer === null)
    return {
      record: record(null, 0, scoring.why),
      verdict: null,
      attribution: null
    } satisfies Judged;
  const verdict = scoring.answer;
  if (input.attribute === false || !verdict.findings.some((finding) => finding.severity !== "low"))
    return {
      record: record(verdict.scores, verdict.findings.length, null),
      verdict,
      attribution: null
    } satisfies Judged;

  // The attribution workspace: the findings, what the builder did, and what it was told.
  const attributing = path.join(dir, "attribution");
  yield* fs.makeDirectory(path.join(attributing, "skills"), { recursive: true });
  yield* fs.writeFileString(path.join(attributing, "findings.json"), printJson(verdict.findings));
  yield* fs.writeFileString(
    path.join(attributing, "log.json"),
    printJson({
      steps: (input.log?.steps ?? []).map(({ tool, input: target, outcome, error }) => ({
        tool,
        input: target,
        outcome,
        error
      })),
      answer: input.log?.answer ?? null
    })
  );
  const runHome = path.join(input.runDir, "home");
  const global = path.join(runHome, ".patchy", "skills", "patchy");
  if (yield* fs.exists(global))
    yield* stepOutput(
      "Copying the global skill",
      "cp",
      ["-a", global, path.join(attributing, "skills", "global")],
      {
        cwd: attributing,
        prefix: "cp"
      }
    );
  const repo = yield* workingRepo(runHome);
  if (repo !== undefined) {
    const project = path.join(attributing, "skills", "project");
    yield* fs.makeDirectory(project, { recursive: true });
    if (yield* fs.exists(path.join(repo, ".agents", "skills")))
      yield* stepOutput(
        "Copying the project's skills",
        "cp",
        ["-a", path.join(repo, ".agents", "skills"), project],
        {
          cwd: attributing,
          prefix: "cp"
        }
      );
    if (yield* fs.exists(path.join(repo, "AGENTS.md")))
      yield* fs.copyFile(path.join(repo, "AGENTS.md"), path.join(project, "AGENTS.md"));
  }
  const attribution = yield* pass({
    judge: input.judge,
    spec: {
      ...base,
      cwd: "/work",
      binds: [...(base.binds ?? []), { from: attributing, to: "/work", readOnly: true }]
    },
    prompt: ATTRIBUTION_PROMPT,
    decode: decodeAttribution,
    jsonSchema: ATTRIBUTION_SCHEMA
  });
  return {
    record: record(verdict.scores, verdict.findings.length, null),
    verdict,
    attribution: attribution.answer
  } satisfies Judged;
});

/** The mean of each dimension over the scores given; null when there are none. */
export const meanScores = (all: ReadonlyArray<Scores>): Record<Dimension, number> | null => {
  if (all.length === 0) return null;
  const mean = (dimension: Dimension) =>
    all.reduce((sum, scores) => sum + scores[dimension], 0) / all.length;
  return {
    fit: mean("fit"),
    platform: mean("platform"),
    correctness: mean("correctness"),
    ux: mean("ux"),
    code: mean("code")
  };
};

/** The dimensions two judges scored 2 or more apart, for a person to look at. */
export const splits = (records: ReadonlyArray<JudgeRecord>): ReadonlyArray<Dimension> => {
  const scored = records.flatMap((each) => (each.scores === null ? [] : [each.scores]));
  if (scored.length < 2) return [];
  return DIMENSIONS.filter((dimension) => {
    const values = scored.map((scores) => scores[dimension]);
    return Math.max(...values) - Math.min(...values) >= 2;
  });
};
