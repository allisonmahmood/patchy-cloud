/**
 * `pnpm dev trial`: a fresh agent tries a task on both evidence instances,
 * and the PR section that shows how each attempt went.
 *
 * The agent is each side's own `agent` launcher (`writeLauncher`): Claude Code
 * in the side's workspace as the scenario's publisher, with the release's
 * Patchy skill and none of the developer's instructions, settings or
 * connectors. A trial runs it without a person: the task on stdin, `-p` with a
 * stream-json event stream, a turn budget and a time budget, no session saved
 * and no auto memory, so every trial starts fresh. Its commands run as the
 * developer, as the launcher's always do, so `patchy setup` is denied to it
 * and a task that asks for setup is refused.
 *
 * Only a filtered log is kept from the stream: whether the agent finished and
 * its final answer in brief, each tool call (a command with its exit code), a
 * line per failure, and the counts. Its reasoning, what its commands printed
 * and the stream itself are never written.
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layoutFor, StepUnavailable } from "./environment.js";
import type { Side } from "./evidence.js";
import { sectionKey } from "./publish.js";
import type { Sanitizer } from "./sanitize.js";
import { stepOutput } from "./steps.js";
import {
  escapeHtml,
  fenced,
  normalize,
  type Placeholders,
  refusal,
  sideShell
} from "./transcript.js";

export class TaskRefused extends Schema.TaggedError<TaskRefused>()("TaskRefused", {
  what: Schema.String
}) {
  override get message() {
    return `The task asks for ${this.what}, which writes to your own machine: the agent's commands run as you, with your HOME, and \`pnpm dev down\` undoes none of it. Give it a task for a Patchy user who has already set up.`;
  }
}

export class NoClaude extends Schema.TaggedError<NoClaude>()("NoClaude", {}) {
  override get message() {
    return "A trial runs Claude Code, and `claude --version` failed. Install it and sign in, then run again.";
  }
}

export class OldLauncher extends Schema.TaggedError<OldLauncher>()("OldLauncher", {
  side: Schema.String
}) {
  override get message() {
    return `The ${this.side} instance's agent launcher predates the one that keeps your own instruction files out of its context.`;
  }
}

/** Why a task can't be given to the agent, if it can't: it asks for setup, which writes to the developer's machine. */
export const taskRefusal = (task: string) =>
  /\bllms\.txt\b/i.test(task)
    ? "the portal's setup line"
    : /\bpatchy\s+setup\b/i.test(task)
      ? "`patchy setup`"
      : refusal(task);

/** Fails before any instance starts when Claude Code isn't installed. */
export const checkClaude = Effect.fn("Trial.checkClaude")(function* (root: string) {
  yield* stepOutput("Checking Claude Code", "claude", ["--version"], {
    cwd: root,
    prefix: "claude"
  }).pipe(Effect.mapError(() => new NoClaude()));
});

/** What Claude Code needs to stay signed in, passed when set. HOME, which holds its login, already is. */
const SIGN_IN = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Where a side's agent runs: the side's shell (its workspace and the runner's
 * closed environment, as transcript lines get) and its launcher. On top go
 * only Claude Code's sign-in and auto memory turned off, so a trial neither
 * reads nor leaves memories for the next. A launcher from before #701 would
 * load the developer's own instruction files, so it fails here.
 */
