import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeSanitizer } from "./sanitize.js";
import {
  type AgentShell,
  type Attempt,
  cleanAttempt,
  type Ended,
  gist,
  identities,
  isHelpLookup,
  makeTally,
  runAgent,
  taskRefusal,
  trialKey,
  trialMarkdown
} from "./trial.js";

/** One line of Claude Code's stream-json, in the shapes its 2.1 releases print. */
const line = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const init = line({
  type: "system",
  subtype: "init",
  model: "claude-sonnet-5-5",
  tools: ["Bash"],
  skills: ["debug", "patchy"]
});
const use = (id: string, name: string, input: Record<string, string>) =>
  line({
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "reasoning the log leaves out" },
        { type: "tool_use", id, name, input }
      ]
    }
  });
const result = (id: string, content: string, isError = false) =>
  line({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] }
  });
const ended: Ended = { exitCode: 0, timedOut: false, seconds: 90, stderr: "" };

describe("the filtered log", () => {
  it("keeps each tool call with its exit code and one line per failure, and drops the rest", () => {
    const tally = makeTally();
    const done = [
      init,
      line({ type: "rate_limit_event", rate_limit_info: {} }),
      "not json",
      use("1", "Bash", {
        command: "patchy logs new-business --limit 3",
        description: "Read the log"
      }),
      result(
        "1",
        'Exit code 1\nUSAGE\n  patchy <subcommand> [flags]\nUnknown subcommand "logs" for "patchy"\n\n  Did you mean this?\n    login',
        true
      ),
      use("2", "Skill", { skill: "patchy" }),
      result("2", "Launching skill: patchy"),
      use("3", "Read", { file_path: "/env/workspace/missing.md" }),
      result("3", "<tool_use_error>File does not exist.</tool_use_error>", true),
      use("4", "Bash", { command: "patchy --help" }),
      result("4", "DESCRIPTION\n  Build patch repos"),
      use("5", "Bash", { command: "curl http://x.localhost/api" }),
      line({
        type: "system",
        subtype: "permission_denied",
        tool_use_id: "5",
        message: "Permission to use Bash with command curl http://x.localhost/api has been denied."
      }),
      result(
        "5",
        "Permission to use Bash with command curl http://x.localhost/api has been denied.",
        true
      ),
      use("6", "Bash", { command: "cat <<'EOF' > notes.md\nlong\nEOF" }),
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 7,
        total_cost_usd: 0.12,
        result:
          "Here are the last three log lines of new-business:\n\n```\n12:00 sample.load success\n```\n\nThe latest is a sample load. All three succeeded. Ask if you want more."
      })
    ].flatMap((each) => tally.add(each));
    assert.deepStrictEqual(
      done.map((step) => step.tool),
      ["Bash", "Skill", "Read", "Bash", "Bash"]
    );
    assert.deepStrictEqual(tally.attempt(ended), {
      ending: "finished",
      detail: null,
      answer:
        "Here are the last three log lines of new-business:\n\n```\n12:00 sample.load success\n```\n\nThe latest is a sample load. All three succeeded. Ask if you want more.",
      steps: [
        {
          tool: "Bash",
          input: "patchy logs new-business --limit 3",
          outcome: "failed",
          exitCode: 1,
          error: 'Unknown subcommand "logs" for "patchy"'
        },
        { tool: "Skill", input: "patchy", outcome: "ok", exitCode: null, error: null },
        {
          tool: "Read",
          input: "/env/workspace/missing.md",
          outcome: "failed",
          exitCode: null,
          error: "File does not exist."
        },
        { tool: "Bash", input: "patchy --help", outcome: "ok", exitCode: 0, error: null },
        {
          tool: "Bash",
          input: "curl http://x.localhost/api",
          outcome: "denied",
          exitCode: null,
          error: "Permission to use Bash with command curl http://x.localhost/api has been denied."
        },
        {
          tool: "Bash",
          input: "cat <<'EOF' > notes.md\nlong\nEOF",
          outcome: "unfinished",
          exitCode: null,
          error: null
        }
      ],
      seconds: 90,
      turns: 7,
      costUsd: 0.12,
      model: "claude-sonnet-5-5",
      patchySkill: true
    });
  });

  it("says how a run that didn't finish ended", () => {
    const ending = (lines: ReadonlyArray<string>, end: Partial<Ended> = {}) => {
      const tally = makeTally();
      for (const each of lines) tally.add(each);
      const { ending, detail } = tally.attempt({ ...ended, ...end });
      return { ending, detail };
    };
    assert.deepStrictEqual(
      ending([
        init,
        line({ type: "result", subtype: "error_max_turns", is_error: true, result: null })
      ]),
      { ending: "out-of-turns", detail: null }
    );
    assert.deepStrictEqual(ending([init], { exitCode: null, timedOut: true }), {
      ending: "timed-out",
      detail: null
    });
    assert.deepStrictEqual(
      ending([
        line({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Not logged in · Please run /login"
        })
      ]),
      { ending: "failed", detail: "Not logged in · Please run /login" }
    );
    assert.deepStrictEqual(
      ending([
        line({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["OAuth token has expired. Please run /login"]
        })
      ]),
      { ending: "failed", detail: "OAuth token has expired. Please run /login" }
    );
    assert.deepStrictEqual(
      ending([], { exitCode: 1, stderr: "warming up\nError: no such model\n" }),
      {
        ending: "no-answer",
        detail: "Claude Code exited 1 without a result: Error: no such model"
      }
    );
  });

  it("keeps an answer to a sentence or two, without its code", () => {
    assert.strictEqual(
      gist(
        "Here are the last three log lines of new-business:\n\n```\n12:00 sample.load success\n```\n\nThe latest is a sample load. All three succeeded."
      ),
      "Here are the last three log lines of new-business: The latest is a sample load."
    );
    assert.strictEqual(
      gist("## Done\n\n- Published **kudos** at v2.\n- It took 3 s.\n- Nothing else changed."),
      "Published **kudos** at v2. It took 3 s."
    );
    assert.strictEqual(gist("```\nonly code\n```"), "only code");
    assert.strictEqual(gist("x".repeat(400)), `${"x".repeat(300)}…`);
  });

  it("counts asking for help, and nothing else", () => {
    const help = [
      "patchy --help",
      "patchy logs -h",
      "cd kudos && patchy publish --help",
      "pnpm help",
      "man patchy"
    ];
    const not = [
      "patchy logs --limit 3",
      "grep -h help notes.md",
      "patchy init helpdesk",
      "echo --helpful"
    ];
    assert.deepStrictEqual(help.map(isHelpLookup), Array(help.length).fill(true));
    assert.deepStrictEqual(not.map(isHelpLookup), Array(not.length).fill(false));
  });
});

