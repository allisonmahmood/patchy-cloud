import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeSanitizer } from "./sanitize.js";
import {
  diffLines,
  hunks,
  loadScript,
  normalize,
  parseScript,
  refusal,
  type Run,
  runLine,
  runScript,
  transcriptMarkdown
} from "./transcript.js";

describe("parseScript", () => {
  it("captions each command with the last # line above it", () => {
    const lines = parseScript(
      "#!/usr/bin/env bash\npatchy whoami\n\n# A patch's log\n  patchy logs kudos --json  \n#\npatchy logout\n"
    );
    assert.deepStrictEqual(lines, [
      { line: 2, caption: null, command: "patchy whoami" },
      { line: 5, caption: "A patch's log", command: "patchy logs kudos --json" },
      { line: 7, caption: null, command: "patchy logout" }
    ]);
  });
});

describe("refusal", () => {
  it("refuses setting Patchy up and global installs, flags first or not, and nothing else", () => {
    const refused = [
      "patchy setup",
      "patchy --json setup",
      "patchy --api-url http://x.localhost:1 --log-level debug setup",
      "cd x && patchy setup --remove",
      "npm install -g patchy",
      "npm i --global patchy",
      "npm install --location=global patchy",
      "pnpm add -gD patchy",
      "yarn global add patchy"
    ];
    const allowed = [
      "patchy whoami; echo setup",
      "pnpm install",
      "npm test -- --grep x",
      "patchy logs --json | grep setup",
      "patchy init setup-demo --tier 2",
      "patchy publish setup.html",
      "npm install global-agent"
    ];
    assert.deepStrictEqual(refused.map(refusal), [
      ...Array(4).fill("`patchy setup`"),
      ...Array(5).fill("a global install")
    ]);
    assert.deepStrictEqual(allowed.map(refusal), Array(allowed.length).fill(null));
  });
});

it.layer(NodeServices.layer)("a script", (it) => {
  it.effect("is refused before anything starts with a refused line, or with no commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const failure = Effect.fn(function* (text: string) {
        const file = path.join(dir, "script.txt");
        yield* fs.writeFileString(file, text);
        return yield* Effect.flip(loadScript(file));
      });

      assert.include(
        (yield* failure("patchy whoami\npatchy setup --json")).message,
        "Line 2 runs `patchy setup`"
      );
      assert.include((yield* failure("# only a caption\n")).message, "has no commands.");
    })
  );
});

