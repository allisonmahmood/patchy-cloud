import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layoutOf, workerServer, writeAgent, writeWorkers } from "./environment.js";

const API_URL = "http://env.localhost:4100";

/** An environment in a temp folder with its agent written, and a `claude` stub printing `script`'s output. */
const environmentWith = Effect.fn(function* (script: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const layout = layoutOf(path.join(dir, "environment"), path);
  yield* fs.makeDirectory(layout.workspace, { recursive: true });
  yield* writeAgent(layout, API_URL);
  const stubs = path.join(dir, "stubs");
  yield* fs.makeDirectory(stubs);
  yield* fs.writeFileString(path.join(stubs, "claude"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { dir, layout, PATH: `${stubs}:${yield* Config.String("PATH")}` };
});

/** Runs the launcher with exactly `env`, returning its pid, exit code and stdout. */
const launch = Effect.fn(function* (
  agent: string,
  env: Record<string, string>,
  args: ReadonlyArray<string> = []
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(agent, [...args], { env, extendEnv: false, stdin: "ignore" })
  );
  const stdout = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
  return { pid: child.pid, exitCode: yield* child.exitCode, stdout };
});

it.layer(NodeServices.layer)("the agent launcher", (it) => {
  it.effect("aims the CLI at its instance, drops the shell's token and turns auto memory off", () =>
    Effect.gen(function* () {
      const { layout, PATH } = yield* environmentWith("env");
      const { exitCode, stdout } = yield* launch(layout.agent, {
        PATH,
        PATCHY_API_URL: "https://elsewhere.invalid",
        PATCHY_API_TOKEN: "patchy_elsewhere"
      });

      assert.strictEqual(exitCode, 0);
      const env = stdout.split("\n");
      assert.include(env, `PATCHY_API_URL=${API_URL}`);
      assert.include(env, `PATCHY_STATE_DIR=${layout.state}`);
      assert.include(env, "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
      assert.notInclude(stdout, "PATCHY_API_TOKEN");
    }).pipe(Effect.scoped)
  );

  it.effect(
    "gives each session a temp folder of its own, deleted by a later launch once it ends",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dir, layout, PATH } = yield* environmentWith(
          `printf 'TMPDIR=%s\\n' "$TMPDIR"; printf '%s\\n' "$@"; exit 7`
        );
        const scratch = path.join(dir, "scratch");
        // A running session's folder, named for this test's own live pid.
        const live = path.join(scratch, `patchy-agent-${process.pid}.running`);
        yield* fs.makeDirectory(live, { recursive: true });
        const session = Effect.fn(function* (env: Record<string, string>) {
          const { pid, exitCode, stdout } = yield* launch(layout.agent, { PATH, ...env });
          // Claude Code's own exit code: the launcher execs it, keeping the pid the folder is named for.
          assert.strictEqual(exitCode, 7);
          const lines = stdout.split("\n");
          const temp = lines[0]!.slice("TMPDIR=".length);
          assert.strictEqual(lines[lines.indexOf("--add-dir") + 1], temp);
          assert.isTrue(path.basename(temp).startsWith(`patchy-agent-${pid}.`));
          return temp;
        });

        const first = yield* session({ TMPDIR: scratch });
        assert.strictEqual(path.dirname(first), scratch);
        assert.isTrue(yield* fs.exists(first));
        const second = yield* session({ TMPDIR: scratch });
        assert.strictEqual(path.dirname(second), scratch);
        assert.isFalse(yield* fs.exists(first));
        assert.isTrue(yield* fs.exists(live));
        const fallback = yield* session({});
        assert.strictEqual(path.dirname(fallback), "/tmp");
        yield* fs.remove(fallback, { recursive: true });
      }).pipe(Effect.scoped)
  );

  it.effect(
    "tells the agent to make new work in the workspace, keeping a CLAUDE.md that exists",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { layout } = yield* environmentWith("true");
        const file = path.join(layout.workspace, "CLAUDE.md");

        assert.strictEqual(
          yield* fs.readFileString(file),
          "Make each new patch or page directly in this folder.\n"
        );
        yield* fs.writeFileString(file, "Your own notes.\n");
        yield* writeAgent(layout, API_URL);
        assert.strictEqual(yield* fs.readFileString(file), "Your own notes.\n");
      }).pipe(Effect.scoped)
  );
});

/** An environment in a temp folder with its worker launchers written, and stubs for the commands they run. */
const workersWith = Effect.fn(function* (stubs: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const layout = layoutOf(path.join(dir, "environment"), path);
  const worktree = path.join(dir, "worktree");
  yield* fs.makeDirectory(worktree);
  yield* writeWorkers(layout, { worktree, apiUrl: API_URL });
  const bin = path.join(dir, "stubs");
  yield* fs.makeDirectory(bin);
  for (const [name, script] of Object.entries(stubs))
    yield* fs.writeFileString(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const scratch = path.join(dir, "scratch");
  yield* fs.makeDirectory(scratch);
  return {
    dir,
    layout,
    worktree,
    env: { PATH: `${bin}:${yield* Config.String("PATH")}`, TMPDIR: scratch }
  };
});

const decodeMcpConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      mcpServers: Schema.Record(
        Schema.String,
        Schema.Struct({ type: Schema.String, url: Schema.String })
      )
    })
  )
);
const decodeSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ claudeMdExcludes: Schema.Array(Schema.String) }))
);

/** The value after `flag` in a stub's `arg=` lines. */
const argAfter = (stdout: string, flag: string) => {
  const args = stdout
    .split("\n")
    .filter((line) => line.startsWith("arg="))
    .map((line) => line.slice("arg=".length));
  return args[args.indexOf(flag) + 1];
};

