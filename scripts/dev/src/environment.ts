/**
 * What `pnpm dev up` builds beside the instance, and `pnpm dev down` removes.
 *
 * It all lives in one folder outside the worktree, so an agent working there
 * never loads the repo's CLAUDE.md: `$XDG_DATA_HOME/patchy-dev/<worktree>/`
 * holds the CLI installed from the instance's release, that CLI's own state
 * (logged in as the scenario's publisher), the agent workspace with the
 * scenario's patch repos, browser profiles per person, the builder `agent`
 * launcher, the worker agent launchers with their folder and state, and
 * `environment.json`, the manifest the card is printed from.
 */
import { Users } from "@patchy/companies";
import { NodeCryptography } from "@patchy/core";
import { CredentialKeys, PidgeonSource } from "@patchy/integrations";
import { InvocationLog, RuntimeLog } from "@patchy/runtime";
import { layerFromUrl } from "@patchy/sql";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Page } from "@playwright/test";
import {
  developerEnvFile,
  readAttioTestKey,
  readCredentialKeys,
  readPidgeonTestKey
} from "./developerEnv.js";
import {
  decodeMail,
  deliverMail,
  isRecorded,
  isTestKey,
  MailFailed,
  recordAddress
} from "./pidgeon.js";
import { hostLabel, type Plan, worktreeHash } from "./plan.js";
import { startMailbox, type Login } from "./mailbox.js";
import { layout as instanceLayout } from "./state.js";
import { realNode } from "./runtimes.js";
import {
  allowPublishing,
  ids,
  liveConnections,
  type LiveConnection,
  Person,
  publisherToken,
  type Scenario,
  sourceOf,
  tokenOf
} from "./scenario.js";
import { saveConnections } from "./connections.js";
import { writeHistory } from "./history.js";

/** A step's command ran and exited non-zero; its output was printed to stderr. */
export class StepExited extends Schema.TaggedError<StepExited>()("StepExited", {
  step: Schema.String,
  exitCode: Schema.Number
}) {
  override get message() {
    return `${this.step} failed (exit ${this.exitCode}); its output is above.`;
  }
}

/** A step's command could not be started at all. */
export class StepUnavailable extends Schema.TaggedError<StepUnavailable>()("StepUnavailable", {
  step: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `${this.step} could not start.`;
  }
}

export class SampleDataFailed extends Schema.TaggedError<SampleDataFailed>()("SampleDataFailed", {
  patch: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Loading sample data in ${this.patch} failed. If Playwright's browser is missing, run \`pnpm exec playwright install chromium\`; then run \`pnpm dev up\` again to finish, or press "Load sample data" yourself.`;
  }
}

/**
 * Connecting a scenario's connection through its page failed at `step`. Playwright's error can
 * quote what was typed, the admin key included, so it rides redacted and never reaches the message.
 */
export class ConnectFailed extends Schema.TaggedError<ConnectFailed>()("ConnectFailed", {
  connection: Schema.String,
  step: Schema.String,
  cause: Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true })
}) {
  override get message() {
    return `Connecting ${this.connection} through its connect page failed while ${this.step}. If Playwright's browser is missing, run \`pnpm exec playwright install chromium\`; then run \`pnpm dev up\` again, or connect it yourself at /settings/integrations.`;
  }
}

export class BrowsersStillRunning extends Schema.TaggedError<BrowsersStillRunning>()(
  "BrowsersStillRunning",
  { profiles: Schema.String }
) {
  override get message() {
    return `Browsers using profiles in ${this.profiles} did not exit; close them and run \`pnpm dev down\` again. Nothing was deleted.`;
  }
}

export class NoBrowser extends Schema.TaggedError<NoBrowser>()("NoBrowser", {}) {
  override get message() {
    return "No Chromium-family browser found on PATH; set PATCHY_BROWSER to one.";
  }
}

export class PersonNotFound extends Schema.TaggedError<PersonNotFound>()("PersonNotFound", {
  query: Schema.String,
  people: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No one matches "${this.query}". People: ${this.people.join(", ")}.`;
  }
}

export class ScreenshotFailed extends Schema.TaggedError<ScreenshotFailed>()("ScreenshotFailed", {
  target: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Capturing ${this.target} failed: ${String(this.cause)}. If Playwright's browser is missing, run \`pnpm exec playwright install chromium\`.`;
  }
}

const PublishedPatch = Schema.Struct({
  /** The scenario's repo or file-patch name. */
  key: Schema.String,
  name: Schema.String,
  address: Schema.String,
  sampled: Schema.Boolean,
  /** Shared with its guests: sharing again can be refused once a connection keeps guests off. */
  shared: Schema.optionalKey(Schema.Boolean),
  /** Retired or deleted, as its scenario says. */
  ended: Schema.optionalKey(Schema.Boolean)
});

/**
 * `environment.json`: what the card shows, and `up`'s progress. It is written
 * after each step, so an `up` that failed halfway resumes where it stopped.
 */
export const Manifest = Schema.Struct({
  apiUrl: Schema.String,
  scenario: Schema.String,
  company: Schema.Struct({ name: Schema.String, handle: Schema.String }),
  people: Schema.Array(Person),
  publisher: Schema.String,
  /** The release tarball the CLI and repos were set up against. */
  release: Schema.String,
  patches: Schema.Array(PublishedPatch),
  complete: Schema.Boolean
});
export type Manifest = typeof Manifest.Type;
const ManifestJson = Schema.fromJsonString(Manifest, { space: 2 });
const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);
export const encodeManifest = Schema.encodeSync(ManifestJson);

const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

/** `$XDG_DATA_HOME/patchy-dev/<worktree label>`, outside every worktree. */
export const environmentDir = Effect.fn("environmentDir")(function* (worktree: string) {
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME");
  const data = yield* Config.String("XDG_DATA_HOME").pipe(
    Config.withDefault(path.join(home, ".local", "share"))
  );
  return path.join(data, "patchy-dev", hostLabel(worktree));
});

export const layoutOf = (dir: string, path: Path.Path) => ({
  dir,
  cli: path.join(dir, "cli"),
  bin: path.join(dir, "bin"),
  state: path.join(dir, "cli-state"),
  workspace: path.join(dir, "workspace"),
  browsers: path.join(dir, "browsers"),
  agent: path.join(dir, "agent"),
  /** Where worker agents start: a folder of their own, empty until they make something. */
  workers: path.join(dir, "workers"),
  /** Worker agents' CLI state, which never logs in. */
  workerCli: path.join(dir, "worker-state", "cli"),
  /** Codex's home for worker sessions: its `config.toml`, sessions and a link to the login. */
  codexHome: path.join(dir, "worker-state", "codex"),
  claudeWorker: path.join(dir, "worker-claude"),
  codexWorker: path.join(dir, "worker-codex"),
  manifest: path.join(dir, "environment.json"),
  /** The local parts of the Pidgeon test addresses `up` asked for, for `down` to take down. */
  pidgeon: path.join(dir, "pidgeon-addresses.json")
});
type Layout = ReturnType<typeof layoutOf>;