export const agentShell = Effect.fn("Trial.agentShell")(function* (root: string, side: Side) {
  const fs = yield* FileSystem.FileSystem;
  const shell = yield* sideShell(root, side);
  const launcher = (yield* layoutFor(side.clone)).agent;
  const script = yield* fs.readFileString(launcher).pipe(Effect.orElseSucceed(() => ""));
  if (!script.includes("claudeMdExcludes")) return yield* new OldLauncher({ side: side.name });
  const env: Record<string, string> = { ...shell.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  for (const name of SIGN_IN) {
    const value = yield* Config.option(Config.String(name));
    if (Option.isSome(value) && value.value !== "") env[name] = value.value;
  }
  return { ...shell, env, launcher };
});
export type AgentShell = Effect.Success<ReturnType<typeof agentShell>>;

/** Denied to the agent on top of the launcher's own rules: setup and global installs, in their plain forms. */
const DENIED = ["Bash(patchy setup:*)", "Bash(pnpm add -g:*)", "Bash(pnpm add --global:*)"];

/**
 * What a trial passes the launcher, ahead of the launcher's own flags. The
 * task goes on stdin, so nothing in it can read as a flag.
 */
export const agentArgs = (input: { readonly model: string; readonly maxTurns: number }) => [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--model",
  input.model,
  "--max-turns",
  String(input.maxTurns),
  "--no-session-persistence",
  "--disallowedTools",
  ...DENIED
];

// ---- The filtered log ---------------------------------------------------------

/** One tool call the agent made. */
export const Step = Schema.Struct({
  /** `Bash` for a command; otherwise the tool, such as `Read` or `Skill`. */
  tool: Schema.String,
  /** The command, or what the tool was pointed at: a file, a skill, a pattern. */
  input: Schema.String,
  /** `unfinished` when the run ended before the call returned. */
  outcome: Schema.Literals(["ok", "failed", "denied", "unfinished"]),
  /** A command's exit code; null for other tools and for a command without one. */
  exitCode: Schema.NullOr(Schema.Int),
  /** One line saying why it failed or was denied. */
  error: Schema.NullOr(Schema.String)
});
export type Step = typeof Step.Type;

/** How one side's agent did. */
export const Attempt = Schema.Struct({
  /**
   * `finished` when it ended its turn on its own; `failed` when Claude Code
   * reported an error; `no-answer` when it exited without a result.
   */
  ending: Schema.Literals(["finished", "out-of-turns", "timed-out", "failed", "no-answer"]),
  /** What went wrong, for `failed` and `no-answer`. */
  detail: Schema.NullOr(Schema.String),
  /** Its final answer in a sentence or two, when it finished. */
  answer: Schema.NullOr(Schema.String),
  steps: Schema.Array(Step),
  seconds: Schema.Number,
  turns: Schema.NullOr(Schema.Int),
  /** What the run would cost at API prices, as Claude Code reports it. */
  costUsd: Schema.NullOr(Schema.Number),
  /** The model Claude Code ran, as it reported it. */
  model: Schema.NullOr(Schema.String),
  /** Whether Claude Code listed the Patchy skill as loaded; null when it never said. */
  patchySkill: Schema.NullOr(Schema.Boolean)
});
export type Attempt = typeof Attempt.Type;

const Content = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool_use"),
    id: Schema.String,
    name: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown)
  }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    tool_use_id: Schema.String,
    is_error: Schema.optional(Schema.Boolean),
    content: Schema.optional(
      Schema.Union([
        Schema.String,
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))
      ])
    )
  })
]);
const decodeContent = Schema.decodeUnknownOption(Content);

/** The events of Claude Code's stream-json the log reads; every other line is skipped. */
const Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("init"),
    model: Schema.String,
    skills: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)))
  }),
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("permission_denied"),
    tool_use_id: Schema.String,
    message: Schema.String
  }),
  Schema.Struct({
    type: Schema.Literals(["assistant", "user"]),
    message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]) })
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: Schema.String,
    is_error: Schema.Boolean,
    result: Schema.optional(Schema.NullOr(Schema.String)),
    /** Why a run that didn't succeed failed, as Claude Code says it. */
    errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    num_turns: Schema.optional(Schema.NullOr(Schema.Number)),
    total_cost_usd: Schema.optional(Schema.NullOr(Schema.Number)),
    permission_denials: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.Struct({ tool_use_id: Schema.String })))
    )
  })
]);
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(Event));

/** The input field that names what a tool call was about, in the order they are tried. */
const TARGETS = ["command", "skill", "file_path", "pattern", "url", "query", "description", "path"];

const MAX_LINE = 200;
const cut = (text: string, max = MAX_LINE) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Lines that read as an error, preferred over the last line when picking a failure's one line. */
const ERRORISH =
  /error|unknown|unrecognized|not found|no such|invalid|denied|refused|failed|cannot|can't|missing|expected/i;

/**
 * A failure's one line: the last line that reads as an error, or else the
 * last line, since a CLI prints its error after any usage it shows.
 */
