/**
 * `pnpm dev transcript`: a script of shell lines, run on both evidence
 * instances as each one's signed-in CLI, and the PR section that compares them.
 *
 * A script is a plain text file. Each non-blank line is a command, and a `#`
 * line captions the commands after it:
 *
 *   # A patch's log
 *   patchy logs kudos --json
 *   # Signing out
 *   patchy login && patchy logout
 *
 * Each line runs in its own non-interactive `bash -c`, stdin closed, from the
 * side's agent workspace, with the runner's closed environment: the side's
 * `bin` first on PATH and its `PATCHY_STATE_DIR` set, nothing else from the
 * developer's shell. Only files carry from one line to the next. A non-zero
 * exit is recorded and the script goes on; a line past its timeout is killed
 * and recorded as timed out.
 */
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { childEnv, layoutFor, StepUnavailable } from "./environment.js";
import type { Side } from "./evidence.js";
import type { Sanitizer } from "./sanitize.js";

export class NoScript extends Schema.TaggedError<NoScript>()("NoScript", { file: Schema.String }) {
  override get message() {
    return `There is no script at ${this.file}.`;
  }
}

export class NoCommands extends Schema.TaggedError<NoCommands>()("NoCommands", {
  file: Schema.String
}) {
  override get message() {
    return `${this.file} has no commands. Each non-blank line that doesn't start with # is one.`;
  }
}

export class ScriptRefused extends Schema.TaggedError<ScriptRefused>()("ScriptRefused", {
  line: Schema.Int,
  what: Schema.String
}) {
  override get message() {
    return `Line ${this.line} runs ${this.what}, which writes to your own machine: lines run as you, with your HOME, and \`pnpm dev down\` undoes none of it. Remove it.`;
  }
}

export class NoWorkspace extends Schema.TaggedError<NoWorkspace>()("NoWorkspace", {
  side: Schema.String
}) {
  override get message() {
    return `The ${this.side} instance has no agent workspace and CLI where this checkout looks for them.`;
  }
}

/** One command of a script, with the caption above it and its line in the file. */
export interface ScriptLine {
  readonly line: number;
  readonly caption: string | null;
  readonly command: string;
}

/**
 * The agent workspace's rules: what a line must never run. `setup` counts as
 * patchy's subcommand after any of its global flags, as in `patchy --json
 * setup`, not as an argument. A global install is a flag anywhere up to the
 * next `|`, `;` or `&`. A guard against the plain forms, not a sandbox.
 */
const REFUSED: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\bpatchy(?:\s+(?:--(?:api-url|log-level|completions)(?:=|\s+)\S+|-{1,2}[\w-]+(?:=\S+)?))*\s+setup(?=$|[\s|;&])/,
    "`patchy setup`"
  ],
  [
    /\b(?:npm|pnpm|yarn|bun)\b[^|;&]*\s(?:-(?!-)[A-Za-z]*g[A-Za-z]*(?=\s|$)|--global\b|--location[=\s]global\b)|\byarn\s+global\s/,
    "a global install"
  ]
];

/** A script's commands, each under the last caption above it; a `#!` line is skipped. */
export const parseScript = (text: string): ReadonlyArray<ScriptLine> => {
  const lines: Array<ScriptLine> = [];
  let caption: string | null = null;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const command = raw.trim();
    if (command === "" || command.startsWith("#!")) continue;
    if (command.startsWith("#")) {
      caption = command.replace(/^#+\s*/, "") || null;
      continue;
    }
    lines.push({ line: index + 1, caption, command });
  }
  return lines;
};

/** What a line runs that the workspace's rules refuse, if anything. */
export const refusal = (command: string) =>
  REFUSED.find(([pattern]) => pattern.test(command))?.[1] ?? null;

/** The script at `file`, refused before anything starts when it is empty or breaks the workspace's rules. */
export const loadScript = Effect.fn("Transcript.loadScript")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.catchTags({ PlatformError: () => Effect.fail(new NoScript({ file })) }));
  const lines = parseScript(text);
  if (lines.length === 0) return yield* new NoCommands({ file });
  for (const { line, command } of lines) {
    const what = refusal(command);
    if (what !== null) return yield* new ScriptRefused({ line, what });
  }
  return lines;
});

/** What one line did on one side. */
export const Run = Schema.Struct({
  /** Null when it timed out or a signal ended it. */
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  seconds: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String
});
export type Run = typeof Run.Type;

const FORCE_KILL_AFTER = "2 seconds";

/**
 * Runs `command` in `bash -c` and records it. The line leads its own process
 * group: a timeout ends the whole group, and what it left running in the
 * background is ended when it exits. Such a process can hold the output
 * open, so the output gets a second after the exit to finish.
 */