export const readManifest = Effect.fn("readManifest")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(layout.manifest))) return Option.none<Manifest>();
  return yield* decodeManifest(yield* fs.readFileString(layout.manifest)).pipe(Effect.option);
});

/**
 * Child commands get a closed env, as the server does: what a process needs to
 * run, the CLI's own state dir, and the environment's bin (its patchy and
 * Node) first on PATH, then that Node's own folder, for its npm. Nothing from
 * the caller's PATCHY_* leaks in. `pnpm dev transcript` runs its lines in it too.
 */
export const childEnv = Effect.fn("childEnv")(function* (layout: Layout) {
  const path = yield* Path.Path;
  const optional = (name: string) => Config.option(Config.String(name));
  const settings = yield* Config.all({
    PATH: Config.String("PATH").pipe(Config.withDefault("")),
    HOME: Config.String("HOME"),
    TMPDIR: optional("TMPDIR"),
    XDG_DATA_HOME: optional("XDG_DATA_HOME"),
    XDG_CACHE_HOME: optional("XDG_CACHE_HOME"),
    XDG_CONFIG_HOME: optional("XDG_CONFIG_HOME")
  });
  const passed: Record<string, string> = { HOME: settings.HOME };
  for (const name of ["TMPDIR", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] as const) {
    const value = settings[name];
    if (Option.isSome(value)) passed[name] = value.value;
  }
  return {
    ...passed,
    PATH: [layout.bin, path.dirname((yield* realNode()).execPath), settings.PATH].join(
      PATH_DELIMITER
    ),
    PATCHY_STATE_DIR: layout.state
  };
});

/** Runs a command to completion and reports its exit code and output. */
const exec = Effect.fn("Environment.exec")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly input?: string }
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          extendEnv: false,
          stdin:
            options.input === undefined
              ? "ignore"
              : Stream.make(new TextEncoder().encode(options.input))
        })
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode
        ],
        { concurrency: "unbounded" }
      );
      return { stdout, stderr, exitCode };
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new StepUnavailable({ step, cause }))
    })
  );
});

/** Runs one step; on failure the tail of its output goes to stderr, not into the error. */
const run = Effect.fn("Environment.run")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly input?: string }
) {
  let result = yield* exec(step, command, args, options);
  // A scenario with many patches can outrun the instance's per-address API limit, which refuses
  // before anything changes; the command runs again once the minute has moved on.
  for (let wait = 1; wait <= 3 && result.exitCode !== 0; wait++) {
    if (!`${result.stdout}${result.stderr}`.includes('"code":"rate_limited"')) break;
    yield* Console.error(`  ${step}: the instance's API limit refused it; trying again shortly`);
    yield* Effect.sleep("20 seconds");
    result = yield* exec(step, command, args, options);
  }
  if (result.exitCode !== 0) {
    const output = result.stderr.trim() || result.stdout.trim();
    yield* Console.error(output.split("\n").slice(-12).join("\n"));
    return yield* new StepExited({ step, exitCode: result.exitCode });
  }
  return result.stdout;
});

const ReleaseJson = Schema.fromJsonString(
  Schema.Struct({ package: Schema.Struct({ tarball: Schema.String }) })
);
const PublishJson = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, address: Schema.String })
);
const ConnectedJson = Schema.fromJsonString(
  Schema.Struct({
    snapshot: Schema.NullOr(Schema.Struct({ address: Schema.Struct({ email: Schema.String }) }))
  })
);
const decodeConnected = Schema.decodeUnknownOption(ConnectedJson);
const decodeRelease = Schema.decodeUnknownEffect(ReleaseJson);
const decodePublish = Schema.decodeUnknownEffect(PublishJson);

const currentRelease = Effect.fn("currentRelease")(function* (apiUrl: string) {
  const response = yield* HttpClient.get(`${apiUrl}/api/release`);
  return (yield* decodeRelease(yield* response.text)).package.tarball;
});

/**
 * The environment's own CLI, from the instance's current release, and real
 * Node beside it as `bin/node`; nothing is installed globally.
 */
const installCli = Effect.fn("installCli")(function* (layout: Layout, tarball: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(layout.cli, { recursive: true });
  yield* fs.makeDirectory(layout.bin, { recursive: true });
  yield* run(
    "Installing the patchy CLI",
    "npm",
    ["install", "--prefix", layout.cli, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: layout.dir, env: yield* childEnv(layout) }
  );
  for (const [name, target] of [
    ["patchy", path.join(layout.cli, "node_modules", ".bin", "patchy")],
    ["node", (yield* realNode()).execPath]
  ] as const) {
    const link = path.join(layout.bin, name);
    yield* fs.remove(link, { force: true });
    yield* fs.symlink(target, link);
  }
});

const pnpmVersion = Effect.fn("pnpmVersion")(function* (layout: Layout) {
  const out = yield* run("Reading the pnpm version", "pnpm", ["--version"], {
    cwd: layout.dir,
    env: yield* childEnv(layout)
  });
  return out.trim();
});

/**
 * The agent workspace: the release's Patchy skill as a project skill, and the
 * environment's Node and pnpm pinned for mise (a newer global Node breaks the CLI).
 */
const writeWorkspace = Effect.fn("writeWorkspace")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills = path.join(layout.workspace, ".claude", "skills");
  yield* fs.makeDirectory(skills, { recursive: true });
  const skill = path.join(skills, "patchy");
  yield* fs.remove(skill, { recursive: true, force: true });
  yield* fs.symlink(path.join(layout.cli, "node_modules", "patchy", "skills", "patchy"), skill);
  const miseFile = path.join(layout.workspace, "mise.toml");
  yield* fs.writeFileString(
    miseFile,
    `[tools]\nnode = "${(yield* realNode()).version}"\npnpm = "${yield* pnpmVersion(layout)}"\n`
  );
  // Without mise there is nothing to trust; the launcher's PATH still pins Node.
  yield* run("Trusting the workspace's mise.toml", "mise", ["trust", miseFile], {
    cwd: layout.workspace,
    env: yield* childEnv(layout)
  }).pipe(Effect.ignore);
});

const ALLOWED_TOOLS = [
  "Bash(patchy:*)",
  "Bash(pnpm:*)",
  "Bash(node:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(mkdir:*)",
  "Bash(jq:*)",
  "Bash(sed -n:*)",
  "Bash(wc:*)"
];

/** The settings a launcher passes to Claude Code with `--settings`. */
const encodeAgentSettings = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ claudeMdExcludes: Schema.Array(Schema.String) }))
);

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * `--settings` for a Claude Code launcher. Claude Code loads instruction files
 * from every folder above its working directory, the developer's HOME among
 * them, walking up from the resolved path, past any symlink. Excluding every
 * folder from the environment's up leaves only the working folder's own.
 */