export const errorLine = (text: string) => {
  const lines = text
    .replace(/<\/?tool_use_error>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return [...lines].reverse().find((candidate) => ERRORISH.test(candidate)) ?? lines.at(-1) ?? null;
};

const FENCE = /^(`{3,}|~{3,})/;

/**
 * A final answer in a sentence or two: its prose without headings, code
 * blocks or tables, as one line, cut after the second sentence (a colon ends
 * one too) or at 300 characters.
 */
export const gist = (text: string) => {
  const prose: Array<string> = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === "" || line.startsWith("|") || line.startsWith("#")) continue;
    prose.push(line.replace(/^(?:[-*>]|\d+[.)])\s+/, ""));
  }
  const joined = prose.join(" ").replace(/\s+/g, " ").trim();
  if (joined === "") {
    const first = text
      .split("\n")
      .map((raw) => raw.trim())
      .find((each) => each !== "" && !FENCE.test(each));
    return cut(first ?? "", 300);
  }
  return cut(
    joined
      .split(/(?<=[.!?:])\s+(?=[A-Z0-9`"'([*])/)
      .slice(0, 2)
      .join(" "),
    300
  );
};

/**
 * A command that asks for help rather than doing the task: `--help`
 * anywhere, `-h` to patchy, `help` to patchy or a package manager, or `man`.
 */
const HELP =
  /(?:^|\s)--help(?=$|[\s;&|)])|\bpatchy\b[^|;&]*\s-h(?=$|[\s;&|)])|\b(?:patchy|pnpm|npm|npx)\s+help\b|(?:^|[\s;&|(])man\s+\S/;
export const isHelpLookup = (command: string) => HELP.test(command);

/** How the agent's process ended. */
export interface Ended {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly seconds: number;
  /** The tail of what Claude Code wrote to stderr. */
  readonly stderr: string;
}

/**
 * Reads the stream a line at a time: `add` takes one line and returns the
 * tool calls it completed, and `attempt` is the log once the process ended.
 * Lines it doesn't know, and the parts of a message that aren't tool calls
 * (the agent's text and thinking), are dropped as they arrive. Its strings
 * are whole and raw, the answer too: `cleanAttempt` redacts them before
 * anything cuts them, so a cut never splits a secret or a path.
 */
export const makeTally = () => {
  let model: string | null = null;
  let patchySkill: boolean | null = null;
  let result: Extract<typeof Event.Type, { readonly type: "result" }> | null = null;
  const steps = new Map<string, Step>();
  const denied = new Map<string, string>();
  return {
    add: (line: string): ReadonlyArray<Step> => {
      const decoded = decodeEvent(line);
      if (Option.isNone(decoded)) return [];
      const event = decoded.value;
      if (event.type === "system") {
        if (event.subtype === "init") {
          model = event.model;
          patchySkill = event.skills == null ? null : event.skills.includes("patchy");
        } else denied.set(event.tool_use_id, event.message);
        return [];
      }
      if (event.type === "result") {
        result = event;
        return [];
      }
      if (typeof event.message.content === "string") return [];
      const done: Array<Step> = [];
      for (const part of event.message.content) {
        const content = decodeContent(part);
        if (Option.isNone(content)) continue;
        const block = content.value;
        if (block.type === "tool_use") {
          const target = TARGETS.map((key) => block.input[key]).find(
            (value): value is string => typeof value === "string" && value !== ""
          );
          steps.set(block.id, {
            tool: block.name,
            input: target ?? "",
            outcome: "unfinished",
            exitCode: null,
            error: null
          });
          continue;
        }
        const step = steps.get(block.tool_use_id);
        if (step === undefined) continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).flatMap((piece) => piece.text ?? []).join("\n");
        const denial = denied.get(block.tool_use_id);
        const code = /^\s*Exit code (\d+)/.exec(text);
        const finished: Step =
          denial !== undefined
            ? { ...step, outcome: "denied", error: errorLine(denial) }
            : block.is_error !== true
              ? { ...step, outcome: "ok", exitCode: step.tool === "Bash" ? 0 : null }
              : {
                  ...step,
                  outcome: "failed",
                  exitCode: code === null ? null : Number(code[1]),
                  error: errorLine(code === null ? text : text.slice(code[0].length))
                };
        steps.set(block.tool_use_id, finished);
        done.push(finished);
      }
      return done;
    },
    attempt: (ended: Ended): Attempt => {
      const end = result;
      const deniedAtEnd = new Set((end?.permission_denials ?? []).map((d) => d.tool_use_id));
      const logged = [...steps].map(([id, step]) =>
        deniedAtEnd.has(id) && step.outcome !== "denied"
          ? { ...step, outcome: "denied" as const, exitCode: null }
          : step
      );
      const common = {
        steps: logged,
        seconds: ended.seconds,
        turns: end?.num_turns == null ? null : Math.round(end.num_turns),
        costUsd: end?.total_cost_usd ?? null,
        model,
        patchySkill
      };
      if (end === null) {
        if (ended.timedOut) return { ...common, ending: "timed-out", detail: null, answer: null };
        const why = errorLine(ended.stderr);
        return {
          ...common,
          ending: "no-answer",
          detail: `Claude Code ${ended.exitCode === null ? "was ended by a signal" : `exited ${ended.exitCode}`} without a result${why === null ? "." : `: ${why}`}`,
          answer: null
        };
      }
      if (end.subtype === "success" && !end.is_error)
        return { ...common, ending: "finished", detail: null, answer: end.result ?? "" };
      if (end.subtype === "error_max_turns")
        return { ...common, ending: "out-of-turns", detail: null, answer: null };
      return {
        ...common,
        ending: "failed",
        detail: errorLine([...(end.errors ?? []), end.result ?? ""].join("\n")) ?? end.subtype,
        answer: null
      };
    }
  };
};

