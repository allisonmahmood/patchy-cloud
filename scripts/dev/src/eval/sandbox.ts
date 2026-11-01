/**
 * The sandbox `pnpm dev eval` runs builders and their setup in: `bwrap` with
 * the system read-only, the toolchain read-only under `/opt`, a private `/tmp`
 * and a HOME of the run's own at `/home/builder`. Nothing else of this machine
 * is mounted: no home folder, no Patchy checkout, no personal agent settings,
 * skills or instructions, so what a builder knows about Patchy is what a real
 * user's agent would find. The network is the sandbox's own: loopback only,
 * where the bridge (`bridge.mjs`, run ahead of every command) serves the
 * instance's port and a proxy to the public internet (`network.ts`), so nothing
 * on this machine's network, its databases included, is reachable.
 *
 * Inside, builders run with every permission their harness has: the sandbox is
 * the boundary, so a failure measures Patchy rather than a permission prompt.
 */
import * as Config from "effect/Config";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { stepOutput } from "../steps.js";
import { type Network, PROXY_PORT } from "./network.js";

export class NoSandbox extends Schema.TaggedError<NoSandbox>()("NoSandbox", {}) {
  override get message() {
    return "`pnpm dev eval` runs builders in bubblewrap, and `bwrap --version` failed. Install bubblewrap (the `bubblewrap` package) and run again.";
  }
}

export class ToolMissing extends Schema.TaggedError<ToolMissing>()("ToolMissing", {
  tool: Schema.String
}) {
  override get message() {
    return `\`pnpm dev eval\` needs \`${this.tool}\` on PATH, and it isn't there.`;
  }
}

/** The HOME every sandbox sees; the run's folder on this machine is mounted here. */
export const HOME = "/home/builder";

/** The tools a sandbox mounts. Git, a browser and the rest of the system come from `/usr`. */
export const TOOL_NAMES = ["node", "pnpm", "claude", "codex"] as const;

/** One tool as the sandbox mounts it, resolved once per suite so every run gets the same build. */
export const Tool = Schema.Struct({
  name: Schema.String,
  /** What this machine mounts, its install or the executable alone; null when it is already under `/usr`. */
  from: Schema.NullOr(Schema.String),
  /** Where it is mounted inside the sandbox. */
  to: Schema.NullOr(Schema.String),
  /** The executable inside the sandbox, linked as `/opt/bin/<name>`, whatever its own file is called. */
  link: Schema.NullOr(Schema.String),
  /** An extra PATH entry, for a tool whose install holds commands of its own: Node's npm and npx. */
  path: Schema.NullOr(Schema.String),
  /** The first line of `<tool> --version`, for the record. */
  version: Schema.String
});
export type Tool = typeof Tool.Type;

/** A folder to mount besides the toolchain and HOME. */
export interface Bind {
  readonly from: string;
  readonly to: string;
  readonly readOnly: boolean;
}

export interface SandboxSpec {
  /** The run's HOME on this machine. */
  readonly home: string;
  readonly tools: ReadonlyArray<Tool>;
  readonly network: Network;
  /** Variables beyond the sandbox's own HOME, PATH, TMPDIR, USER, LANG and TERM. */
  readonly env?: Readonly<Record<string, string>>;
  readonly binds?: ReadonlyArray<Bind>;
  /** Where the command starts, inside the sandbox; HOME when omitted. */
  readonly cwd?: string;
}

/** The PATH inside: the user's own bin (where the Patchy installer puts `patchy`), the tools, the system. */
export const sandboxPath = (tools: ReadonlyArray<Tool>) =>
  [
    `${HOME}/.local/bin`,
    "/opt/bin",
    ...tools.flatMap((tool) => (tool.path === null ? [] : [tool.path])),
    "/usr/bin"
  ].join(":");

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
 * a builder can reach is tested rather than trusted: the system read-only,
 * each tool under `/opt`, a private `/tmp` and `/dev/shm`, HOME read-write, a
 * network of its own with the runner's two sockets, and nothing of this
 * machine's own HOME. The command runs behind the bridge.
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
  ...spec.tools.flatMap((tool) => [
    ...(tool.from === null || tool.to === null ? [] : ["--ro-bind", tool.from, tool.to]),
    ...(tool.link === null ? [] : ["--symlink", tool.link, `/opt/bin/${tool.name}`])
  ]),
  ...["--ro-bind", spec.network.sockets, "/run/eval"],
  ...["--ro-bind", spec.network.bridge, "/opt/eval/bridge.mjs"],
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
    PATH: sandboxPath(spec.tools),
    ...PROXY_ENV,
    ...spec.env
  }).flatMap(([name, value]) => ["--setenv", name, value]),
  ...["--chdir", spec.cwd ?? HOME],
  "--",
  "node",
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
 * Folders that are never mounted whole, because they hold more than one
 * tool's install: personal state, shared bins, and anything around this
 * checkout or the dev runner's environments.
 */