const claudeSettings = Effect.fn("claudeSettings")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const above: Array<string> = [];
  for (let dir = yield* fs.realPath(layout.dir); !above.includes(dir); dir = path.dirname(dir))
    above.push(dir);
  // Each folder's CLAUDE.md, CLAUDE.local.md and AGENTS.md, those in its
  // .claude, and its .claude/rules. Claude Code's patterns take no escapes, so
  // a glob character in a folder's name becomes `?`, matching any one character.
  return encodeAgentSettings({
    claudeMdExcludes: above
      .map((dir) => dir.replace(/[*?[\]{}()\\]/g, "?"))
      .flatMap((dir) => [
        path.join(dir, "*.md"),
        path.join(dir, ".claude", "*.md"),
        path.join(dir, ".claude", "rules", "**")
      ])
  });
});

/**
 * What every launcher does before it execs its client: the guard, then a temp
 * folder of the session's own. The shell's `PATCHY_API_TOKEN` is cleared and
 * `PATCHY_API_URL` is the environment's instance, so a command in a repo bound
 * to another one, production included, is refused before anything is sent; an
 * explicit `--api-url` still wins. `PATCHY_STATE_DIR` is the environment's, so
 * the developer's `~/.patchy` is never read. `TMPDIR` is a folder made in
 * `$TMPDIR` or `/tmp`, named for the launcher's pid, which `exec` keeps for the
 * client; a later launch of any of them deletes the folders whose process is gone.
 */
const sessionLines = (
  layout: Layout,
  options: { readonly apiUrl: string; readonly state: string; readonly cwd: string }
) => [
  "unset PATCHY_API_TOKEN",
  `export PATCHY_API_URL=${quote(options.apiUrl)}`,
  `export PATH=${quote(`${layout.bin}${PATH_DELIMITER}`)}"$PATH"`,
  `export PATCHY_STATE_DIR=${quote(options.state)}`,
  `cd ${quote(options.cwd)} || exit 1`,
  "# Each session's temp folder is named for its pid, which exec keeps for the client;",
  "# a later launch deletes the folders whose process is gone.",
  'for old in "${TMPDIR:-/tmp}"/patchy-agent-*.*; do',
  "  pid=${old##*/patchy-agent-}; pid=${pid%%.*}",
  '  case $pid in "" | *[!0-9]*) continue ;; esac',
  '  [ -O "$old" ] && ! kill -0 "$pid" 2>/dev/null && rm -rf "$old"',
  "done",
  'TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/patchy-agent-$$.XXXXXX") || exit 1',
  "export TMPDIR"
];

/** The workspace's `CLAUDE.md`: the "folder they name" of the Patchy skill, so new work lands where `down` finds it. */
const WORKSPACE_INSTRUCTIONS = "Make each new patch or page directly in this folder.\n";

/**
 * The environment's builder agent: the `agent` launcher, and the workspace's
 * `CLAUDE.md` unless one exists. `up` writes both every time, and a trial
 * writes this checkout's over each side's.
 *
 * The launcher starts Claude Code in the workspace as a Patchy user who has
 * already set up, with no personal settings, skills, connectors or instruction
 * files, behind the guard in `sessionLines`; the environment's login decides as
 * whom it publishes. Each session starts clean: auto memory is off, and its
 * temp folder is its own. Its commands still run as the developer, with their
 * HOME and npm prefix, so it must never be given the portal's setup line or run
 * `patchy setup`: both write to the developer's own machine, and `down` undoes
 * neither. Permissions come as flags, so the workspace needs no trust prompt.
 * Arguments pass through, and the launcher execs Claude Code, so signals and
 * the exit code are its own.
 */
export const writeAgent = Effect.fn("writeAgent")(function* (layout: Layout, apiUrl: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instructions = path.join(layout.workspace, "CLAUDE.md");
  if (!(yield* fs.exists(instructions)))
    yield* fs.writeFileString(instructions, WORKSPACE_INSTRUCTIONS);
  const settings = yield* claudeSettings(layout);
  yield* fs.writeFileString(
    layout.agent,
    [
      "#!/usr/bin/env bash",
      "# Claude Code in this Patchy environment's workspace, as a Patchy user who has set up.",
      "# Its commands run as you: never give it the portal's setup line or `patchy setup`.",
      ...sessionLines(layout, { apiUrl, state: layout.state, cwd: layout.workspace }),
      "export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
      `exec claude "$@" --setting-sources project --settings ${quote(settings)} --strict-mcp-config --permission-mode acceptEdits --add-dir "$TMPDIR" --allowedTools ${ALLOWED_TOOLS.map(quote).join(" ")}`,
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
});

/** Claude Code's `--mcp-config`: the one server a worker session may use. */
const encodeMcpConfig = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      mcpServers: Schema.Record(
        Schema.String,
        Schema.Struct({ type: Schema.Literal("http"), url: Schema.String })
      )
    })
  )
);

/** A TOML basic string; JSON's escapes are TOML's for every character a path or URL holds. */
const tomlString = (value: string) => JSON.stringify(value);

/** Each worker client's name for the environment's door: one per worktree, short enough for tool names. */
export const workerServer = (worktree: string) => `patchy-dev-${worktreeHash(worktree)}`;

/** How `worker-codex` reads the token out of `pnpm dev mcp-token --json`, without printing anything else. */
const READ_TOKEN = `process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).token)`;

/**
 * The environment's worker agents: people's own agents using its patches
 * through Patchy MCP at `<instance>/mcp`, as a client of their own would. `up`
 * writes both launchers every time. Both start in `workers/` behind the guard
 * in `sessionLines`, with a CLI state that never logs in, so they reach Patchy
 * only through the door and never with the developer's or the publisher's
 * login. Both name the door `workerServer(worktree)`.
 *
 * `worker-claude` connects through consent: its `/mcp` opens the consent page
 * in the developer's browser, where they sign in as one of the scenario's
 * people. It loads only that server, none of the developer's settings, skills,
 * connectors or instruction files, with auto memory off and Claude Code's own
 * permission prompts, so it asks before each call as a person's own would.
 * Claude Code keeps the sign-in in the developer's `~/.claude/.credentials.json`
 * whatever the config, keyed by the server's name and address, so the name is
 * per worktree: a later sign-in to the same address replaces its entry, and
 * `down` leaves it (DEVELOPMENT says why).
 *
 * `worker-codex <person>` mints an agent connection for that person with
 * `pnpm dev mcp-token`, as Codex, and hands its token to Codex in its
 * environment only, never to the commands it runs. Codex runs on a home of its
 * own: `CODEX_HOME` is the environment's, whose `config.toml` names only the
 * door and turns off the account's own apps and plugins, and `HOME` is the
 * session's temp folder, with the variables that point shells at startup files
 * cleared, so none of the developer's config, instructions, skills or shell
 * profile load. The developer's Codex login is linked in, and Codex writes a
 * refreshed login through the link, into that one file, as another session of
 * theirs would. With no login of theirs, Codex signs in inside the
 * environment, and `down` deletes it.
 *
 * Arguments pass through to each client, which the launcher execs.
 */