export const runLine = Effect.fn("Transcript.runLine")(function* (
  command: string,
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeout: Duration.Duration;
  }
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const started = yield* Clock.currentTimeMillis;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("bash", ["-c", command], {
          cwd: options.cwd,
          env: options.env,
          extendEnv: false,
          stdin: "ignore",
          // Ending the group, here or when the scope closes, kills what ignores SIGTERM.
          forceKillAfter: FORCE_KILL_AFTER
        })
      );
      const stdout: Array<string> = [];
      const stderr: Array<string> = [];
      const drained = yield* Effect.forkScoped(
        Effect.all(
          [
            handle.stdout.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) => Effect.sync(() => stdout.push(chunk)))
            ),
            handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) => Effect.sync(() => stderr.push(chunk)))
            )
          ],
          { concurrency: "unbounded" }
        )
      );
      const exit = yield* handle.exitCode.pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => null),
        Effect.timeoutOption(options.timeout)
      );
      const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
      if (Option.isNone(exit))
        yield* Effect.ignore(handle.kill({ forceKillAfter: FORCE_KILL_AFTER }));
      yield* Effect.ignore(Fiber.join(drained).pipe(Effect.timeoutOption("1 second")));
      return {
        exitCode: Option.getOrNull(exit),
        timedOut: Option.isNone(exit),
        seconds,
        stdout: stdout.join(""),
        stderr: stderr.join("")
      } satisfies Run;
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new StepUnavailable({ step: "Running a line", cause }))
    })
  );
});

/** How a run ended, as the section and the progress lines say it. */
export const ending = (run: Run) => {
  const seconds = `${run.seconds.toFixed(1)} s`;
  if (run.timedOut) return `timed out after ${seconds}`;
  if (run.exitCode === null) return `ended by a signal after ${seconds}`;
  return `exit ${run.exitCode} in ${seconds}`;
};

/**
 * Where a side's lines run: its agent workspace, with the runner's closed
 * environment. PATH drops this worktree's own folders, which `pnpm dev` put
 * first. Also what normalizing replaces on that side: its origin, its
 * environment folder, its checkout and the home folder, each also as resolved
 * past symlinks, under HOME in its `~/…` form, and HOME as `~<user>`, as an
 * agent may write them. The folder is
 * found by this checkout's rules; a side whose runner kept it elsewhere fails
 * here, before a line runs where the sanitizer can't read its CLI state.
 */
export const sideShell = Effect.fn("Transcript.sideShell")(function* (root: string, side: Side) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = yield* layoutFor(side.clone);
  for (const needed of [layout.workspace, layout.state, path.join(layout.bin, "patchy")])
    if (!(yield* fs.exists(needed))) return yield* new NoWorkspace({ side: side.name });
  const env = yield* childEnv(layout);
  const delimiter = process.platform === "win32" ? ";" : ":";
  const PATH = env.PATH.split(delimiter)
    .filter((dir) => dir !== "" && !path.resolve(dir).startsWith(`${root}${path.sep}`))
    .join(delimiter);
  // Each folder as given and as resolved past symlinks, which is how an agent's tools see it.
  const both = (dir: string) =>
    fs.realPath(dir).pipe(
      Effect.map((real) => [...new Set([dir, real])]),
      Effect.orElseSucceed(() => [dir])
    );
  const homes = yield* both(yield* Config.String("HOME"));
  // `~<user>` names the same folder as `~`.
  const tildes = ["~", `~${path.basename(homes[0]!)}`];
  const folders: Array<readonly [string, string]> = [];
  for (const [dir, placeholder] of [
    [layout.dir, "<env>"],
    [side.clone, "<checkout>"]
  ] as const)
    for (const form of yield* both(dir)) folders.push([form, placeholder]);
  const placeholders: Placeholders = [
    [new URL(side.served.apiUrl).origin, "<origin>"],
    ...folders,
    ...folders.flatMap(([dir, placeholder]) =>
      homes
        .filter((home) => dir.startsWith(`${home}${path.sep}`))
        .flatMap((home) =>
          tildes.map((tilde) => [`${tilde}${dir.slice(home.length)}`, placeholder] as const)
        )
    ),
    ...homes.map((home) => [home, "~"] as const),
    [tildes[1]!, "~"]
  ];
  return {
    name: side.name,
    cwd: layout.workspace,
    env: { ...env, PATH },
    state: layout.state,
    placeholders
  };
});
export type SideShell = Effect.Success<ReturnType<typeof sideShell>>;

