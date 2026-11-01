/**
 * What a builder's log says about how it worked, beyond whether it worked:
 * which of our texts it explicitly opened, where it went looking past them,
 * what the CLI refused, and how it checked its own work. Counts of what the
 * log shows: a skill read through a tool call is seen; one a harness loaded
 * into context on its own is not.
 */
import * as Schema from "effect/Schema";
import { isHelpLookup } from "../trial.js";
import type { BuilderLog, Step } from "./builders.js";

export const Metrics = Schema.Struct({
  toolCalls: Schema.Int,
  commands: Schema.Int,
  failedCommands: Schema.Int,
  /** Calls the harness refused; the sandbox grants everything, so anything here is a harness problem. */
  denials: Schema.Int,
  /** Structured CLI refusals by `code` (or `kind`), however the command's exit code was piped away. */
  refusals: Schema.Record(Schema.String, Schema.Int),
  /** Observed explicit accesses to our texts, by name: `patchy` is the global skill. */
  skillAccesses: Schema.Record(Schema.String, Schema.Int),
  /** Reads into the installed package's code or type declarations: questions the skills didn't answer. */
  offSkillLookups: Schema.Int,
  helpLookups: Schema.Int,
  typecheckRuns: Schema.Int,
  typecheckFailures: Schema.Int,
  publishes: Schema.Int,
  devStarts: Schema.Int,
  /** Attempts to look at a page itself: a browser, Playwright, or curl at a local address. */
  pageChecks: Schema.Int
});
export type Metrics = typeof Metrics.Type;

const SKILL = /skills\/(patchy[\w-]*)\/(SKILL\.md|references\/[\w.-]+)/g;
const OFF_SKILL = /node_modules\/patchy\/(?!skills\/)|\.d\.ts\b/;
const TYPECHECK = /\bpnpm\s+(?:run\s+)?typecheck\b|\btsc\b/;
const PUBLISH = /\bpatchy\s+publish\b/;
const DEV_START = /\bpatchy\s+dev\b(?!\s+(?:stop|status|logs|reset)\b)/;
const PAGE_CHECK = /\bchromium\b|\bchrome\b|playwright|\bcurl\b[^|;&]*(?:localhost|127\.0\.0\.1)/i;

/**
 * What a step was pointed at: a command's first line, so a heredoc's body (the
 * code it writes, imports and all) isn't mistaken for something it read.
 */
const pointedAt = (step: Step) =>
  step.tool === "Bash" ? (step.input.split("\n")[0] ?? "") : step.input;

/** What our texts are called: a skill (`patchy`, `patchy-loop`) and a reference file in one. */
const SKILL_NAME = /^patchy(?:-[a-z0-9]+){0,3}$/;
const REFERENCE = /^references\/[a-z0-9-]{1,40}\.(?:md|html)$/;

/**
 * Every one of our texts a step names: a skill or its reference, the repo's
 * `AGENTS.md`, the generated index. Only names shaped like ours count: a
 * builder controls what it types, and these become labels on the scorecard.
 */
export const textsIn = (step: Step): ReadonlyArray<string> => {
  if (step.tool === "Skill") return SKILL_NAME.test(step.input) ? [step.input] : [];
  const target = pointedAt(step);
  const named = [...target.matchAll(SKILL)].flatMap(([, skill, file]) =>
    !SKILL_NAME.test(skill!)
      ? []
      : file === "SKILL.md"
        ? [skill!]
        : REFERENCE.test(file!)
          ? [`${skill}/${file}`]
          : []
  );
  if (/\bAGENTS\.md\b/.test(target)) named.push("AGENTS.md");
  if (/_generated\/index\.json\b/.test(target)) named.push("index.json");
  return named;
};

const count = <A>(items: ReadonlyArray<A>, test: (item: A) => boolean) => items.filter(test).length;

export const metricsOf = (log: BuilderLog): Metrics => {
  const commands = log.steps.filter((step) => step.tool === "Bash");
  const failed = (step: Step) => step.outcome === "failed";
  const refusals: Record<string, number> = {};
  const skillAccesses: Record<string, number> = {};
  for (const step of log.steps) {
    for (const code of step.refusals) refusals[code] = (refusals[code] ?? 0) + 1;
    for (const text of textsIn(step)) skillAccesses[text] = (skillAccesses[text] ?? 0) + 1;
  }
  const typechecks = commands.filter((step) => TYPECHECK.test(step.input));
  return {
    toolCalls: log.steps.length,
    commands: commands.length,
    failedCommands: count(commands, failed),
    denials: count(log.steps, (step) => step.outcome === "denied"),
    refusals,
    skillAccesses,
    offSkillLookups: count(
      log.steps,
      (step) =>
        ["Bash", "Read", "Grep", "Glob"].includes(step.tool) && OFF_SKILL.test(pointedAt(step))
    ),
    helpLookups: count(commands, (step) => isHelpLookup(step.input)),
    typecheckRuns: typechecks.length,
    typecheckFailures: count(typechecks, failed),
    publishes: count(commands, (step) => PUBLISH.test(step.input)),
    devStarts: count(commands, (step) => DEV_START.test(step.input)),
    pageChecks: count(commands, (step) => PAGE_CHECK.test(step.input))
  };
};