export const writeWorkers = Effect.fn("writeWorkers")(function* (
  layout: Layout,
  plan: Pick<Plan, "worktree" | "apiUrl">
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const dir of [layout.workers, layout.workerCli, layout.codexHome])
    yield* fs.makeDirectory(dir, { recursive: true });
  const server = workerServer(plan.worktree);
  const door = `${plan.apiUrl}/mcp`;
  const session = sessionLines(layout, {
    apiUrl: plan.apiUrl,
    state: layout.workerCli,
    cwd: layout.workers
  });
  const mcpConfig = encodeMcpConfig({ mcpServers: { [server]: { type: "http", url: door } } });
  yield* fs.writeFileString(
    layout.claudeWorker,
    [
      "#!/usr/bin/env bash",
      "# Claude Code as a person's worker agent, using this environment's patches through Patchy MCP.",
      "# /mcp signs in on the consent page: pick one of the environment's people there.",
      ...session,
      "export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
      `exec claude "$@" --setting-sources project --settings ${quote(yield* claudeSettings(layout))} --strict-mcp-config --mcp-config ${quote(mcpConfig)} --permission-mode default --add-dir "$TMPDIR"`,
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
  yield* fs.writeFileString(
    path.join(layout.codexHome, "config.toml"),
    [
      "# Codex for this Patchy environment's worker agent, written by `pnpm dev up`.",
      'cli_auth_credentials_store = "file"',
      "check_for_update_on_startup = false",
      "",
      "# No background server outliving the session, none of the account's own apps or plugins,",
      "# and no shell snapshot, which would write the session's environment to disk.",
      "[features]",
      "daemon_auto_start = false",
      "apps = false",
      "plugins = false",
      "remote_plugin = false",
      "shell_snapshot = false",
      "",
      "# The door's token is for Codex alone, never for the commands it runs.",
      "[shell_environment_policy]",
      'exclude = ["PATCHY_MCP_TOKEN"]',
      "",
      `[projects.${tomlString(layout.workers)}]`,
      'trust_level = "trusted"',
      "",
      `[mcp_servers.${server}]`,
      `url = ${tomlString(door)}`,
      'bearer_token_env_var = "PATCHY_MCP_TOKEN"',
      ""
    ].join("\n")
  );
  yield* fs.writeFileString(
    layout.codexWorker,
    [
      "#!/usr/bin/env bash",
      "# Codex as a person's worker agent, using this environment's patches through Patchy MCP.",
      "# worker-codex <person> [codex arguments]: a person's key, email or first name.",
      "# An inherited SHELLOPTS=xtrace would print the token below.",
      "set +x",
      'person=${1:?"usage: worker-codex <person> [codex arguments]"}',
      "shift",
      ...session,
      "# The developer's own Codex login, linked so a refresh is written to it; nothing else of theirs.",
      "own=${CODEX_HOME:-$HOME/.codex}",
      `export CODEX_HOME=${quote(layout.codexHome)}`,
      "# Started from a shell already on this home (a worker session's), there is nothing to link.",
      'if [ "$own" -ef "$CODEX_HOME" ]; then :',
      'elif [ -f "$own/auth.json" ]; then ln -sfn "$own/auth.json" "$CODEX_HOME/auth.json" || exit 1',
      'elif [ -L "$CODEX_HOME/auth.json" ]; then rm -f "$CODEX_HOME/auth.json"; fi',
      `minted=$(cd ${quote(plan.worktree)} && pnpm --silent dev mcp-token "$person" --client Codex --json) || exit 1`,
      `PATCHY_MCP_TOKEN=$(printf '%s' "$minted" | node -e ${quote(READ_TOKEN)}) || exit 1`,
      "unset minted",
      "export PATCHY_MCP_TOKEN",
      "# None of your shell's startup files either: these point bash and zsh past HOME.",
      "unset BASH_ENV ENV ZDOTDIR",
      'export HOME="$TMPDIR"',
      'exec codex "$@"',
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
});

/**
 * Connects a scenario's connection as `email` through its connect page in a browser, as an admin
 * would, the page's script included: the test admin key, then a new address on pidgeon.email at
 * `localPart`. One already connected under its name is left be.
 */
const connectSource = Effect.fn("connectSource")(function* (
  apiUrl: string,
  email: string,
  connection: Extract<LiveConnection, { readonly integration: "pidgeon" }>,
  adminKey: Redacted.Redacted<string>,
  localPart: string
) {
  const name = `${connection.integration}/${connection.handle}`;
  // Where it got to, for a failure's message; Playwright's own error stays redacted.
  let step = "starting the browser";
  yield* Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        step = "signing in";
        await page.goto(
          `${apiUrl}/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent("/settings/integrations")}`
        );
        if ((await page.getByRole("link", { name, exact: true }).count()) > 0) return;
        step = "pasting the admin key";
        await page.goto(`${apiUrl}/settings/integrations/connect/${connection.integration}`);
        await page.locator("#pidgeon-key").fill(Redacted.value(adminKey));
        step = "finding addresses";
        await page.getByRole("button", { name: "Find addresses" }).click();
        step = "describing the new address";
        await page.locator("label.tile-option", { hasText: "New address" }).click();
        await page.locator("#pidgeon-local").fill(localPart);
        await page.locator("#pidgeon-display").fill(connection.displayName);
        step = "choosing what patches may do";
        await page
          .locator("label.choice-card")
          .filter({
            has: page.getByText(connection.access === "send" ? "Read and send" : "Read", {
              exact: true
            })
          })
          .click();
        step = "naming it";
        await page.locator("#connection-handle").fill(connection.handle);
        await page.locator("#connection-description").fill(connection.description);
        step = "connecting";
        await Promise.all([
          page.waitForURL(/\/settings\/integrations\/conn_/),
          page.getByRole("button", { name: "Connect", exact: true }).click()
        ]);
      } finally {
        await browser.close();
      }
    },
    catch: (cause) => connectFailed(name, step, cause)
  });
});

/**
 * Connects a scenario's Attio connection as `email` through its connect page, as an admin would:
 * the name, the description and the developer's read key, in one submit. One already connected
 * under its name is left be; answers whether it connected one.
 */
const connectAttio = Effect.fn("connectAttio")(function* (
  apiUrl: string,
  email: string,
  connection: Extract<LiveConnection, { readonly integration: "attio" }>,
  key: Redacted.Redacted<string>
) {
  const name = `${connection.integration}/${connection.handle}`;
  let step = "starting the browser";
  return yield* Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        step = "signing in";
        await page.goto(
          `${apiUrl}/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent("/settings/integrations")}`
        );
        if ((await page.getByRole("link", { name, exact: true }).count()) > 0) return false;
        step = "filling in the connect form";
        await page.goto(`${apiUrl}/settings/integrations/connect/attio`);
        await page.locator("#connection-handle").fill(connection.handle);
        await page.locator("#connection-description").fill(connection.description);
        await page.locator("#connection-key").fill(Redacted.value(key));
        step = "checking the key and reading the workspace";
        await Promise.all([
          page.waitForURL(/\/settings\/integrations\/conn_/, { timeout: 90_000 }),
          page.getByRole("button", { name: "Test and connect", exact: true }).click()
        ]);
        return true;
      } finally {
        await browser.close();
      }
    },
    catch: (cause) => connectFailed(name, step, cause)
  });
});

/**
 * Connects a scenario's IMAP connection as `email` through its connect page, as an admin would:
 * the name, the description and the dev mailbox's login, in one submit. One already connected
 * under its name is left be; answers whether it connected one.
 */