/**
 * Runs every line on one side, in order. The sanitizer reads the CLI state
 * while each line runs and again after it, before a later line can clear what
 * it holds. Progress goes to stderr, each command redacted, never its output.
 */
export const runScript = Effect.fn("Transcript.runScript")(function* (input: {
  readonly shell: SideShell;
  readonly lines: ReadonlyArray<ScriptLine>;
  readonly timeout: Duration.Duration;
  readonly sanitizer: Sanitizer;
}) {
  const runs: Array<Run> = [];
  for (const line of input.lines) {
    // A line can make a secret and clear it, as `patchy login && patchy logout` does;
    // reading every 100ms while it runs narrows that window.
    const run = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Effect.ignore(input.sanitizer.collect).pipe(Effect.repeat(Schedule.spaced("100 millis")))
        );
        return yield* runLine(line.command, { ...input.shell, timeout: input.timeout });
      })
    );
    yield* input.sanitizer.collect;
    yield* Console.error(
      `  ${input.shell.name.padEnd(6)}  ${yield* input.sanitizer.redact(`$ ${line.command}`)}  (${ending(run)})`
    );
    runs.push(run);
  }
  return runs;
});

// ---- Comparing ----------------------------------------------------------------

/** Values to replace and what replaces them. */
export type Placeholders = ReadonlyArray<readonly [value: string, placeholder: string]>;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with each side-specific value replaced, longest first so a path
 * inside another goes whole. A value only matches where it ends: `/home/a`
 * leaves `/home/ab` and `/home/a.bak` alone, but not a sentence's full stop.
 */
export const normalize = (text: string, placeholders: Placeholders) =>
  [...placeholders]
    .filter(([value]) => value !== "")
    .sort(([a], [b]) => b.length - a.length)
    .reduce(
      (result, [value, placeholder]) =>
        result.replace(new RegExp(`${escapeRegExp(value)}(?![\\w-]|\\.\\w)`, "g"), placeholder),
      text
    );

/** A run as the section shows it: stdout, then stderr under a `[stderr]` line. */
export const view = (run: Run) => {
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  return [...lines(run.stdout), ...(run.stderr === "" ? [] : ["[stderr]", ...lines(run.stderr)])];
};

const same = (a: Run, b: Run) =>
  a.exitCode === b.exitCode &&
  a.timedOut === b.timedOut &&
  a.stdout === b.stdout &&
  a.stderr === b.stderr;

export interface DiffLine {
  readonly mark: " " | "-" | "+";
  readonly text: string;
}

/** A line diff from `before` to `after`, through their longest common subsequence. */
export const diffLines = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>
): ReadonlyArray<DiffLine> => {
  const width = after.length + 1;
  // common[i * width + j]: how many lines before[i..] and after[j..] share, in order.
  const common = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      common[i * width + j] =
        before[i] === after[j]
          ? common[(i + 1) * width + j + 1]! + 1
          : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
  const diff: Array<DiffLine> = [];
  let [i, j] = [0, 0];
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      diff.push({ mark: " ", text: after[j]! });
      i++;
      j++;
    } else if (
      j === after.length ||
      (i < before.length && common[(i + 1) * width + j]! >= common[i * width + j + 1]!)
    )
      diff.push({ mark: "-", text: before[i++]! });
    else diff.push({ mark: "+", text: after[j++]! });
  }
  return diff;
};

/** The diff's changes with two lines of context, each run of unchanged lines between them counted in an `@@` line. */
export const hunks = (diff: ReadonlyArray<DiffLine>, context = 2) => {
  const changed = diff.flatMap((line, index) => (line.mark === " " ? [] : [index]));
  const near = (index: number) => changed.some((at) => Math.abs(at - index) <= context);
  const lines: Array<string> = [];
  let skipped = 0;
  const flush = () => {
    if (skipped > 0) lines.push(`@@ ${skipped} unchanged line${skipped === 1 ? "" : "s"} @@`);
    skipped = 0;
  };
  for (const [index, line] of diff.entries()) {
    if (!near(index)) {
      skipped++;
      continue;
    }
    flush();
    lines.push(`${line.mark}${line.text}`);
  }
  flush();
  return lines;
};

// ---- The section ---------------------------------------------------------------

/**
 * A block shows at most this many lines: the first and the last, since an
 * error often comes last. Each line is cut at this many characters.
 */
const HEAD_LINES = 20;
const TAIL_LINES = 10;
const MAX_LINE_CHARS = 400;
/** Outputs longer than this are compared on their first lines only. */
const MAX_COMPARED_LINES = 1_000;

