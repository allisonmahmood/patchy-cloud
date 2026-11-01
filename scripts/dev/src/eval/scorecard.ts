/**
 * A run's record, how its outcome is classified, and the suite's scorecard.
 *
 * Outcomes: `built` (it finished and something is published), `asked` (it
 * finished on a question instead), `gave-up` (it finished or failed without
 * publishing), `timed-out`, and `infra` (setup, the model provider or the
 * grader failed: retried once, and never counted against a builder). A run passes when it
 * built and every check passed.
 */
import * as Schema from "effect/Schema";
import { BuilderLog } from "./builders.js";
import { CheckResult, type Graded, TargetRecord } from "./grade.js";
import { type Dimension, DIMENSIONS, JudgeRecord, meanScores, splits } from "./judges.js";
import { Metrics } from "./metrics.js";
import { ToolVersion } from "./home.js";

export const Outcome = Schema.Literals(["built", "asked", "gave-up", "timed-out", "infra"]);
export type Outcome = typeof Outcome.Type;

export const RunRecord = Schema.Struct({
  run: Schema.String,
  task: Schema.String,
  builder: Schema.String,
  model: Schema.String,
  effort: Schema.String,
  repeat: Schema.Int,
  side: Schema.Literals(["head", "base"]),
  commit: Schema.String,
  /** The run's folder, inside the suite's. */
  dir: Schema.String,
  outcome: Outcome,
  pass: Schema.Boolean,
  /** Why it is `infra`, or what the harness said went wrong. */
  detail: Schema.NullOr(Schema.String),
  target: Schema.NullOr(TargetRecord),
  checks: Schema.Array(CheckResult),
  metrics: Schema.NullOr(Metrics),
  log: Schema.NullOr(BuilderLog),
  /** Inside the run's folder. */
  source: Schema.NullOr(Schema.String),
  screenshots: Schema.Array(Schema.String),
  /** Each judge's scores; empty until judged, and for a run with nothing to judge. */
  judges: Schema.Array(JudgeRecord)
});
export type RunRecord = typeof RunRecord.Type;

/** Provider and transport failures: the run never got a fair go, so it is infrastructure. */
const PROVIDER =
  /rate.?limit|overloaded|\b5\d\d\b|\b429\b|\b401\b|unauthori[sz]ed|authenticat|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|stream disconnected|network error|API Error|credit balance|quota/i;

export const classify = (
  log: BuilderLog,
  graded: Graded
): { outcome: Outcome; detail: string | null } => {
  if (graded.infra !== null) return { outcome: "infra", detail: graded.infra };
  if (log.ending === "timed-out") return { outcome: "timed-out", detail: null };
  if (log.ending === "failed" || log.ending === "no-answer") {
    const provider = log.detail !== null && PROVIDER.test(log.detail);
    return {
      outcome: provider || log.steps.length === 0 ? "infra" : "gave-up",
      detail: log.detail
    };
  }
  if (graded.target !== null) return { outcome: "built", detail: null };
  const lastLine = (log.answer ?? "").trim().split("\n").at(-1) ?? "";
  return { outcome: lastLine.trim().endsWith("?") ? "asked" : "gave-up", detail: null };
};

/** How a builder's run went, without anything it wrote: no commands, errors or answer. */
export const LogSummary = Schema.Struct({
  ending: BuilderLog.fields.ending,
  seconds: BuilderLog.fields.seconds,
  turns: BuilderLog.fields.turns,
  usage: BuilderLog.fields.usage,
  costUsd: BuilderLog.fields.costUsd,
  model: BuilderLog.fields.model
});

/**
 * A run as the scorecard carries it: outcome, checks, metrics and a summary
 * of its log. The builder's own text (its commands, their errors, its answer)
 * stays in the run's `run.json` on this machine, so nothing a builder printed
 * reaches a scorecard a PR can carry.
 */
export const ScorecardRun = Schema.Struct({ ...RunRecord.fields, log: Schema.NullOr(LogSummary) });
export type ScorecardRun = typeof ScorecardRun.Type;

export const scorecardRun = (record: RunRecord): ScorecardRun => ({
  ...record,
  log:
    record.log === null
      ? null
      : {
          ending: record.log.ending,
          seconds: record.log.seconds,
          turns: record.log.turns,
          usage: record.log.usage,
          costUsd: record.log.costUsd,
          model: record.log.model
        }
});