const connectImap = Effect.fn("connectImap")(function* (
  apiUrl: string,
  email: string,
  connection: Extract<LiveConnection, { readonly integration: "imap" }>,
  login: Login
) {
  const name = `${connection.integration}/${connection.handle}`;
  let step = "starting the browser";
  return yield* Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        step = "signing in";
        await page.goto(
          `${apiUrl}/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent("/settings/integrations")}`
        );
        if ((await page.getByRole("link", { name, exact: true }).count()) > 0) return false;
        step = "filling in the connect form";
        await page.goto(`${apiUrl}/settings/integrations/connect/imap`);
        await page.locator("#connection-handle").fill(connection.handle);
        await page.locator("#connection-description").fill(connection.description);
        await page.locator("#connection-host").fill(login.host);
        // One choice is the port and its security: 993 (TLS).
        await page.locator("#connection-port").selectOption("993");
        await page.locator("#connection-username").fill(login.username);
        await page.locator("#connection-password").fill(login.password);
        step = "testing the login and listing folders";
        await Promise.all([
          page.waitForURL(/\/settings\/integrations\/conn_/, { timeout: 60_000 }),
          page.getByRole("button", { name: "Test and connect", exact: true }).click()
        ]);
        return true;
      } finally {
        await browser.close();
      }
    },
    catch: (cause) => connectFailed(name, step, cause)
  });
});

/**
 * A scenario connection an earlier start already made, by the environment's CLI: none when the
 * instance has none by that name, else its address's local part, none inside when it can't be read.
 */
const connectedLocalPart = Effect.fn("connectedLocalPart")(function* (
  layout: Layout,
  env: Record<string, string>,
  name: string
) {
  const result = yield* exec(
    `Looking up ${name}`,
    "patchy",
    ["list", "connections", name, "--json"],
    {
      cwd: layout.dir,
      env
    }
  );
  if (result.exitCode !== 0) return Option.none<Option.Option<string>>();
  return Option.some(
    decodeConnected(result.stdout).pipe(
      Option.flatMap((detail) => Option.fromNullishOr(detail.snapshot)),
      Option.map((snapshot) => snapshot.address.email.slice(0, snapshot.address.email.indexOf("@")))
    )
  );
});

/** A connect page failure, its cause kept but never shown: it can quote the admin key. */
export const connectFailed = (connection: string, step: string, cause: unknown) =>
  new ConnectFailed({ connection, step, cause: Redacted.make(cause) });

/**
 * Presses "Load sample data" in the patch open on `page`, then waits for its
 * empty state to stay gone; throws when it never goes. `pnpm dev eval` stages
 * its fixtures with it too.
 */
export const pressSampleData = async (page: Page) => {
  const frame = page.frameLocator("iframe").first();
  await frame
    .getByRole("button", { name: /load sample data/i })
    .first()
    .click({ timeout: 30_000 });
  // The button relabels while its call runs, so wait for the empty state
  // to stay gone; closing the browser earlier can drop the call.
  const emptyState = frame.getByText(/load(ing)? sample data/i);
  // 250ms polls: up to a minute, done once it has stayed gone for over 2s.
  for (let poll = 0, quiet = 0; poll < 240; poll++, await page.waitForTimeout(250)) {
    quiet = (await emptyState.count()) > 0 ? 0 : quiet + 1;
    if (quiet > 8) return;
  }
  throw new Error("the sample data never replaced the empty state");
};

/** Presses a patch's "Load sample data" as `email`, through the persona sign-in. */
const loadSampleData = Effect.fn("loadSampleData")(function* (
  apiUrl: string,
  email: string,
  address: string
) {
  const target = new URL(address).pathname;
  yield* Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(
          `${apiUrl}/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent(target)}`
        );
        await pressSampleData(page);
      } finally {
        await browser.close();
      }
    },
    catch: (cause) => new SampleDataFailed({ patch: target, cause })
  });
});

/** The workspace's patch repos: directories holding a `patchy.json`, including ones an agent made. */
const workspaceRepos = Effect.fn("workspaceRepos")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(layout.workspace))) return [];
  const repos: Array<string> = [];
  for (const entry of yield* fs.readDirectory(layout.workspace)) {
    const repo = path.join(layout.workspace, entry);
    if (
      (yield* fs.stat(repo)).type === "Directory" &&
      (yield* fs.exists(path.join(repo, "patchy.json")))
    )
      repos.push(repo);
  }
  return repos;
});

const PATCH_SOURCE_SKIP = new Set(["node_modules", ".patchy", "dist"]);

/**
 * Copies a scenario repo's builder-owned files over the freshly initialized
 * repo. A directory the scenario has (`src/`, `server/` …) replaces the
 * starter's, so starter modules such as `server/notes.ts` don't linger.
 */
export const overlay = (
  from: string,
  to: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const entry of yield* fs.readDirectory(from)) {
      if (PATCH_SOURCE_SKIP.has(entry)) continue;
      const source = path.join(from, entry);
      const target = path.join(to, entry);
      if ((yield* fs.stat(source)).type === "Directory") {
        yield* fs.remove(target, { recursive: true, force: true });
        yield* fs.makeDirectory(target, { recursive: true });
        yield* overlay(source, target);
      } else yield* fs.copyFile(source, target);
    }
  });

/** The scenario's dev mailbox for `connection`, started or restarted; none without Docker. */
const mailboxFor = Effect.fn("mailboxFor")(function* (
  layout: Layout,
  plan: Plan,
  scenarioDir: string,
  scenario: Scenario,
  connection: Extract<LiveConnection, { readonly integration: "imap" }>
) {
  const path = yield* Path.Path;
  return yield* startMailbox({
    worktree: plan.worktree,
    dir: layout.dir,
    mailboxes: instanceLayout(plan, path).mailboxes,
    company: scenario.company.handle,
    username: connection.username,
    mail: Option.map(Option.fromNullishOr(connection.mail), (file) => path.join(scenarioDir, file))
  });
});

/**
 * Saves the scenario's offline connections and makes its live ones, then publishes each patch as
 * its owner, as many times as it has versions, loads its sample data, shares it with its guests
 * and retires or deletes it, recording each step in the manifest, and last writes the scenario's
 * history. Steps already recorded are skipped, and so are sharing and ending a patch an interrupted
 * run already retired or deleted; the history writes the same again. A repo left half-built by an
 * earlier failure is initialized again.
 */
