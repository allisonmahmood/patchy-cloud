/**
 * The builders `pnpm dev eval` measures, each in its real harness, headless:
 * Claude Code with Sonnet 5.5 at high effort, and Codex with GPT-6.1 Terra at
 * high reasoning. Deliberately not the most capable settings: many people at
 * companies build with mid models or low effort, and skills those builders
 * can follow, stronger ones follow too.
 *
 * Each harness streams JSON events; an adapter per harness reduces them to one
 * log: each tool call with its outcome and any structured CLI refusal in its
 * output (read before anything is cut, since agents pipe the CLI through
 * `tail`, which hides its exit code), the final answer, usage, and how the run
 * ended. Reasoning text is not kept.
 */
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { StepUnavailable } from "../environment.js";
import { type ClaudeEvent, decodeContent, decodeEvent, errorLine } from "../trial.js";
import { bwrapArgs, type SandboxSpec } from "./sandbox.js";

/** A builder: a model at an effort, in its harness. */
export interface Builder {
  readonly id: string;
  readonly harness: "claude-code" | "codex";
  readonly model: string;
  readonly effort: string;
}

export const BUILDERS = {
  sonnet: { id: "sonnet", harness: "claude-code", model: "claude-sonnet-5-5", effort: "high" },
  terra: { id: "terra", harness: "codex", model: "gpt-6.1-terra", effort: "high" }
} as const satisfies Record<string, Builder>;
export type BuilderId = keyof typeof BUILDERS;
export const BUILDER_IDS = Object.keys(BUILDERS) as ReadonlyArray<BuilderId>;

/**
 * The harness's command inside the sandbox; the task always goes in on stdin,
 * so nothing in it reads as a flag. Both run with every permission: the
 * sandbox is the boundary.
 */
export const builderCommand = (builder: Builder): readonly [string, ReadonlyArray<string>] =>
  builder.harness === "claude-code"
    ? [
        "claude",
        [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          builder.model,
          "--effort",
          builder.effort,
          "--permission-mode",
          "bypassPermissions",
          "--no-session-persistence"
        ]
      ]
    : [
        "codex",
        [
          "exec",
          "--json",
          "-m",
          builder.model,
          "-c",
          `model_reasoning_effort=${builder.effort}`,
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
          // `-` reads the task from stdin; without it Codex waits on a non-TTY stdin anyway.
          "-"
        ]
      ];

// ---- The log ------------------------------------------------------------------

/** One tool call a builder made. */
export const Step = Schema.Struct({
  /** `Bash` for a command (Codex's too); otherwise the tool, such as `Read` or `Skill`. */
  tool: Schema.String,
  /** The command, or what the tool was pointed at: a file, a skill, a pattern. */
  input: Schema.String,
  /** `unfinished` when the run ended before the call returned. */
  outcome: Schema.Literals(["ok", "failed", "denied", "unfinished"]),
  exitCode: Schema.NullOr(Schema.Int),
  /** One line saying why it failed. */
  error: Schema.NullOr(Schema.String),
  /** Structured CLI refusals in its output: each `code`, or its `kind` when it has none. */
  refusals: Schema.Array(Schema.String)
});
export type Step = typeof Step.Type;

/** Tokens as the harness reports them; null where it reports none. */
export const Usage = Schema.Struct({
  input: Schema.NullOr(Schema.Number),
  cachedInput: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.Number),
  reasoning: Schema.NullOr(Schema.Number)
});
export type Usage = typeof Usage.Type;

/** How a builder's run went, as its harness told it. */
export const BuilderLog = Schema.Struct({
  /** `finished` when it ended its turn; `failed` when the harness reported an error; `no-answer` when it exited without a result. */
  ending: Schema.Literals(["finished", "timed-out", "failed", "no-answer"]),
  /** What went wrong, for `failed` and `no-answer`. */
  detail: Schema.NullOr(Schema.String),
  /** Its final answer, whole. */
  answer: Schema.NullOr(Schema.String),
  steps: Schema.Array(Step),
  seconds: Schema.Number,
  turns: Schema.NullOr(Schema.Int),
  usage: Usage,
  costUsd: Schema.NullOr(Schema.Number),
  /** The model the harness says it ran; Codex doesn't say, so it is the one asked for. */
  model: Schema.String
});
export type BuilderLog = typeof BuilderLog.Type;

