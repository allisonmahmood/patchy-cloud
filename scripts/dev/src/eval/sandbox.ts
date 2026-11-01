/**
 * The sandbox `pnpm dev eval` runs builders and their setup in: `bwrap` with
 * the system read-only, a private `/tmp` and a HOME of the run's own at
 * `/home/builder`, which holds its own toolchain, installed there the way a
 * person installs one (`home.ts`). Nothing else of this machine is mounted:
 * no home folder, no Patchy checkout, no tool installs, no personal agent
 * settings, skills or instructions, so what a builder knows about Patchy is
 * what a real user's agent would find. The network is the sandbox's own: loopback only,
 * where the bridge (`bridge.mjs`, run ahead of every command) serves the
 * instance's port and a proxy to the public internet (`network.ts`), so nothing
 * on this machine's network, its databases included, is reachable.
 *
 * Inside, builders run with every permission their harness has: the sandbox is
 * the boundary, so a failure measures Patchy rather than a permission prompt.
 */
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { spawnStep, stepOutput } from "../steps.js";
import { type Network, PROXY_PORT } from "./network.js";

export class NoSandbox extends Schema.TaggedError<NoSandbox>()("NoSandbox", {}) {
  override get message() {
    return "`pnpm dev eval` runs builders in bubblewrap, and `bwrap --version` failed. Install bubblewrap (the `bubblewrap` package) and run again.";
  }
}

/** The HOME every sandbox sees; the run's folder on this machine is mounted here. */
export const HOME = "/home/builder";

/**
 * The versions a suite's builders get, pinned to this machine's own so a run
 * here behaves as the developer's tools do; `latest` for a tool it lacks.
 */
export const Toolchain = Schema.Struct({
  node: Schema.String,
  pnpm: Schema.String,
  claude: Schema.String,
  codex: Schema.String
});
export type Toolchain = typeof Toolchain.Type;

/** The version in a tool's `--version` line: `v24.20.0`, `2.1.316 (Claude Code)`, `codex-cli 0.166.0`. */
export const versionOf = (line: string) => /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(line)?.[1];

/** A file or folder to mount besides HOME. */
export interface Bind {
  readonly from: string;
  readonly to: string;
  readonly readOnly: boolean;
}

export interface SandboxSpec {
  /** The run's HOME on this machine. */
  readonly home: string;
  readonly network: Network;
  /** Variables beyond the sandbox's own HOME, PATH, TMPDIR, USER, LANG and TERM. */
  readonly env?: Readonly<Record<string, string>>;
  readonly binds?: ReadonlyArray<Bind>;
  /** Where the command starts, inside the sandbox; HOME when omitted. */
  readonly cwd?: string;
}

/** The PATH inside: the user's own bin (npm's global tools, `patchy`), their Node, the system. */
export const SANDBOX_PATH = `${HOME}/.local/bin:${HOME}/.local/node/bin:/usr/bin`;

const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const LOCAL = "localhost,127.0.0.1,::1,.localhost";

/** Every name clients read their proxy from: curl, Claude Code, Codex, pnpm, and Node's own fetch with `NODE_USE_ENV_PROXY`. */
const PROXY_ENV = {
  HTTPS_PROXY: PROXY,
  HTTP_PROXY: PROXY,
  https_proxy: PROXY,
  http_proxy: PROXY,
  NO_PROXY: LOCAL,
  no_proxy: LOCAL,
  NODE_USE_ENV_PROXY: "1",
  npm_config_proxy: PROXY,
  npm_config_https_proxy: PROXY
};

/**
 * `bwrap`'s arguments for running `command args` in the sandbox. Pure, so what
 * a builder can reach is tested rather than trusted: the system read-only, a
 * private `/tmp` and `/dev/shm`, HOME read-write, a network of its own with
 * the runner's two sockets, and nothing of this machine's own HOME. The
 * command runs behind the bridge, on the runner's own `node` binary, mounted
 * alone: the sandbox's toolchain may not be installed yet.
 */