const materialize = Effect.fn("materialize")(function* (
  layout: Layout,
  plan: Plan,
  scenarioDir: string,
  scenario: Scenario,
  manifest: Manifest
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* childEnv(layout);
  const publisher = scenario.people.find((person) => person.key === scenario.publisher)!;
  const sql = yield* SqlClient.SqlClient;
  const ownerOf = (patch: Scenario["patches"][number]) =>
    scenario.people.find((person) => person.key === (patch.owner ?? scenario.publisher))!;
  /** A published patch's id, and whether it's live, as the instance's database has it. */
  const stored = (owner: Person, name: string) =>
    sql<{ readonly id: string; readonly live: boolean }>`
      SELECT id, retired_at IS NULL AND deleted_at IS NULL AS live FROM patches
      WHERE company_id = ${ids(scenario, owner).companyId} AND name = ${name}`;
  /** The people a patch is shared with, which the scenario checked are at its other companies. */
  const guestsOf = (patch: Scenario["patches"][number]) =>
    scenario.people.filter((person) => patch.guests?.includes(person.key) === true);
  let current = manifest;
  const record = (entry: typeof PublishedPatch.Type) =>
    Effect.gen(function* () {
      current = {
        ...current,
        patches: [...current.patches.filter((patch) => patch.key !== entry.key), entry]
      };
      yield* fs.writeFileString(layout.manifest, encodeManifest(current));
    });
  const connections = liveConnections(scenario);
  const devEnv = yield* developerEnvFile(yield* Config.String("HOME"));
  const pidgeonKey = connections.some((connection) => connection.integration === "pidgeon")
    ? yield* readPidgeonTestKey(devEnv)
    : Option.none();
  const attioKey = connections.some((connection) => connection.integration === "attio")
    ? yield* readAttioTestKey(devEnv)
    : Option.none();
  // Offline connections first: they need nothing from outside.
  yield* saveConnections(scenario);
  // Connections not made, so the patches declaring them can't publish either.
  const skipped = new Set<string>();
  for (const connection of connections) {
    const name = `${connection.integration}/${connection.handle}`;
    // IMAP's mailbox is this machine's own, in Docker; `down` removes it.
    if (connection.integration === "imap") {
      const login = yield* mailboxFor(layout, plan, scenarioDir, scenario, connection);
      if (Option.isNone(login)) {
        skipped.add(name);
        yield* Console.error(
          `  ${name}: skipped. Its dev mailbox runs in Docker, which isn't answering here.`
        );
        continue;
      }
      yield* Console.error(`  ${name}: connecting as ${publisher.name}`);
      const made = yield* connectImap(manifest.apiUrl, publisher.email, connection, login.value);
      if (!made) yield* Console.error(`  ${name}: already connected`);
      continue;
    }
    // Attio's is read-only: nothing is made in Attio, so `down` has nothing to take down there.
    if (connection.integration === "attio") {
      if (Option.isNone(attioKey)) {
        skipped.add(name);
        yield* Console.error(
          `  ${name}: skipped. Put a read-only Attio key in ${devEnv} as ATTIO_TEST_READ_KEY to connect it.`
        );
        continue;
      }
      yield* Console.error(`  ${name}: connecting as ${publisher.name}`);
      const made = yield* connectAttio(
        manifest.apiUrl,
        publisher.email,
        connection,
        attioKey.value
      );
      if (!made) yield* Console.error(`  ${name}: already connected`);
      continue;
    }
    if (Option.isNone(pidgeonKey)) {
      skipped.add(name);
      yield* Console.error(
        `  ${name}: skipped. Put a Pidgeon test admin key in ${devEnv} as PIDGEON_TEST_ADMIN_KEY to connect it.`
      );
      continue;
    }
    // A live key would make a live address and key, which nothing here takes down again.
    const test = yield* isTestKey(pidgeonKey.value).pipe(
      Effect.provide(PidgeonSource.layer),
      Effect.orElseSucceed(() => false)
    );
    if (!test) {
      skipped.add(name);
      yield* Console.error(
        `  ${name}: skipped. PIDGEON_TEST_ADMIN_KEY isn't a Pidgeon test key, and dev environments only use one.`
      );
      continue;
    }
    // An earlier start that connected it, then stopped, left its address: its mail resumes there.
    const existing = yield* connectedLocalPart(layout, env, name);
    let localPart: string;
    if (Option.isSome(existing)) {
      if (
        Option.isNone(existing.value) ||
        !(yield* isRecorded(layout.pidgeon, existing.value.value))
      ) {
        yield* Console.error(
          `  ${name}: already connected to an address this environment didn't make, so it gets no mail.`
        );
        continue;
      }
      localPart = existing.value.value;
      yield* Console.error(`  ${name}: already connected`);
    } else {
      // A code of this environment's after the local part makes the address its own. It's recorded
      // before Pidgeon is asked, so `down` finds the address even if the connect fails after it.
      localPart = `${connection.localPart}-${(yield* Random.next).toString(36).slice(2, 8)}`;
      yield* recordAddress(layout.pidgeon, localPart);
      yield* Console.error(`  ${name}: connecting as ${publisher.name}`);
      yield* connectSource(
        manifest.apiUrl,
        publisher.email,
        connection,
        pidgeonKey.value,
        localPart
      );
    }
    if (connection.mail !== undefined) {
      const mail = yield* decodeMail(
        yield* fs.readFileString(path.join(scenarioDir, connection.mail))
      ).pipe(Effect.mapError((cause) => new MailFailed({ step: "reading the mail", cause })));
      const delivered = yield* deliverMail(pidgeonKey.value, localPart, mail).pipe(
        Effect.provide(PidgeonSource.layer)
      );
      yield* Console.error(
        Option.match(delivered, {
          onNone: () => `  ${name}: its address isn't in Pidgeon any more, so it gets no mail.`,
          onSome: (done) =>
            `  ${name}: ${done.messages} messages in ${done.conversations} conversations delivered through Pidgeon's test inbound mail.`
        })
      );
    }
  }
  for (const patch of scenario.patches) {
    const key = "repo" in patch ? patch.repo : patch.name;
    const missing =
      "repo" in patch ? (patch.connections ?? []).filter((name) => skipped.has(name)) : [];
    if (missing.length > 0) {
      yield* Console.error(`  ${key}: skipped, because ${missing.join(" and ")} wasn't connected.`);
      continue;
    }
    const owner = ownerOf(patch);
    // Anyone but the publisher publishes with a token of their own, which ends once `up` is done.
    if (owner.key !== scenario.publisher) yield* allowPublishing(scenario, owner);
    const asOwner =
      owner.key === scenario.publisher
        ? env
        : { ...env, PATCHY_API_URL: manifest.apiUrl, PATCHY_API_TOKEN: tokenOf(scenario, owner) };
    const repo = path.join(layout.workspace, key);
    // The repo's pinned CLI, run directly on the environment's Node: it finds the
    // repo's workerd for tier 2 inspection, and pnpm's own output stays out of the JSON.
    const pinned = path.join(repo, "node_modules", "patchy", "dist", "index.js");
    const node = path.join(layout.bin, "node");
    const file =
      "repo" in patch ? "" : path.join(layout.workspace, "pages", path.basename(patch.file));
    /** The CLI as the patch's owner: a repo's own in the repo, or the environment's with the page. */
    const cli = (step: string, command: string, flags: ReadonlyArray<string> = []) =>
      "repo" in patch
        ? run(step, node, [pinned, command, ...flags, "--json"], { cwd: repo, env: asOwner })
        : run(step, "patchy", [command, file, ...flags, "--json"], {
            cwd: layout.workspace,
            env: asOwner
          });
    let entry = current.patches.find((done) => done.key === key);
    if (entry === undefined) {
      if ("repo" in patch) {
        yield* Console.error(`  ${patch.repo}: init, build and publish`);
        yield* fs.remove(repo, { recursive: true, force: true });
        yield* run(
          `Initializing ${patch.repo}`,
          "patchy",
          ["init", repo, "--tier", String(patch.tier), "--purpose", patch.description, "--json"],
          { cwd: layout.workspace, env }
        );
        yield* overlay(sourceOf(path, scenarioDir, patch), repo);
        for (const read of patch.reads ?? []) {
          const source = scenario.patches.find(
            (each) => "repo" in each && each.repo === read.patch
          )!;
          const published = current.patches.find((done) => done.key === read.patch);
          const [found] =
            published === undefined ? [] : yield* stored(ownerOf(source), published.name);
          if (found === undefined)
            return yield* new StepExited({ step: `Finding ${read.patch} for ${key}`, exitCode: 1 });
          yield* run(
            `Reading ${read.patch}'s ${read.table} in ${key}`,
            node,
            [
              pinned,
              "add",
              "shared-table",
              `${found.id}/${read.table}`,
              "--as",
              read.table,
              "--json"
            ],
            { cwd: repo, env }
          );
        }
        yield* run(`Refreshing ${patch.repo}`, node, [pinned, "refresh", "--json"], {
          cwd: repo,
          env
        });
      } else {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.copyFile(sourceOf(path, scenarioDir, patch), file);
        yield* Console.error(`  ${patch.name}: publish`);
      }
      const flags =
        "repo" in patch ? [] : ["--name", patch.name, "--description", patch.description];
      // Each publish is a new version, even of the same files.
      let published = yield* decodePublish(yield* cli(`Publishing ${key}`, "publish", flags));
      for (let version = 2; version <= (patch.versions ?? 1); version++)
        published = yield* decodePublish(yield* cli(`Publishing ${key} again`, "publish", flags));
      entry = { key, ...published, sampled: !("repo" in patch) || patch.sampleData !== true };
      yield* record(entry);
    }
    if (!entry.sampled) {
      yield* Console.error(`  ${key}: loading sample data as ${publisher.name}`);
      yield* loadSampleData(manifest.apiUrl, publisher.email, entry.address);
      entry = { ...entry, sampled: true };
      yield* record(entry);
    }
    const ending =
      patch.deleted !== undefined ? "delete" : patch.retired !== undefined ? "retire" : null;
    // One an interrupted `up` already retired or deleted is past sharing and ending.
    const [state] = yield* stored(owner, entry.name);
    if (ending !== null && entry.ended !== true && state?.live === false) {
      entry = { ...entry, ended: true };
      yield* record(entry);
    }
    if (entry.ended !== true && entry.shared !== true && guestsOf(patch).length > 0) {
      for (const guest of guestsOf(patch))
        yield* cli(`Sharing ${key} with ${guest.name}`, "share", ["--add", guest.email]);
      entry = { ...entry, shared: true };
      yield* record(entry);
    }
    if (ending !== null && entry.ended !== true) {
      yield* Console.error(
        `  ${key}: ${ending === "delete" ? "deleting" : "retiring"} as ${owner.name}`
      );
      yield* cli(
        `${ending === "delete" ? "Deleting" : "Retiring"} ${key}`,
        ending,
        ending === "delete" ? ["--yes"] : []
      );
      yield* record({ ...entry, ended: true });
    }
  }
  yield* writeHistory(
    scenario,
    scenario.patches.flatMap((patch) => {
      const done = current.patches.find(
        (each) => each.key === ("repo" in patch ? patch.repo : patch.name)
      );
      return done === undefined ? [] : [{ patch, name: done.name }];
    })
  );
  return current;
});