it.layer(NodeServices.layer)("the worker agent launchers", (it) => {
  it.effect(
    "start Claude Code with the environment's door as its only server and none of your instructions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { dir, layout, worktree, env } = yield* workersWith({
          claude: `printf 'cwd=%s\\n' "$PWD"; env; for a in "$@"; do printf 'arg=%s\\n' "$a"; done`
        });
        const { exitCode, stdout } = yield* launch(layout.claudeWorker, {
          ...env,
          PATCHY_API_URL: "https://elsewhere.invalid",
          PATCHY_API_TOKEN: "patchy_elsewhere"
        });

        assert.strictEqual(exitCode, 0);
        const lines = stdout.split("\n");
        assert.include(lines, `cwd=${layout.workers}`);
        assert.include(lines, `PATCHY_API_URL=${API_URL}`);
        assert.include(lines, `PATCHY_STATE_DIR=${layout.workerCli}`);
        assert.include(lines, "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1");
        assert.notInclude(stdout, "PATCHY_API_TOKEN");
        assert.include(lines, "arg=--strict-mcp-config");
        assert.strictEqual(argAfter(stdout, "--setting-sources"), "project");
        assert.strictEqual(argAfter(stdout, "--permission-mode"), "default");
        assert.deepStrictEqual(yield* decodeMcpConfig(argAfter(stdout, "--mcp-config")), {
          mcpServers: { [workerServer(worktree)]: { type: "http", url: `${API_URL}/mcp` } }
        });
        const { claudeMdExcludes } = yield* decodeSettings(argAfter(stdout, "--settings"));
        const root = yield* fs.realPath(dir);
        assert.includeMembers(
          [...claudeMdExcludes],
          [
            path.join(root, "*.md"),
            path.join(root, ".claude", "*.md"),
            path.join(path.dirname(root), ".claude", "rules", "**")
          ]
        );
      }).pipe(Effect.scoped)
  );

  it.effect(
    "mint the person's connection and hand its token only to Codex, on a home of its own",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const token = "patchy_mcp_minted";
        const { dir, layout, worktree, env } = yield* workersWith({
          pnpm: `printf '%s|%s\\n' "$PWD" "$*" > "${"$"}{PNPM_LOG}"; printf '{"token":"${token}","connection":{"id":"agc_1"}}'`,
          codex: `env; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; printf 'login=%s\\n' "$(readlink "$CODEX_HOME/auth.json")"`
        });
        const own = path.join(dir, "own-codex");
        yield* fs.makeDirectory(own);
        yield* fs.writeFileString(path.join(own, "auth.json"), "{}");
        const pnpmLog = path.join(dir, "pnpm.log");
        const { exitCode, stdout } = yield* launch(
          layout.codexWorker,
          { ...env, CODEX_HOME: own, HOME: path.join(dir, "home"), PNPM_LOG: pnpmLog },
          ["jordan", "exec", "Add a lead"]
        );

        assert.strictEqual(exitCode, 0);
        assert.strictEqual(
          yield* fs.readFileString(pnpmLog),
          `${worktree}|--silent dev mcp-token jordan --client Codex --json\n`
        );
        const lines = stdout.split("\n");
        // The token reaches Codex's environment and nothing the launcher prints.
        assert.deepStrictEqual(
          lines.filter((line) => line.includes(token)),
          [`PATCHY_MCP_TOKEN=${token}`]
        );
        assert.include(lines, `CODEX_HOME=${layout.codexHome}`);
        const home = lines.find((line) => line.startsWith("HOME="))!.slice("HOME=".length);
        assert.include(lines, `TMPDIR=${home}`);
        assert.strictEqual(path.dirname(home), env.TMPDIR);
        assert.include(lines, `PATCHY_STATE_DIR=${layout.workerCli}`);
        assert.include(lines, `login=${path.join(own, "auth.json")}`);
        assert.deepStrictEqual(
          lines.filter((line) => line.startsWith("arg=")),
          ["arg=exec", "arg=Add a lead"]
        );
        const config = yield* fs.readFileString(path.join(layout.codexHome, "config.toml"));
        // Nothing of the account's own: its ChatGPT apps and plugins stay out.
        assert.include(config, "apps = false\nplugins = false\nremote_plugin = false\n");
        assert.include(
          config,
          `[mcp_servers.${workerServer(worktree)}]\nurl = "${API_URL}/mcp"\nbearer_token_env_var = "PATCHY_MCP_TOKEN"\n`
        );

        // With no login of yours, the link goes, so Codex's own sign-in stays in the environment.
        yield* fs.remove(path.join(own, "auth.json"));
        const again = yield* launch(
          layout.codexWorker,
          { ...env, CODEX_HOME: own, HOME: path.join(dir, "home"), PNPM_LOG: pnpmLog },
          ["jordan"]
        );
        assert.include(again.stdout.split("\n"), "login=");
        assert.isFalse(yield* fs.exists(path.join(own, "auth.json")));
      }).pipe(Effect.scoped)
  );

  it.effect("start no Codex when the person's connection can't be minted", () =>
    Effect.gen(function* () {
      const { layout, env } = yield* workersWith({
        pnpm: "echo 'No one matches \"nobody\".' >&2; exit 1",
        codex: "echo started"
      });
      const { exitCode, stdout } = yield* launch(layout.codexWorker, env, ["nobody"]);
      assert.strictEqual(exitCode, 1);
      assert.notInclude(stdout, "started");
    }).pipe(Effect.scoped)
  );
});