const sharedFolders = (home: string, root: string, path: Path.Path) => {
  const personal = [".local", ".local/bin", ".local/share", "bin", ".config", ".cache"].map((dir) =>
    path.join(home, dir)
  );
  return (folder: string) => {
    const covers = (inner: string) => inner === folder || inner.startsWith(`${folder}${path.sep}`);
    return (
      personal.includes(folder) ||
      covers(home) ||
      covers(root) ||
      covers(path.join(home, ".local", "share", "patchy-dev")) ||
      folder === "/usr/local/bin"
    );
  };
};

/** How far up from an executable to look for the npm package it belongs to. */
const PACKAGE_DEPTH = 4;

/**
 * Where each tool lives, resolved through PATH and symlinks to its real
 * install, and through mise's wrappers when that is what PATH holds. A tool
 * under `/usr` needs no mount. Otherwise the tool's own install is mounted,
 * the first that applies:
 *
 * 1. the install above its `bin` folder (Node's, with npm beside it; Codex's,
 *    with its resources);
 * 2. the npm package it is part of, so a launcher finds its files;
 * 3. its own folder;
 * 4. the executable alone.
 *
 * A folder counts as the tool's own only when it is named for the tool or
 * sits in a folder that is (`…/codex/0.166.0`, `…/node_modules/pnpm`,
 * `…/claude/versions`), and never when it is shared: a `bin` folder of
 * someone's own scripts is not an install. The executable is then linked as
 * `/opt/bin/<name>`, whatever it is called.
 */
export const resolveTools = Effect.fn("Sandbox.resolveTools")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME");
  const shared = sharedFolders(home, root, path);
  /** Whether `folder` is `name`'s own: named for it, or inside a folder that is, and not shared. */
  const owned = (name: string, folder: string) =>
    !shared(folder) &&
    [path.basename(folder), path.basename(path.dirname(folder))].some((segment) =>
      segment.toLowerCase().startsWith(name)
    );
  const dirs = (yield* Config.String("PATH").pipe(Config.withDefault(""))).split(":");
  /** The nearest folder above `file`, below any shared one, holding a package.json. */
  const packageOf = Effect.fn(function* (file: string) {
    let dir = path.dirname(file);
    for (
      let depth = 0;
      depth < PACKAGE_DEPTH && !shared(dir) && dir !== path.dirname(dir);
      depth++
    ) {
      if (yield* fs.exists(path.join(dir, "package.json"))) return dir;
      dir = path.dirname(dir);
    }
    return undefined;
  });
  const tools: Array<Tool> = [];
  for (const name of TOOL_NAMES) {
    let found: string | undefined;
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (dir !== "" && (yield* fs.exists(candidate))) {
        found = candidate;
        break;
      }
    }
    if (found === undefined) return yield* new ToolMissing({ tool: name });
    let real = yield* fs.realPath(found);
    if (path.basename(real) === "mise")
      real = yield* fs.realPath(
        yield* stepOutput(`Finding ${name}`, "mise", ["which", name], { cwd: root, prefix: "mise" })
      );
    const version = (yield* stepOutput(`Reading ${name}'s version`, real, ["--version"], {
      cwd: root,
      prefix: name
    }))
      .split("\n")[0]!
      .trim();
    if (real.startsWith("/usr/")) {
      tools.push({ name, from: null, to: null, link: null, path: null, version });
      continue;
    }
    const dir = path.dirname(real);
    const install = path.dirname(dir);
    const pkg = yield* packageOf(real);
    const mounted =
      path.basename(dir) === "bin" && owned(name, install)
        ? install
        : pkg !== undefined && owned(name, pkg)
          ? pkg
          : owned(name, dir)
            ? dir
            : real;
    const to = `/opt/${name}`;
    tools.push({
      name,
      from: mounted,
      to: mounted === real ? `${to}/${path.basename(real)}` : to,
      link:
        mounted === real
          ? `${to}/${path.basename(real)}`
          : path.join(to, path.relative(mounted, real)),
      path: name === "node" && mounted !== real ? `${to}/bin` : null,
      version
    });
  }
  return tools;
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