/** The instance's database as `up` writes a scenario into it, sealing with the instance's own keys. */
const scenarioDatabase = (plan: Plan) =>
  Layer.mergeAll(Users.layer, InvocationLog.layer, RuntimeLog.layer).pipe(
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const keys = yield* readCredentialKeys(path.join(plan.stateDir, "dev.env"));
          return CredentialKeys.layerFromKeys(keys);
        })
      )
    ),
    Layer.provideMerge(layerFromUrl(Redacted.make(plan.databaseUrl))),
    Layer.provideMerge(NodeCryptography.layer)
  );

/**
 * Builds everything outside the instance, resuming an `up` that stopped
 * halfway. A finished environment only rewrites its launchers (`writeAgent`,
 * `writeWorkers`) and moves its CLI and workspace repos to the instance's
 * current release, which changes when bundled code changed.
 */
export const setUp = Effect.fn("Environment.setUp")(function* (
  plan: Plan,
  loaded: { readonly name: string; readonly dir: string; readonly scenario: Scenario }
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = layoutOf(yield* environmentDir(plan.worktree), path);
  const env = yield* childEnv(layout);
  const release = yield* currentRelease(plan.apiUrl);
  const existing = yield* readManifest(layout);
  if (Option.isSome(existing) && existing.value.complete) {
    yield* writeAgent(layout, plan.apiUrl);
    yield* writeWorkers(layout, plan);
    // A dev mailbox a restart stopped starts again; its connection is already made.
    for (const connection of liveConnections(loaded.scenario))
      if (connection.integration === "imap")
        yield* mailboxFor(layout, plan, loaded.dir, loaded.scenario, connection);
    if (existing.value.release === release) return existing.value;
    yield* Console.error("The instance's release changed; updating the CLI and workspace repos.");
    yield* installCli(layout, release);
    for (const repo of yield* workspaceRepos(layout))
      yield* run(`Refreshing ${path.basename(repo)}`, "patchy", ["refresh", "--json"], {
        cwd: repo,
        env
      });
    const manifest = { ...existing.value, release };
    yield* fs.writeFileString(layout.manifest, encodeManifest(manifest));
    return manifest;
  }
  const { scenario } = loaded;
  const started: Manifest = Option.getOrElse(existing, () => ({
    apiUrl: plan.apiUrl,
    scenario: loaded.name,
    company: scenario.company,
    people: scenario.people,
    publisher: scenario.publisher,
    release,
    patches: [],
    complete: false
  }));
  yield* fs.makeDirectory(layout.workspace, { recursive: true });
  yield* fs.writeFileString(layout.manifest, encodeManifest(started));
  yield* Console.error(`${Option.isSome(existing) ? "Resuming" : "Setting up"} ${layout.dir}`);
  yield* installCli(layout, release);
  yield* run(
    "Logging the CLI in",
    "patchy",
    ["auth", "set", "--token-stdin", "--api-url", plan.apiUrl, "--json"],
    { cwd: layout.dir, env, input: publisherToken(scenario) }
  );
  yield* writeWorkspace(layout);
  yield* writeAgent(layout, plan.apiUrl);
  yield* writeWorkers(layout, plan);
  // Repos published before an interruption are bound to the release they were
  // built on; move them to this one before the manifest records it.
  if (started.release !== release)
    for (const done of started.patches) {
      const repo = path.join(layout.workspace, done.key);
      if (yield* fs.exists(path.join(repo, "patchy.json")))
        yield* run(`Refreshing ${done.key}`, "patchy", ["refresh", "--json"], { cwd: repo, env });
    }
  const published = yield* materialize(layout, plan, loaded.dir, scenario, {
    ...started,
    release
  }).pipe(Effect.provide(scenarioDatabase(plan)));
  const manifest: Manifest = { ...published, release, complete: true };
  yield* fs.writeFileString(layout.manifest, encodeManifest(manifest));
  return manifest;
});