const RefusalDoc = Schema.Struct({
  ok: Schema.Literal(false),
  code: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String)
});
const decodeRefusal = Schema.decodeUnknownOption(Schema.fromJsonString(RefusalDoc));

/**
 * The structured refusals in a command's output: each line that is a CLI
 * failure document (`{ "ok": false, … }`, ADR-0004), as its `code`, or its
 * `kind` when it carries no code.
 */
export const refusalsIn = (text: string): ReadonlyArray<string> =>
  text.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"ok":false')) return [];
    return Option.match(decodeRefusal(trimmed), {
      onNone: () => [],
      onSome: (doc) => ((doc.code ?? doc.kind) === undefined ? [] : [doc.code ?? doc.kind!])
    });
  });

/** How the harness's process ended. */
export interface Ended {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly seconds: number;
  /** The tail of what the harness wrote to stderr. */
  readonly stderr: string;
}

/** Reads a harness's stream a line at a time; `log` is the run once the process ended. */
export interface Tally {
  readonly add: (line: string) => ReadonlyArray<Step>;
  readonly log: (ended: Ended) => BuilderLog;
}

/** The input field that names what a tool call was about, in the order they are tried. */
const TARGETS = ["command", "skill", "file_path", "pattern", "url", "query", "description", "path"];

const unended = (ended: Ended, model: string, steps: ReadonlyArray<Step>, usage: Usage) => {
  const common = { steps, seconds: ended.seconds, turns: null, usage, costUsd: null, model };
  if (ended.timedOut)
    return { ...common, ending: "timed-out", detail: null, answer: null } as const;
  const why = errorLine(ended.stderr);
  return {
    ...common,
    ending: "no-answer",
    detail: `It ${ended.exitCode === null ? "was ended by a signal" : `exited ${ended.exitCode}`} without a result${why === null ? "." : `: ${why}`}`,
    answer: null
  } as const;
};

const NO_USAGE: Usage = { input: null, cachedInput: null, output: null, reasoning: null };

/** Claude Code's stream-json, read with the decoders `pnpm dev trial` uses. */
export const makeClaudeTally = (asked: string): Tally => {
  let model = asked;
  let result: Extract<ClaudeEvent, { readonly type: "result" }> | null = null;
  const steps = new Map<string, Step>();
  const denied = new Map<string, string>();
  return {
    add: (line) => {
      const decoded = decodeEvent(line);
      if (Option.isNone(decoded)) return [];
      const event = decoded.value;
      if (event.type === "system") {
        if (event.subtype === "init") model = event.model;
        else denied.set(event.tool_use_id, event.message);
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
          const named = (value: unknown): value is string =>
            typeof value === "string" && value !== "";
          const target = TARGETS.map((key) => block.input[key]).find(named);
          // A search keeps where it looked, so a grep through the package counts as one.
          const where = [block.input.path, block.input.glob]
            .filter(named)
            .filter((w) => w !== target);
          steps.set(block.id, {
            tool: block.name,
            input: [target ?? "", ...where].join(" ").trim(),
            outcome: "unfinished",
            exitCode: null,
            error: null,
            refusals: []
          });
          continue;
        }
        const step = steps.get(block.tool_use_id);
        if (step === undefined) continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).flatMap((piece) => piece.text ?? []).join("\n");
        const refusals = refusalsIn(text);
        const denial = denied.get(block.tool_use_id);
        const code = /^\s*Exit code (\d+)/.exec(text);
        const finished: Step =
          denial !== undefined
            ? { ...step, outcome: "denied", error: errorLine(denial), refusals }
            : block.is_error !== true
              ? { ...step, outcome: "ok", exitCode: step.tool === "Bash" ? 0 : null, refusals }
              : {
                  ...step,
                  outcome: "failed",
                  exitCode: code === null ? null : Number(code[1]),
                  error: errorLine(code === null ? text : text.slice(code[0].length)),
                  refusals
                };
        steps.set(block.tool_use_id, finished);
        done.push(finished);
      }
      return done;
    },
    log: (ended) => {
      const end = result;
      const logged = [...steps.values()];
      if (end === null) return unended(ended, model, logged, NO_USAGE);
      const usage: Usage = {
        input:
          end.usage == null
            ? null
            : (end.usage.input_tokens ?? 0) +
              (end.usage.cache_creation_input_tokens ?? 0) +
              (end.usage.cache_read_input_tokens ?? 0),
        cachedInput: end.usage?.cache_read_input_tokens ?? null,
        output: end.usage?.output_tokens ?? null,
        reasoning: null
      };
      const common = {
        steps: logged,
        seconds: ended.seconds,
        turns: end.num_turns == null ? null : Math.round(end.num_turns),
        usage,
        costUsd: end.total_cost_usd ?? null,
        model
      };
      if (end.subtype === "success" && !end.is_error)
        return { ...common, ending: "finished", detail: null, answer: end.result ?? "" };
      return {
        ...common,
        ending: "failed",
        detail: errorLine([...(end.errors ?? []), end.result ?? ""].join("\n")) ?? end.subtype,
        answer: null
      };
    }
  };
};