/**
 * A step's line in the log: a status column (a command's exit code, or the
 * tool's name), then the command's first line or the tool's target.
 */
const stepHead = (step: Step, width: number) => {
  const status =
    step.tool !== "Bash"
      ? step.tool.toLowerCase()
      : step.outcome === "denied"
        ? "denied"
        : step.exitCode !== null
          ? `exit ${step.exitCode}`
          : step.outcome === "unfinished"
            ? "running"
            : "failed";
  const [first = "", ...rest] = step.input.split("\n");
  const shown = `${cut(first)}${rest.length > 0 && first.length <= MAX_LINE ? " …" : ""}`;
  return `${status.padEnd(width)}  ${step.tool === "Bash" ? `$ ${shown}` : shown}`.trimEnd();
};

/** What the log says under a step that went wrong, if anything. */
const stepNote = (step: Step) => {
  if (step.outcome === "unfinished") return "didn't return before the run ended";
  if (step.outcome === "denied" && step.tool !== "Bash") return `denied: ${step.error ?? ""}`;
  return step.error;
};

/** The progress line a step prints as it completes, once cleaned. */
export const progressLine = (step: Step) => {
  const note = stepNote(step);
  return `${stepHead(step, 6)}${note === null ? "" : ` · ${note}`}`;
};

/** A step that went wrong: a command with a non-zero exit, a denial or a tool error. */
const failed = (step: Step) => step.outcome === "failed" || step.outcome === "denied";

/** The counts the section's table shows. */
export const counts = (attempt: Attempt) => ({
  commands: attempt.steps.filter((step) => step.tool === "Bash").length,
  failures: attempt.steps.filter(failed).length,
  helpLookups: attempt.steps.filter((step) => step.tool === "Bash" && isHelpLookup(step.input))
    .length
});

// ---- Running ------------------------------------------------------------------

const FORCE_KILL_AFTER = "2 seconds";
/** How much of Claude Code's stderr is kept, for the line saying why it gave no answer. */
const STDERR_TAIL = 4_000;

/**
 * Runs one side's agent on the task and reads its stream as it arrives. The
 * process leads its own group, so the time budget ends the agent and every
 * command it started. After each tool call completes, the sanitizer reads the
 * CLI state, before a later command can clear what it holds; progress goes to
 * stderr, each step cleaned. The attempt it returns is raw, for `cleanAttempt`.
 */