export const Scorecard = Schema.Struct({
  suite: Schema.String,
  /** `HEAD`'s commit. */
  commit: Schema.String,
  /** The base's commit, or null when the suite ran `HEAD` alone. */
  base: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  toolchain: Schema.Array(ToolVersion),
  runs: Schema.Array(ScorecardRun)
});
export type Scorecard = typeof Scorecard.Type;

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const fmt = (value: number | null, digits = 0) => (value === null ? "–" : value.toFixed(digits));
const kilo = (value: number | null) => (value === null ? "–" : `${Math.round(value / 1000)}k`);

/** One builder's runs of one task, without infrastructure failures. */
export const summarize = (runs: ReadonlyArray<ScorecardRun>) => {
  const counted = runs.filter((run) => run.outcome !== "infra");
  const logs = counted.flatMap((run) => (run.log === null ? [] : [run.log]));
  const metrics = counted.flatMap((run) => (run.metrics === null ? [] : [run.metrics]));
  const refusals: Record<string, number> = {};
  for (const each of metrics)
    for (const [code, n] of Object.entries(each.refusals))
      refusals[code] = (refusals[code] ?? 0) + n;
  return {
    runs: counted.length,
    infra: runs.length - counted.length,
    built: counted.filter((run) => run.outcome === "built").length,
    passed: counted.filter((run) => run.pass).length,
    minutes: median(logs.map((log) => log.seconds / 60)),
    turns: median(logs.flatMap((log) => (log.turns === null ? [] : [log.turns]))),
    input: median(logs.flatMap((log) => (log.usage.input === null ? [] : [log.usage.input]))),
    output: median(logs.flatMap((log) => (log.usage.output === null ? [] : [log.usage.output]))),
    failed: median(metrics.map((each) => each.failedCommands)),
    offSkill: median(metrics.map((each) => each.offSkillLookups)),
    ...judging(counted),
    refusals: Object.entries(refusals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code, n]) => `${code} ×${n}`)
  };
};

/**
 * What the judges said across runs: each dimension's mean over every judge's
 * scores, their overall mean, and how many runs had judges 2 or more apart.
 */
export const judging = (runs: ReadonlyArray<Pick<ScorecardRun, "judges">>) => {
  const dimensions = meanScores(
    runs.flatMap((run) => run.judges.flatMap((each) => (each.scores === null ? [] : [each.scores])))
  );
  return {
    dimensions,
    judged:
      dimensions === null
        ? null
        : DIMENSIONS.reduce((sum, dimension) => sum + dimensions[dimension], 0) / DIMENSIONS.length,
    split: runs.filter((run) => splits(run.judges).length > 0).length
  };
};

const mark = (status: CheckResult["status"]) =>
  status === "pass" ? "✓" : status === "fail" ? "✗" : "–";

/** A base → head cell: both values, and the change when both exist. */
export const shift = (
  base: number | null,
  head: number | null,
  show: (value: number) => string
) => {
  if (base === null && head === null) return "–";
  const change =
    base === null || head === null || head === base
      ? ""
      : ` (${head > base ? "+" : "−"}${show(Math.abs(head - base))})`;
  return `${base === null ? "–" : show(base)} → ${head === null ? "–" : show(head)}${change}`;
};

const tenths = (value: number) => value.toFixed(1);
const whole = (value: number) => value.toFixed(0);
const thousands = (value: number) => `${Math.round(value / 1000)}k`;

/**
 * The scorecard as Markdown: what ran, then each builder against each task
 * (with a base, each figure as base → head and its change), then every run.
 */
