import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layoutOf, writeLauncher, writeWorkerLaunchers } from "./environment.js";

it.layer(NodeServices.layer)("the agent launcher", (it) => {
  it.effect("starts claude without the shell's PATCHY_API_URL and PATCHY_API_TOKEN", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const dir = yield* fs.makeTempDirectoryScoped();
      const layout = layoutOf(path.join(dir, "environment"), path);
      yield* fs.makeDirectory(layout.workspace, { recursive: true });
      yield* writeLauncher(layout);
      const stubs = path.join(dir, "stubs");
      yield* fs.makeDirectory(stubs);
      yield* fs.writeFileString(path.join(stubs, "claude"), "#!/bin/sh\nenv\n", { mode: 0o755 });

      const child = yield* spawner.spawn(
        ChildProcess.make(layout.agent, [], {
          env: {
            PATH: `${stubs}:${yield* Config.String("PATH")}`,
            PATCHY_API_URL: "https://elsewhere.invalid",
            PATCHY_API_TOKEN: "patchy_elsewhere"
          },
          stdin: "ignore"
        })
      );
      const env = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);

      assert.strictEqual(yield* child.exitCode, 0);
      assert.include(env, `PATCHY_STATE_DIR=${layout.state}`);
      assert.notInclude(env, "PATCHY_API_URL");
      assert.notInclude(env, "PATCHY_API_TOKEN");
    }).pipe(Effect.scoped)
  );
});

it.layer(NodeServices.layer)("the worker launchers", (it) => {
  it.effect("start each client in the empty workers folder with only Patchy's MCP", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const dir = yield* fs.makeTempDirectoryScoped();
      const layout = layoutOf(path.join(dir, "environment"), path);
      const apiUrl = "http://env-abc123.localhost:4000";
      yield* writeWorkerLaunchers(layout, { apiUrl, worktree: dir, publisher: "allison" });
      // Each client prints where it started, its arguments and its environment; pnpm stands
      // in for `pnpm dev mcp-token`, reporting how it was called on stderr.
      const stubs = path.join(dir, "stubs");
      yield* fs.makeDirectory(stubs);
      for (const client of ["claude", "codex", "grok"])
        yield* fs.writeFileString(
          path.join(stubs, client),
          `#!/bin/sh\npwd\nprintf 'arg:%s\\n' "$@"\nenv\n`,
          { mode: 0o755 }
        );
      yield* fs.writeFileString(
        path.join(stubs, "pnpm"),
        `#!/bin/sh\necho "pnpm $*" >&2\necho pp_minted\n`,
        { mode: 0o755 }
      );
      const launch = Effect.fn(function* (launcher: string, args: ReadonlyArray<string>) {
        const child = yield* spawner.spawn(
          ChildProcess.make(launcher, args, {
            env: {
              PATH: `${stubs}:${yield* Config.String("PATH")}`,
              PATCHY_API_URL: "https://elsewhere.invalid"
            },
            stdin: "ignore"
          })
        );
        const [stdout, stderr] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString)
          ],
          { concurrency: "unbounded" }
        );
        assert.strictEqual(yield* child.exitCode, 0, stderr);
        return { lines: stdout.split("\n"), stderr };
      });

      const claude = yield* launch(layout.worker, ["-p", "find my deals"]);
      assert.strictEqual(claude.lines[0], yield* fs.realPath(layout.workers));
      assert.include(
        claude.lines,
        `arg:{"mcpServers":{"patchy":{"type":"http","url":"${apiUrl}/mcp"}}}`
      );
      assert.include(claude.lines, "arg:--strict-mcp-config");
      assert.include(claude.lines, "arg:mcp__patchy__read_patch");
      assert.notInclude(claude.lines, "arg:mcp__patchy__change_patch");
      assert.notInclude(claude.lines.join("\n"), "PATCHY_API_URL");

      const codex = yield* launch(layout.workerCodex, ["jordan", "list my deals"]);
      assert.include(codex.stderr, "pnpm --silent dev mcp-token jordan --client Codex");
      assert.include(codex.lines, "PATCHY_MCP_TOKEN=pp_minted");
      assert.include(codex.lines, `arg:mcp_servers.patchy.url="${apiUrl}/mcp"`);
      assert.strictEqual(
        codex.lines.filter((line) => line.startsWith("arg:")).at(-1),
        "arg:list my deals"
      );

      const grok = yield* launch(layout.workerGrok, []);
      assert.include(grok.stderr, "pnpm --silent dev mcp-token allison --client Grok");
      assert.include(grok.lines, "GROK_FOLDER_TRUST=0");
      assert.include(grok.lines, "arg:MCPTool(patchy__read_patch)");
      const config = yield* fs.readFileString(path.join(layout.workers, ".grok", "config.toml"));
      assert.include(config, `url = "${apiUrl}/mcp"`);
      assert.include(config, 'Authorization = "Bearer ${PATCHY_MCP_TOKEN}"');
    }).pipe(Effect.scoped)
  );
});