export const printCard = (manifest: Manifest, layout: Layout) => {
  const width = Math.max(...manifest.people.map((person) => person.key.length));
  const people = manifest.people.map(
    (person) =>
      `    ${person.key.padEnd(width)}  ${person.name} · ${person.role}${person.company === undefined ? "" : ` at ${person.company}`}${person.deactivated === true ? " · deactivated" : ""}${person.key === manifest.publisher ? " · the CLI publishes as them" : ""}`
  );
  const patches = manifest.patches.map((patch) => `    ${patch.address}`);
  return Console.log(
    [
      `${manifest.company.name} is up at ${manifest.apiUrl}  (scenario ${manifest.scenario})`,
      "",
      "  People       pnpm dev open <person>  (or any browser: /dev/sign-in)",
      ...people,
      ...(patches.length === 0 ? [] : ["", "  Patches", ...patches]),
      "",
      `  Agent        ${layout.agent}`,
      `  Workers      ${layout.claudeWorker}  (Claude Code; /mcp signs in on the consent page)`,
      `               ${layout.codexWorker} <person>  (Codex, as that person)`,
      `  Workspace    ${layout.workspace}`,
      "  End          pnpm dev down"
    ].join("\n")
  );
};

const BROWSERS = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "brave-browser",
  "microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
];

const browserBinary = Effect.fn("browserBinary")(function* () {
  const configured = yield* Config.option(Config.String("PATCHY_BROWSER"));
  if (Option.isSome(configured)) return configured.value;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dirs = (yield* Config.String("PATH").pipe(Config.withDefault(""))).split(PATH_DELIMITER);
  for (const candidate of BROWSERS) {
    const found = path.isAbsolute(candidate)
      ? [candidate]
      : dirs.map((d) => path.join(d, candidate));
    for (const file of found) if (yield* fs.exists(file)) return file;
  }
  return yield* new NoBrowser();
});

/** One of a scenario's people, by key, email or the start of their name. */
export const findPerson = (manifest: { readonly people: ReadonlyArray<Person> }, query: string) => {
  const needle = query.toLowerCase();
  const person =
    manifest.people.find((p) => p.key === needle || p.email.toLowerCase() === needle) ??
    manifest.people.find((p) => p.name.toLowerCase().startsWith(needle));
  return person === undefined
    ? Effect.fail(new PersonNotFound({ query, people: manifest.people.map((p) => p.key) }))
    : Effect.succeed(person);
};

/** A browser window with its own profile, signed in as the person and opened at `target`. */
export const openPerson = Effect.fn("Environment.openPerson")(function* (
  worktree: string,
  manifest: Manifest,
  query: string,
  target: string
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const layout = layoutOf(yield* environmentDir(worktree), path);
  const person = yield* findPerson(manifest, query);
  const url = `${manifest.apiUrl}/dev/sign-in?as=${encodeURIComponent(person.email)}&return=${encodeURIComponent(target)}`;
  const browser = yield* Effect.scoped(
    spawner
      .spawn(
        ChildProcess.make(
          yield* browserBinary(),
          [
            `--user-data-dir=${path.join(layout.browsers, person.key)}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--new-window",
            url
          ],
          { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
        )
      )
      .pipe(Effect.tap((handle) => handle.unref))
  );
  yield* Console.log(`Opened ${person.name} (pid ${browser.pid}) at ${url}`);
});

/** What `pnpm dev shot` saw: where the page landed, its HTTP status and the browser's errors. */
export const Shot = Schema.Struct({
  url: Schema.String,
  status: Schema.NullOr(Schema.Int),
  file: Schema.String,
  errors: Schema.Array(Schema.String)
});
export type Shot = typeof Shot.Type;

/**
 * A full-page PNG of `target` as `email`, signed in through the personas door,
 * with every console error and uncaught exception from the page and its patch
 * frames. A page holding a live stream never goes network-idle, so settling
 * waits at most five seconds.
 */
export const screenshot = Effect.fn("Environment.screenshot")(function* (
  apiUrl: string,
  email: string,
  target: string,
  file: string
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<Shot> => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const errors: Array<string> = [];
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        page.on("pageerror", (error) => errors.push(error.message));
        const response = await page.goto(
          `${apiUrl}/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent(target)}`
        );
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        await page.screenshot({ path: file, fullPage: true });
        return { url: page.url(), status: response?.status() ?? null, file, errors };
      } finally {
        await browser.close();
      }
    },
    catch: (cause) => new ScreenshotFailed({ target, cause })
  });
});

/**
 * Stops what `up` started outside the instance: patch dev sessions in the
 * workspace and the persons' browsers. Then deletes the environment folder.
 */
export const tearDown = Effect.fn("Environment.tearDown")(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = layoutOf(yield* environmentDir(worktree), path);
  if (!(yield* fs.exists(layout.dir))) return false;
  const env = yield* childEnv(layout);
  for (const repo of yield* workspaceRepos(layout))
    if (yield* fs.exists(path.join(repo, ".patchy", "dev")))
      yield* run(
        `Stopping ${path.basename(repo)}'s dev session`,
        "patchy",
        ["dev", "stop", "--json"],
        { cwd: repo, env }
      ).pipe(Effect.ignore);
  // `--` keeps the pattern from reading as an option. pkill and pgrep exit 1
  // when nothing matches and above 1 on failure. Profiles are deleted only
  // once their browsers are confirmed gone.
  const browsers = ["-f", "--", `--user-data-dir=${layout.browsers}`];
  const options = { cwd: layout.dir, env };
  const signal = Effect.fn("signalBrowsers")(function* (step: string, args: ReadonlyArray<string>) {
    const { exitCode } = yield* exec(step, "pkill", args, options);
    if (exitCode > 1) return yield* new StepExited({ step, exitCode });
  });
  const gone = Effect.fn("browsersGone")(function* (polls: number) {
    for (let poll = 0; poll < polls; poll++) {
      const { exitCode } = yield* exec("Waiting for browsers", "pgrep", browsers, options);
      if (exitCode === 1) return true;
      if (exitCode !== 0) return yield* new StepExited({ step: "Waiting for browsers", exitCode });
      yield* Effect.sleep("250 millis");
    }
    return false;
  });
  yield* signal("Closing browsers", browsers);
  if (!(yield* gone(20))) {
    yield* signal("Killing browsers", ["-KILL", ...browsers]);
    if (!(yield* gone(8))) return yield* new BrowsersStillRunning({ profiles: layout.browsers });
  }
  yield* fs.remove(layout.dir, { recursive: true, force: true });
  return true;
});

export const layoutFor = Effect.fn("layoutFor")(function* (worktree: string) {
  const path = yield* Path.Path;
  return layoutOf(yield* environmentDir(worktree), path);
});