export const scorecardMarkdown = (card: Scorecard) => {
  const builders = [...new Set(card.runs.map((run) => run.builder))];
  const tasks = [...new Set(card.runs.map((run) => run.task))];
  const models = builders.map((builder) => {
    const run = card.runs.find((each) => each.builder === builder)!;
    return `\`${builder}\` is ${run.model} at ${run.effort}`;
  });
  const where =
    card.base === null
      ? `At \`${card.commit.slice(0, 7)}\`.`
      : `Head \`${card.commit.slice(0, 7)}\` against base \`${card.base.slice(0, 7)}\`.`;
  const lines = [
    `### Eval \`${card.suite}\``,
    "",
    `${where} ${models.join("; ")}. Tools: ${card.toolchain.map((tool) => `${tool.name} ${tool.version}`).join(", ")}.`,
    ""
  ];
  const of = (task: string, builder: string, side: "base" | "head") =>
    summarize(
      card.runs.filter((run) => run.task === task && run.builder === builder && run.side === side)
    );
  if (card.base === null) {
    lines.push(
      "| Task | Builder | Runs | Built | Passed | Judged | Minutes | Turns | Input | Output | Failed cmds | Off-skill | Refusals |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    );
    for (const task of tasks)
      for (const builder of builders) {
        const s = of(task, builder, "head");
        lines.push(
          `| ${task} | ${builder} | ${s.runs}${s.infra > 0 ? ` (+${s.infra} infra)` : ""} | ${s.built} | ${s.passed} | ${fmt(s.judged, 1)}${s.split > 0 ? ` (${s.split} split)` : ""} | ${fmt(s.minutes, 1)} | ${fmt(s.turns)} | ${kilo(s.input)} | ${kilo(s.output)} | ${fmt(s.failed)} | ${fmt(s.offSkill)} | ${s.refusals.join(", ") || "–"} |`
        );
      }
  } else {
    lines.push(
      "| Task | Builder | Passed | Judged | Minutes | Turns | Input | Failed cmds | Off-skill |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    );
    for (const task of tasks)
      for (const builder of builders) {
        const b = of(task, builder, "base");
        const h = of(task, builder, "head");
        const infra = b.infra + h.infra > 0 ? ` (+${b.infra + h.infra} infra)` : "";
        lines.push(
          `| ${task} | ${builder} | ${b.passed}/${b.runs} → ${h.passed}/${h.runs}${infra} | ${shift(b.judged, h.judged, tenths)}${b.split + h.split > 0 ? ` (${b.split + h.split} split)` : ""} | ${shift(b.minutes, h.minutes, tenths)} | ${shift(b.turns, h.turns, whole)} | ${shift(b.input, h.input, thousands)} | ${shift(b.failed, h.failed, whole)} | ${shift(b.offSkill, h.offSkill, whole)} |`
        );
      }
  }
  lines.push(
    "",
    "Medians, without infrastructure failures; judged is the judges' mean score out of 5, and a split is a run its judges scored 2 or more apart on a dimension. Few runs are a pilot, not a measurement.",
    ""
  );
  if (card.runs.some((run) => run.judges.some((each) => each.scores !== null))) {
    const named: Record<Dimension, string> = {
      fit: "Fit",
      platform: "Platform",
      correctness: "Correctness",
      ux: "UX",
      code: "Code"
    };
    lines.push(
      `| Task | Builder | ${DIMENSIONS.map((dimension) => named[dimension]).join(" | ")} |`,
      `| --- | --- | ${DIMENSIONS.map(() => "---").join(" | ")} |`
    );
    for (const task of tasks)
      for (const builder of builders) {
        const h = of(task, builder, "head").dimensions;
        const b = card.base === null ? null : of(task, builder, "base").dimensions;
        lines.push(
          `| ${task} | ${builder} | ${DIMENSIONS.map((dimension) =>
            card.base === null
              ? fmt(h?.[dimension] ?? null, 1)
              : shift(b?.[dimension] ?? null, h?.[dimension] ?? null, tenths)
          ).join(" | ")} |`
        );
      }
    lines.push("");
  }
  lines.push("| Run | Outcome | Checks | Minutes | Notes |", "| --- | --- | --- | --- | --- |");
  for (const run of card.runs) {
    const failedChecks = run.checks.filter((check) => check.status === "fail");
    const notes = [
      ...(run.detail === null ? [] : [run.detail]),
      ...failedChecks.map((check) => `${check.name}: ${check.detail ?? ""}`)
    ]
      .join("; ")
      .replaceAll("|", "\\|")
      .slice(0, 240);
    lines.push(
      `| ${card.base === null ? "" : `${run.side}:`}${run.task}/${run.builder}/${run.repeat} | ${run.outcome}${run.pass ? " ✓" : ""} | ${run.checks.map((check) => mark(check.status)).join("")} | ${fmt(run.log === null ? null : run.log.seconds / 60, 1)} | ${notes} |`
    );
  }
  return lines.join("\n");
};