export const runAgent = Effect.fn("Trial.runAgent")(function* (input: {
  readonly shell: AgentShell;
  readonly task: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly timeout: Duration.Duration;
  readonly sanitizer: Sanitizer;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const started = yield* Clock.currentTimeMillis;
  const tally = makeTally();
  const prefix = `  ${input.shell.name.padEnd(6)}  `;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(input.shell.launcher, agentArgs(input), {
          cwd: input.shell.cwd,
          env: input.shell.env,
          extendEnv: false,
          stdin: Stream.make(new TextEncoder().encode(input.task)),
          forceKillAfter: FORCE_KILL_AFTER
        })
      );
      let stderr = "";
      const drained = yield* Effect.forkScoped(
        Effect.all(
          [
            handle.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.forEach(tally.add(line), (step) =>
                  input.sanitizer.collect.pipe(
                    Effect.andThen(cleanStep(step, input.sanitizer, input.shell.placeholders)),
                    Effect.flatMap((clean) => Console.error(`${prefix}${progressLine(clean)}`))
                  )
                )
              )
            ),
            handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  stderr = `${stderr}${chunk}`.slice(-STDERR_TAIL);
                })
              )
            )
          ],
          { concurrency: "unbounded" }
        )
      );
      const exit = yield* handle.exitCode.pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => null),
        Effect.timeoutOption(input.timeout)
      );
      const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
      if (Option.isNone(exit))
        yield* Effect.ignore(handle.kill({ forceKillAfter: FORCE_KILL_AFTER }));
      yield* Effect.ignore(Fiber.join(drained).pipe(Effect.timeoutOption("1 second")));
      yield* input.sanitizer.collect;
      return tally.attempt({
        exitCode: Option.getOrNull(exit),
        timedOut: Option.isNone(exit),
        seconds,
        stderr
      });
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(new StepUnavailable({ step: "Running the agent", cause }))
    })
  );
});

/**
 * A step with its strings redacted, then normalized: secrets first, while
 * each is still whole, then the side's origin and paths. Its error is cut to
 * one short line only then.
 */
export const cleanStep = Effect.fn("Trial.cleanStep")(function* (
  step: Step,
  sanitizer: Sanitizer,
  placeholders: Placeholders
) {
  const input = normalize(yield* sanitizer.redact(step.input), placeholders);
  const error =
    step.error === null ? null : cut(normalize(yield* sanitizer.redact(step.error), placeholders));
  return { ...step, input, error } satisfies Step;
});

/** An attempt as the section and `--json` show it: every string cleaned as a step's is, the answer cut to its gist. */
export const cleanAttempt = Effect.fn("Trial.cleanAttempt")(function* (
  attempt: Attempt,
  sanitizer: Sanitizer,
  placeholders: Placeholders
) {
  const clean = Effect.fn(function* (text: string | null) {
    return text === null ? null : normalize(yield* sanitizer.redact(text), placeholders);
  });
  const steps: Array<Step> = [];
  for (const step of attempt.steps) steps.push(yield* cleanStep(step, sanitizer, placeholders));
  const detail = yield* clean(attempt.detail);
  const answer = yield* clean(attempt.answer);
  return {
    ...attempt,
    detail: detail === null ? null : cut(detail),
    answer: answer === null ? null : gist(answer),
    steps
  } satisfies Attempt;
});

// ---- The section ----------------------------------------------------------------

/**
 * The section's key in the PR body: `--key`, or the task's first words,
 * redacted before it is slugged. The key is public in the section's markers,
 * and a slug's lowercasing could hide a secret from redaction afterwards.
 */
export const trialKey = Effect.fn("Trial.trialKey")(function* (
  task: string,
  key: Option.Option<string>,
  sanitizer: Sanitizer
) {
  const words = Option.getOrElse(key, () => task.trim().split(/\s+/).slice(0, 6).join(" "));
  return sectionKey(yield* sanitizer.redact(words));
});

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The table's Finished cell. */
const finishedCell = (attempt: Attempt, budget: Budget) => {
  switch (attempt.ending) {
    case "finished":
      return "Yes";
    case "out-of-turns":
      return `No, out of turns (${budget.maxTurns})`;
    case "timed-out":
      return `No, stopped at ${budget.minutes} min`;
    default:
      return `No: ${attempt.detail ?? "it failed"}`;
  }
};