/** `lines` in a fenced block that no backtick run inside can close. */
export const fenced = (language: string, lines: ReadonlyArray<string>) => {
  const longest = Math.max(
    0,
    ...lines.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length)
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${language}`, ...lines, fence];
};

/**
 * `lines` fenced and cut to size: the middle of a long block becomes one line
 * saying how many were cut, an `@@` line in a diff, and a note below says so.
 */
const block = (language: "console" | "diff", lines: ReadonlyArray<string>) => {
  const cut = lines.length - HEAD_LINES - TAIL_LINES;
  const kept =
    cut <= 0
      ? lines
      : [
          ...lines.slice(0, HEAD_LINES),
          language === "diff" ? `@@ ${cut} lines cut @@` : `… ${cut} lines cut …`,
          ...lines.slice(-TAIL_LINES)
        ];
  const long = kept.some((line) => line.length > MAX_LINE_CHARS);
  const shown = kept.map((line) =>
    line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
  );
  const notes = [
    ...(cut > 0 ? [`${cut} of ${lines.length} lines are cut from the middle.`] : []),
    ...(long ? [`Lines are cut at ${MAX_LINE_CHARS} characters.`] : [])
  ];
  return [
    ...fenced(language, shown),
    ...(notes.length === 0 ? [] : ["", `_${notes.join(" ")} \`--json\` has it all._`])
  ];
};

export const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** One line of the script, both sides of it already redacted and normalized. `before` is null when only after ran. */
export interface Compared {
  readonly caption: string | null;
  readonly command: string;
  readonly before: Run | null;
  readonly after: Run;
}

const capitalize = (text: string) => `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;

/**
 * One line in the section. A changed line shows after's output and the diff
 * from before; a line with no change folds into one summary line, its output
 * a click away; with no before, after's output stands alone.
 */
const lineMarkdown = (line: Compared): ReadonlyArray<string> => {
  const after = view(line.after);
  const transcript = block("console", [`$ ${line.command}`, ...after]);
  if (line.before === null) return [`${capitalize(ending(line.after))}.`, "", ...transcript];
  if (same(line.before, line.after)) {
    const command = line.command.length > 100 ? `${line.command.slice(0, 100)}…` : line.command;
    return [
      `<details><summary><code>$ ${escapeHtml(command)}</code>: no change, ${ending(line.after)}</summary>`,
      "",
      ...transcript,
      "",
      "</details>"
    ];
  }
  const before = view(line.before);
  const diff = diffLines(before.slice(0, MAX_COMPARED_LINES), after.slice(0, MAX_COMPARED_LINES));
  const changes = diff.some((part) => part.mark !== " ");
  const longer = before.length > MAX_COMPARED_LINES || after.length > MAX_COMPARED_LINES;
  return [
    `**Changed.** Before, ${ending(line.before)}; after, ${ending(line.after)}.`,
    "",
    ...transcript,
    "",
    ...(changes ? block("diff", hunks(diff)) : longer ? [] : ["The output is the same."]),
    ...(longer
      ? [
          ...(changes ? [""] : []),
          `_Only the first ${MAX_COMPARED_LINES} lines of each side were compared; \`--json\` has them all._`
        ]
      : [])
  ];
};

/**
 * The transcript section: where each side came from, how lines ran, what was
 * normalized and redacted, then each line under its caption.
 */
export const transcriptMarkdown = (input: {
  readonly name: string;
  readonly provenance: ReadonlyArray<string>;
  readonly redaction: string;
  readonly lines: ReadonlyArray<Compared>;
}) => {
  const compared = input.lines.filter((line) => line.before !== null);
  const changed = compared.filter((line) => !same(line.before!, line.after)).length;
  const sections: Array<string> = [
    `#### Transcript \`${input.name}\``,
    "",
    ...input.provenance,
    "",
    "Each line ran in its own `bash -c` from the side's agent workspace, as the scenario's signed-in CLI, with stdin closed. " +
      "Each side's origin reads `<origin>`, its environment folder `<env>`, its checkout `<checkout>` and the home folder `~`; nothing else is normalized. " +
      input.redaction,
    "",
    ...(compared.length === 0
      ? []
      : [
          changed === 0
            ? "No line changed."
            : `${changed} of ${input.lines.length} line${input.lines.length === 1 ? "" : "s"} changed.`,
          ""
        ])
  ];
  let caption: string | null = null;
  for (const line of input.lines) {
    if (line.caption !== null && line.caption !== caption)
      sections.push(`##### ${line.caption}`, "");
    caption = line.caption;
    sections.push(...lineMarkdown(line), "");
  }
  return sections.join("\n").trim();
};