describe("taskRefusal", () => {
  it("refuses a task that asks for setup, and nothing else", () => {
    assert.deepStrictEqual(
      [
        "Set up Patchy using http://x.localhost/llms.txt",
        "run patchy setup, then publish",
        "show me the last few log lines of new-business",
        "set up a new patch for kudos"
      ].map(taskRefusal),
      ["the portal's setup line", "`patchy setup`", null, null]
    );
  });
});

describe("trialMarkdown", () => {
  const attempt = (overrides: Partial<Attempt>): Attempt => ({
    ending: "finished",
    detail: null,
    answer: "Here are the last three lines.",
    steps: [],
    seconds: 30,
    turns: 4,
    costUsd: 0.05,
    model: "claude-sonnet-5-5",
    patchySkill: true,
    ...overrides
  });

  it("puts a table of before against after above each answer and each side's folded log", () => {
    const markdown = trialMarkdown({
      name: "show-me-the-last-few-log",
      task: "show me the last few log lines of <new-business>",
      provenance: ["Before is `aaaaaaa` (--base) and after is `bbbbbbb` (dev)."],
      redaction: "Nothing in it matched a collected secret.",
      model: "claude-sonnet-5-5",
      budget: { maxTurns: 30, minutes: 10 },
      before: attempt({
        ending: "out-of-turns",
        answer: null,
        seconds: 600,
        steps: [
          {
            tool: "Bash",
            input: "patchy logs ```` | head",
            outcome: "failed",
            exitCode: 1,
            error: 'Unknown subcommand "logs"'
          },
          { tool: "Bash", input: "patchy --help", outcome: "ok", exitCode: 0, error: null },
          {
            tool: "Read",
            input: "<env>/notes.md",
            outcome: "denied",
            exitCode: null,
            error: "Blocked."
          }
        ]
      }),
      after: attempt({
        steps: [
          { tool: "Bash", input: "patchy logs --limit 3", outcome: "ok", exitCode: 0, error: null }
        ]
      })
    });
    assert.include(markdown, "> show me the last few log lines of &lt;new-business&gt;");
    assert.include(
      markdown,
      [
        "One run is a smell test, not a measurement.",
        "",
        "| | Before | After |",
        "| --- | --- | --- |",
        "| Finished | No, out of turns (30) | Yes |",
        "| Commands | 2 | 1 |",
        "| Failures | 2 | 0 |",
        "| Help lookups | 1 | 0 |",
        "| Minutes | 10.0 | 0.5 |",
        "",
        "**Before** gave no answer.",
        "",
        "**After** answered: “Here are the last three lines.”",
        "",
        "<details><summary>Before's log: 2 commands, 2 failures</summary>",
        "",
        "`````console",
        "exit 1  $ patchy logs ```` | head",
        '        Unknown subcommand "logs"',
        "exit 0  $ patchy --help",
        "read    <env>/notes.md",
        "        denied: Blocked.",
        "`````",
        "",
        "</details>",
        "",
        "<details><summary>After's log: 1 command, no failures</summary>"
      ].join("\n")
    );
  });

  it("shows after alone when before couldn't run", () => {
    const markdown = trialMarkdown({
      name: "x",
      task: "x",
      provenance: [],
      redaction: "",
      model: "claude-sonnet-5-5",
      budget: { maxTurns: 30, minutes: 10 },
      before: null,
      after: attempt({
        ending: "failed",
        detail: "API error | overloaded",
        answer: null,
        patchySkill: false
      })
    });
    assert.include(
      markdown,
      "| | After |\n| --- | --- |\n| Finished | No: API error \\| overloaded |"
    );
    assert.include(markdown, "Claude Code reported no Patchy skill for after.");
    assert.notInclude(markdown, "Before");
  });

  it.effect("redacts the section's key before slugging it", () =>
    Effect.gen(function* () {
      const sanitizer = yield* makeSanitizer({
        stateDirs: [],
        envs: [{ PATCHY_API_TOKEN: "Secret-Value-123" }]
      });
      const keys = [
        yield* trialKey("Sign in with Secret-Value-123, then publish", Option.none(), sanitizer),
        yield* trialKey("x", Option.some("logs Secret-Value-123"), sanitizer)
      ];
      assert.deepStrictEqual(keys, ["sign-in-with-redacted-then-publish", "logs-redacted"]);
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("redacts and normalizes a long line before cutting it", () =>
    Effect.gen(function* () {
      const sanitizer = yield* makeSanitizer({
        stateDirs: [],
        envs: [{ PATCHY_API_TOKEN: "tok-secret-value" }]
      });
      // The token and the path both straddle the 200-character cut.
      const long = `${"x".repeat(190)} tok-secret-value /home/a/env/workspace`;
      const cleaned = yield* cleanAttempt(
        attempt({
          steps: [{ tool: "Bash", input: long, outcome: "failed", exitCode: 1, error: long }]
        }),
        sanitizer,
        [
          ["/home/a/env", "<env>"],
          ["/home/a", "~"]
        ]
      );
      const step = cleaned.steps[0]!;
      assert.strictEqual(step.input, `${"x".repeat(190)} [redacted] <env>/workspace`);
      assert.strictEqual(step.error, `${"x".repeat(190)} [redacted…`);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

// A stand-in launcher on the real clock: the test clock would never fire the time budget.
describe("runAgent", () => {
  const launcher = Effect.fn(function* (dir: string, body: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(dir, "agent");
    yield* fs.writeFileString(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    return file;
  });
  const shell = (dir: string, file: string): AgentShell => ({
    name: "after",
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", PATCHY_STATE_DIR: dir },
    state: dir,
    placeholders: [],
    launcher: file
  });

  it.live("reads the CLI state after each tool call, before a later one clears it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const sanitizer = yield* makeSanitizer({ stateDirs: [dir], envs: [] });
      const credentials = '"$PATCHY_STATE_DIR/credentials.json"';
      const file = yield* launcher(
        dir,
        [
          `[ "$(cat)" = "show me the log" ] || exit 7`,
          `echo '${init}'`,
          `echo '${use("1", "Bash", { command: "patchy login" })}'`,
          `echo '{"token":"short-lived"}' > ${credentials}`,
          `echo '${result("1", "Code: short-lived")}'`,
          "sleep 0.5",
          `rm ${credentials}`,
          `echo '${line({ type: "result", subtype: "success", is_error: false, result: "Logged in." })}'`
        ].join("\n")
      );
      const attempt = yield* runAgent({
        shell: shell(dir, file),
        task: "show me the log",
        model: "sonnet",
        maxTurns: 5,
        timeout: Duration.seconds(10),
        sanitizer
      });
      assert.strictEqual(attempt.ending, "finished");
      assert.strictEqual(yield* sanitizer.redact("Code: short-lived"), "Code: [redacted]");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("collects the Claude account and git author the agent acts as", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(dir, "claude"),
        `#!/usr/bin/env bash\necho '{"loggedIn":true,"email":"jane@company.com","orgName":"Patchy"}'\n`,
        { mode: 0o755 }
      );
      yield* fs.writeFileString(
        path.join(dir, ".gitconfig"),
        "[user]\n\temail = jane@home.example.org\n"
      );
      const found = yield* identities({
        ...shell(dir, path.join(dir, "agent")),
        env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }
      });
      assert.deepStrictEqual(found, ["jane@company.com", "jane@home.example.org"]);

      // A failing read gives nothing, and its stderr isn't passed on.
      yield* fs.writeFileString(
        path.join(dir, "claude"),
        `#!/usr/bin/env bash\necho 'Authentication failed for jane@company.com' >&2\nexit 1\n`,
        { mode: 0o755 }
      );
      const fallback = yield* identities({
        ...shell(dir, path.join(dir, "agent")),
        env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir }
      });
      assert.deepStrictEqual(fallback, ["jane@home.example.org"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("stops an agent past its time budget", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = yield* launcher(dir, `echo '${init}'\nsleep 30`);
      const attempt = yield* runAgent({
        shell: shell(dir, file),
        task: "x",
        model: "sonnet",
        maxTurns: 5,
        timeout: Duration.millis(300),
        sanitizer: yield* makeSanitizer({ stateDirs: [], envs: [] })
      });
      assert.deepStrictEqual([attempt.ending, attempt.model], ["timed-out", "claude-sonnet-5-5"]);
      assert.isBelow(attempt.seconds, 5);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