export const bwrapArgs = (
  spec: SandboxSpec,
  command: string,
  args: ReadonlyArray<string>
): ReadonlyArray<string> => [
  "--die-with-parent",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-net",
  "--new-session",
  ...["--ro-bind", "/usr", "/usr"],
  ...["--symlink", "usr/bin", "/bin", "--symlink", "usr/bin", "/sbin"],
  ...["--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64"],
  ...["--ro-bind", "/etc", "/etc"],
  ...["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/dev/shm"],
  ...["--tmpfs", "/tmp", "--tmpfs", "/run"],
  // systemd-resolved hosts point /etc/resolv.conf here.
  ...["--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve"],
  ...["--tmpfs", "/home", "--bind", spec.home, HOME],
  ...["--ro-bind", spec.network.sockets, "/run/eval"],
  ...["--ro-bind", spec.network.bridge, "/opt/eval/bridge.mjs"],
  ...["--ro-bind", spec.network.node, "/opt/eval/node"],
  ...(spec.binds ?? []).flatMap((bind) => [
    bind.readOnly ? "--ro-bind" : "--bind",
    bind.from,
    bind.to
  ]),
  "--clearenv",
  ...Object.entries({
    HOME,
    USER: "builder",
    LANG: "C.UTF-8",
    TERM: "dumb",
    TMPDIR: "/tmp",
    PATH: SANDBOX_PATH,
    ...PROXY_ENV,
    ...spec.env
  }).flatMap(([name, value]) => ["--setenv", name, value]),
  ...["--chdir", spec.cwd ?? HOME],
  "--",
  "/opt/eval/node",
  "/opt/eval/bridge.mjs",
  String(spec.network.instancePort),
  "--",
  command,
  ...args
];

/** Fails before anything starts when bubblewrap is missing. */
export const checkSandbox = Effect.fn("Sandbox.check")(function* (root: string) {
  yield* stepOutput("Checking bubblewrap", "bwrap", ["--version"], {
    cwd: root,
    prefix: "bwrap"
  }).pipe(Effect.mapError(() => new NoSandbox()));
});

/**
 * The versions to install in builders' homes: this runner's Node, and the
 * developer's pnpm, Claude Code and Codex as their `--version` says, or
 * `latest` for one this machine doesn't have.
 */
export const readToolchain = Effect.fn("Sandbox.readToolchain")(function* (root: string) {
  const read = (command: string) =>
    spawnStep(`Reading ${command}'s version`, command, ["--version"], {
      cwd: root,
      prefix: command
    }).pipe(
      Effect.map(({ stdout, exitCode }) => (exitCode === 0 ? versionOf(stdout) : undefined)),
      Effect.orElseSucceed(() => undefined)
    );
  return {
    node: process.versions.node,
    pnpm: (yield* read("pnpm")) ?? "latest",
    claude: (yield* read("claude")) ?? "latest",
    codex: (yield* read("codex")) ?? "latest"
  } satisfies Toolchain;
});

/** How a sandboxed command ended. */
export interface Ran {
  readonly stdout: string;
  /** The last few thousand characters of stderr. */
  readonly stderr: string;
  /** Null when it was stopped at its timeout. */
  readonly exitCode: number | null;
}

const STDERR_TAIL = 8_000;

/**
 * Runs `command` in the sandbox to completion, `input` on its stdin: its
 * stdout, its exit code and the tail of stderr. For setup and grading, which
 * wait for their commands; builders stream through their harness adapters.
 * The sandbox leads its process group, so a timeout ends everything in it.
 */
export const runSandboxed = Effect.fn("Sandbox.run")(function* (
  spec: SandboxSpec,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly timeout?: Duration.Input } = {}
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("bwrap", [...bwrapArgs(spec, command, args)], {
          cwd: spec.home,
          env: { PATH: "/usr/bin:/bin" },
          extendEnv: false,
          stdin:
            options.input === undefined
              ? "ignore"
              : Stream.make(new TextEncoder().encode(options.input)),
          forceKillAfter: "2 seconds"
        })
      );
      const output = Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (tail, chunk) => `${tail}${chunk}`.slice(-STDERR_TAIL)
            )
          ),
          handle.exitCode.pipe(Effect.map(Number))
        ],
        { concurrency: "unbounded" }
      );
      const ran = yield* output.pipe(Effect.timeoutOption(options.timeout ?? "10 minutes"));
      if (Option.isSome(ran)) {
        const [stdout, stderr, exitCode] = ran.value;
        return { stdout, stderr, exitCode } satisfies Ran;
      }
      yield* Effect.ignore(handle.kill({ forceKillAfter: "2 seconds" }));
      return { stdout: "", stderr: "", exitCode: null } satisfies Ran;
    })
  );
});