const CodexItem = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  command: Schema.optional(Schema.String),
  aggregated_output: Schema.optional(Schema.NullOr(Schema.String)),
  exit_code: Schema.optional(Schema.NullOr(Schema.Number)),
  status: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  changes: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
  server: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String)
});

const CodexCount = Schema.optional(Schema.NullOr(Schema.Number));
const CodexEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["item.started", "item.updated", "item.completed"]),
    item: CodexItem
  }),
  Schema.Struct({
    type: Schema.Literal("turn.completed"),
    usage: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          input_tokens: CodexCount,
          cached_input_tokens: CodexCount,
          output_tokens: CodexCount,
          reasoning_output_tokens: CodexCount
        })
      )
    )
  }),
  Schema.Struct({
    type: Schema.Literal("turn.failed"),
    error: Schema.optional(Schema.NullOr(Schema.Struct({ message: Schema.String })))
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String })
]);
const decodeCodexEvent = Schema.decodeUnknownOption(Schema.fromJsonString(CodexEvent));

/** Codex runs each command as `bash -lc '<command>'`; the log shows the command. */
export const unwrapShell = (command: string) => {
  const single = /^\S*bash -lc '([\s\S]*)'$/.exec(command);
  if (single !== null) return single[1]!.replaceAll(`'\\''`, "'");
  const double = /^\S*bash -lc "([\s\S]*)"$/.exec(command);
  if (double !== null) return double[1]!.replace(/\\(["\\$`])/g, "$1");
  return command;
};

/** Codex's `exec --json` events. It reports no turns or cost, so those stay null. */
export const makeCodexTally = (asked: string): Tally => {
  const steps = new Map<string, Step>();
  let answer: string | null = null;
  let completed = false;
  let failure: string | null = null;
  let usage: Usage = NO_USAGE;
  return {
    add: (line) => {
      const decoded = decodeCodexEvent(line);
      if (Option.isNone(decoded)) return [];
      const event = decoded.value;
      if (event.type === "turn.completed") {
        completed = true;
        if (event.usage != null)
          usage = {
            input: event.usage.input_tokens ?? null,
            cachedInput: event.usage.cached_input_tokens ?? null,
            output: event.usage.output_tokens ?? null,
            reasoning: event.usage.reasoning_output_tokens ?? null
          };
        return [];
      }
      if (event.type === "turn.failed") {
        failure = event.error?.message ?? "the turn failed";
        return [];
      }
      if (event.type === "error") {
        failure = event.message;
        return [];
      }
      const item = event.item;
      if (item.type === "agent_message") {
        if (event.type === "item.completed" && item.text !== undefined) answer = item.text;
        return [];
      }
      const step = ((): Step | null => {
        const base = { exitCode: null, error: null, refusals: [] };
        switch (item.type) {
          case "command_execution":
            return {
              ...base,
              tool: "Bash",
              input: unwrapShell(item.command ?? ""),
              outcome: "unfinished"
            };
          case "file_change":
            return {
              ...base,
              tool: "Edit",
              input: (item.changes ?? []).map((c) => c.path).join(", "),
              outcome: "unfinished"
            };
          case "mcp_tool_call":
            return {
              ...base,
              tool: `mcp:${item.server ?? ""}/${item.tool ?? ""}`,
              input: "",
              outcome: "unfinished"
            };
          case "web_search":
            return { ...base, tool: "WebSearch", input: item.query ?? "", outcome: "unfinished" };
          default:
            return null;
        }
      })();
      if (step === null) return [];
      if (event.type !== "item.completed") {
        if (!steps.has(item.id)) steps.set(item.id, step);
        return [];
      }
      const output = item.aggregated_output ?? "";
      const exitCode = item.exit_code ?? null;
      const failed = item.status === "failed" || (exitCode !== null && exitCode !== 0);
      const finished: Step = {
        ...step,
        outcome: failed ? "failed" : "ok",
        exitCode: exitCode === null ? null : Math.round(exitCode),
        error: failed ? errorLine(output) : null,
        refusals: refusalsIn(output)
      };
      steps.set(item.id, finished);
      return [finished];
    },
    log: (ended) => {
      const logged = [...steps.values()];
      if (completed)
        return {
          ending: "finished",
          detail: null,
          answer: answer ?? "",
          steps: logged,
          seconds: ended.seconds,
          turns: null,
          usage,
          costUsd: null,
          model: asked
        };
      if (failure !== null && !ended.timedOut)
        return {
          ending: "failed",
          detail: errorLine(failure) ?? failure,
          answer: null,
          steps: logged,
          seconds: ended.seconds,
          turns: null,
          usage,
          costUsd: null,
          model: asked
        };
      return unended(ended, asked, logged, usage);
    }
  };
};

export const makeTally = (builder: Builder): Tally =>
  builder.harness === "claude-code"
    ? makeClaudeTally(builder.model)
    : makeCodexTally(builder.model);

// ---- Running ------------------------------------------------------------------

const FORCE_KILL_AFTER = "2 seconds";
const STDERR_TAIL = 4_000;

/**
 * Runs a builder on `task` in its sandbox, within `timeout`, writing every
 * stream line to `record` as it arrives (the raw stream stays on this machine)
 * and each completed tool call to `onStep`. Killing the sandbox at the time
 * budget ends the harness and every command it started.
 */
export const runBuilder = Effect.fn("Eval.runBuilder")(function* (input: {
  readonly builder: Builder;
  readonly spec: SandboxSpec;
  readonly task: string;
  readonly timeout: Duration.Duration;
  readonly record: (line: string) => Effect.Effect<void>;
  readonly onStep: (step: Step) => Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const started = yield* Clock.currentTimeMillis;
  const tally = makeTally(input.builder);
  const [command, args] = builderCommand(input.builder);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("bwrap", [...bwrapArgs(input.spec, command, args)], {
          cwd: input.spec.home,
          env: { PATH: "/usr/bin:/bin" },
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
                input
                  .record(line)
                  .pipe(
                    Effect.andThen(Effect.forEach(tally.add(line), input.onStep, { discard: true }))
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
      yield* Effect.ignore(Fiber.join(drained).pipe(Effect.timeoutOption("2 seconds")));
      return tally.log({
        exitCode: Option.getOrNull(exit),
        timedOut: Option.isNone(exit),
        seconds,
        stderr
      });
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(new StepUnavailable({ step: "Running the builder", cause }))
    })
  );
});
