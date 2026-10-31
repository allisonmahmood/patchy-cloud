/**
 * The sandbox `pnpm dev eval` runs builders and their setup in: `bwrap` with
 * the system read-only, the toolchain read-only under `/opt`, a private `/tmp`
 * and a HOME of the run's own at `/home/builder`. Nothing else of this machine
 * is mounted: no home folder, no Patchy checkout, no personal agent settings,
 * skills or instructions, so what a builder knows about Patchy is what a real
 * user's agent would find. The network is shared, so the instance, the model
 * providers and the npm registry answer, and `*.localhost` resolves.
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

export class ToolTooExposed extends Schema.TaggedError<ToolTooExposed>()("ToolTooExposed", {
  tool: Schema.String,
  folder: Schema.String
}) {
  override get message() {
    return `\`${this.tool}\` lives in ${this.folder}, and mounting that folder would show builders your home or this checkout. Install it somewhere of its own, such as through mise, and run again.`;
  }
}

/** The HOME every sandbox sees; the run's folder on this machine is mounted here. */
export const HOME = "/home/builder";

/** The tools a sandbox mounts. Git, a browser and the rest of the system come from `/usr`. */
export const TOOL_NAMES = ["node", "pnpm", "claude", "codex"] as const;

/** One tool as the sandbox mounts it, resolved once per suite so every run gets the same build. */
export const Tool = Schema.Struct({
  name: Schema.String,
  /** The folder on this machine mounted at `/opt/<name>`; null when it is already under `/usr`. */
  root: Schema.NullOr(Schema.String),
  /** The PATH entry inside the sandbox. */
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
    ...tools.flatMap((tool) => (tool.path === null ? [] : [tool.path])),
    "/usr/bin"
  ].join(":");

/**
 * `bwrap`'s arguments for running `command args` in the sandbox. Pure, so the
 * mounts a builder sees are tested rather than trusted: the system read-only,
 * each tool at `/opt/<name>`, a private `/tmp` and `/dev/shm`, HOME read-write,
 * and nothing of this machine's own HOME.
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
  ...spec.tools.flatMap((tool) =>
    tool.root === null ? [] : ["--ro-bind", tool.root, `/opt/${tool.name}`]
  ),
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
    ...spec.env
  }).flatMap(([name, value]) => ["--setenv", name, value]),
  ...["--chdir", spec.cwd ?? HOME],
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
 * Where each tool lives, resolved through PATH and symlinks to its real
 * install, and through mise's wrappers when that is what PATH holds. A tool
 * under `/usr` needs no mount. One in a folder that holds this machine's HOME
 * or the checkout is refused: mounting it would show builders both.
 */
export const resolveTools = Effect.fn("Sandbox.resolveTools")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME");
  const dirs = (yield* Config.String("PATH").pipe(Config.withDefault(""))).split(":");
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
      tools.push({ name, root: null, path: null, version });
      continue;
    }
    const dir = path.dirname(real);
    const inBin = path.basename(dir) === "bin";
    const mounted = inBin ? path.dirname(dir) : dir;
    const covers = (outer: string, inner: string) =>
      inner === outer || inner.startsWith(`${outer}${path.sep}`);
    if (covers(mounted, home) || covers(mounted, root) || mounted === path.parse(mounted).root)
      return yield* new ToolTooExposed({ tool: name, folder: mounted });
    tools.push({
      name,
      root: mounted,
      path: inBin ? `/opt/${name}/bin` : `/opt/${name}`,
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