const cell = (text: string) => escapeHtml(text).replaceAll("|", "\\|").replace(/\s+/g, " ");

/** What each side's agent was allowed. */
export interface Budget {
  readonly maxTurns: number;
  readonly minutes: number;
}

/** One side's filtered log, folded under a summary of its counts. */
const logMarkdown = (name: string, attempt: Attempt) => {
  const { commands, failures } = counts(attempt);
  const summary = `${name}'s log: ${plural(commands, "command")}, ${failures === 0 ? "no failures" : plural(failures, "failure")}`;
  if (attempt.steps.length === 0)
    return [
      `<details><summary>${summary}</summary>`,
      "",
      "It made no tool calls.",
      "",
      "</details>"
    ];
  const width = Math.max(
    6,
    ...attempt.steps.map((step) => (step.tool === "Bash" ? 6 : step.tool.length))
  );
  const lines = attempt.steps.flatMap((step) => {
    const note = stepNote(step);
    return [stepHead(step, width), ...(note === null ? [] : [`${" ".repeat(width + 2)}${note}`])];
  });
  return [
    `<details><summary>${summary}</summary>`,
    "",
    ...fenced("console", lines),
    "",
    "</details>"
  ];
};

const answerMarkdown = (name: string, attempt: Attempt) =>
  attempt.answer === null
    ? `**${name}** gave no answer.`
    : `**${name}** answered: “${escapeHtml(attempt.answer)}”`;

/**
 * The trial section: the task, where each side came from, how the agents ran,
 * a table of before against after, each answer, and each side's log folded.
 * `before` is null when only after ran.
 */
export const trialMarkdown = (input: {
  readonly name: string;
  readonly task: string;
  readonly provenance: ReadonlyArray<string>;
  readonly redaction: string;
  readonly model: string;
  readonly budget: Budget;
  readonly before: Attempt | null;
  readonly after: Attempt;
}) => {
  const sides: ReadonlyArray<readonly [string, Attempt]> = [
    ...(input.before === null ? [] : [["Before", input.before] as const]),
    ["After", input.after] as const
  ];
  const missingSkill = sides.flatMap(([name, attempt]) =>
    attempt.patchySkill === false ? [name.toLowerCase()] : []
  );
  const row = (label: string, value: (attempt: Attempt) => string) =>
    `| ${label} | ${sides.map(([, attempt]) => cell(value(attempt))).join(" | ")} |`;
  return [
    `#### Trial \`${input.name}\``,
    "",
    ...input.task.split("\n").map((line) => `> ${escapeHtml(line)}`),
    "",
    ...input.provenance,
    "",
    `Each side gave the task to a fresh agent: the environment's \`agent\` launcher, Claude Code on \`${input.model}\` as the scenario's publisher, with the release's Patchy skill and no personal instructions or settings, run without a person within ${plural(input.budget.maxTurns, "turn")} and ${plural(input.budget.minutes, "minute")}. ` +
      "The log keeps each tool call, commands with their exit codes, and one line per failure; not the agent's reasoning or what its commands printed. " +
      input.redaction,
    "",
    ...(missingSkill.length === 0
      ? []
      : [
          missingSkill.length === sides.length && sides.length > 1
            ? "Claude Code reported no Patchy skill on either side."
            : `Claude Code reported no Patchy skill for ${missingSkill.join(" or ")}.`,
          ""
        ]),
    "One run is a smell test, not a measurement.",
    "",
    `| | ${sides.map(([name]) => name).join(" | ")} |`,
    `| --- | ${sides.map(() => "---").join(" | ")} |`,
    row("Finished", (attempt) => finishedCell(attempt, input.budget)),
    row("Commands", (attempt) => String(counts(attempt).commands)),
    row("Failures", (attempt) => String(counts(attempt).failures)),
    row("Help lookups", (attempt) => String(counts(attempt).helpLookups)),
    row("Minutes", (attempt) => (attempt.seconds / 60).toFixed(1)),
    "",
    ...sides.flatMap(([name, attempt]) => [answerMarkdown(name, attempt), ""]),
    ...sides.flatMap(([name, attempt]) => [...logMarkdown(name, attempt), ""])
  ]
    .join("\n")
    .trim();
};