// Real processes on the real clock: the test clock would never fire the timeouts.
describe("runLine", () => {
  const options = (env: Record<string, string> = {}) => ({
    cwd: "/",
    env: { PATH: "/usr/bin:/bin", ...env },
    timeout: Duration.seconds(10)
  });

  it.live(
    "records exit code, stdout and stderr, with stdin closed and only the given variables",
    () =>
      Effect.gen(function* () {
        const run = yield* runLine(
          'cat; echo "out ${GIVEN:-unset} ${HOME:-no home}"; echo err >&2; exit 3',
          options({ GIVEN: "given" })
        );
        assert.strictEqual(run.exitCode, 3);
        assert.strictEqual(run.stdout, "out given no home\n");
        assert.strictEqual(run.stderr, "err\n");
        assert.isFalse(run.timedOut);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("redacts a secret a line wrote to the CLI state and cleared before it ended", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const sanitizer = yield* makeSanitizer({ stateDirs: [state], envs: [] });
      const file = '"$PATCHY_STATE_DIR/credentials.json"';
      const [run] = yield* runScript({
        shell: {
          name: "after",
          cwd: state,
          env: { PATH: "/usr/bin:/bin", PATCHY_STATE_DIR: state },
          state,
          placeholders: []
        },
        lines: [
          {
            line: 1,
            caption: null,
            command: `echo '{"token":"short-lived"}' > ${file} && sleep 0.5 && cat ${file} && rm ${file}`
          }
        ],
        timeout: Duration.seconds(10),
        sanitizer
      });
      assert.strictEqual(yield* sanitizer.redact(run!.stdout), '{"token":"[redacted]"}\n');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.live("kills a line past its timeout, and doesn't wait on what a line left running", () =>
    Effect.gen(function* () {
      const slow = yield* runLine("echo started; sleep 30", {
        ...options(),
        timeout: Duration.millis(300)
      });
      assert.deepStrictEqual(
        [slow.timedOut, slow.exitCode, slow.stdout],
        [true, null, "started\n"]
      );

      const background = yield* runLine("sleep 30 & echo done", options());
      assert.deepStrictEqual([background.exitCode, background.stdout], [0, "done\n"]);
      assert.isBelow(background.seconds, 5);
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("normalize", () => {
  it("replaces each side's origin and paths where they end, and nothing else", () => {
    const text =
      "Published http://after-1a2b.localhost:41000/acme/kudos (pat_123) from /home/a/.local/share/patchy-dev/after-1a2b/workspace/kudos; /home/ab and /home/a.bak stay. Logged out from http://after-1a2b.localhost:41000.";
    assert.strictEqual(
      normalize(text, [
        ["http://after-1a2b.localhost:41000", "<origin>"],
        ["/home/a/.local/share/patchy-dev/after-1a2b", "<env>"],
        ["/home/a", "~"]
      ]),
      "Published <origin>/acme/kudos (pat_123) from <env>/workspace/kudos; /home/ab and /home/a.bak stay. Logged out from <origin>."
    );
  });
});

describe("the diff", () => {
  it("keeps two lines of context around each change and counts the rest", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "old", "h"];
    const after = ["a", "b", "c", "d", "e", "f", "g", "new", "h", "i"];
    assert.deepStrictEqual(hunks(diffLines(before, after)), [
      "@@ 5 unchanged lines @@",
      " f",
      " g",
      "-old",
      "+new",
      " h",
      "+i"
    ]);
  });
});

describe("transcriptMarkdown", () => {
  const run = (exitCode: number, stdout: string, stderr = ""): Run => ({
    exitCode,
    timedOut: false,
    seconds: 0.4,
    stdout,
    stderr
  });

  it("shows a changed line with its diff, folds an unchanged one and cuts the middle of long output", () => {
    const markdown = transcriptMarkdown({
      name: "logs",
      provenance: ["Before is `aaaaaaa` (--base) and after is `bbbbbbb` (dev)."],
      redaction: "Redacted before writing: tokens and login codes from each side's CLI state.",
      lines: [
        {
          caption: "A patch's log",
          command: "patchy logs kudos",
          before: run(1, "", 'Unknown subcommand "logs"\n'),
          after: run(0, "12:00 info started\n")
        },
        {
          caption: "A patch's log",
          command: "patchy whoami | grep <name>",
          before: run(0, "Allison\n"),
          after: run(0, "Allison\n")
        },
        {
          caption: null,
          command: "seq 40",
          before: run(0, "1\n"),
          after: run(0, `${Array.from({ length: 40 }, (_, n) => n + 1).join("\n")}\n`)
        }
      ]
    });
    assert.include(
      markdown,
      [
        "2 of 3 lines changed.",
        "",
        "##### A patch's log",
        "",
        "**Changed.** Before, exit 1 in 0.4 s; after, exit 0 in 0.4 s.",
        "",
        "```console",
        "$ patchy logs kudos",
        "12:00 info started",
        "```",
        "",
        "```diff",
        "-[stderr]",
        '-Unknown subcommand "logs"',
        "+12:00 info started",
        "```",
        "",
        "<details><summary><code>$ patchy whoami | grep &lt;name&gt;</code>: no change, exit 0 in 0.4 s</summary>"
      ].join("\n")
    );
    assert.include(markdown, "\n19\n… 11 lines cut …\n31\n");
    assert.include(markdown, "_11 of 41 lines are cut from the middle. `--json` has it all._");
  });

  it("says when outputs were compared on their first lines only", () => {
    const lines = (last: string) =>
      `${Array.from({ length: 1_000 }, (_, n) => `line ${n}`).join("\n")}\n${last}\n`;
    const markdown = transcriptMarkdown({
      name: "long",
      provenance: [],
      redaction: "",
      lines: [
        {
          caption: null,
          command: "long",
          before: run(0, lines("old")),
          after: run(0, lines("new"))
        }
      ]
    });
    assert.include(
      markdown,
      "_Only the first 1000 lines of each side were compared; `--json` has them all._"
    );
  });
});
