// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalTimers:off globalTimersInEffect:off globalDate:off preferSchemaOverJson:off -- direct child ownership and wall-clock startup work under TestClock; JSON encodes validated callback config and pinned compatibility flags.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chown, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as GuestProtocol from "@patchy/api/guest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WorkerdError extends Schema.TaggedError<WorkerdError>()("WorkerdError", {
  stage: Schema.Literals(["binary", "bundle", "config", "spawn", "startup", "sample"]),
  reason: Schema.Literals([
    "unsupported_platform",
    "resolution_failed",
    "build_failed",
    "unsupported_import",
    "empty_output",
    "invalid_callback_url",
    "unavailable_port",
    "acquisition_failed",
    "exited",
    "timeout",
    "request_failed"
  ]),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  signal: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stderrBytes: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `The execution process failed at ${this.stage}.`;
  }
}
const isWorkerdError = Schema.is(WorkerdError);

class WorkerdCleanupError extends Schema.TaggedError<WorkerdCleanupError>()("WorkerdCleanupError", {
  directory: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `The reaped execution process's temporary directory ${this.directory} could not be removed.`;
  }
}

const packages: Readonly<Record<string, string>> = {
  "linux x64": "@cloudflare/workerd-linux-64",
  "linux arm64": "@cloudflare/workerd-linux-arm64",
  "darwin x64": "@cloudflare/workerd-darwin-64",
  "darwin arm64": "@cloudflare/workerd-darwin-arm64",
  "win32 x64": "@cloudflare/workerd-windows-64"
};
const decodeVersion = Schema.decodeUnknownSync(
  Schema.Struct({ version: Schema.Literal(GuestProtocol.workerdVersion) })
);

/** Resolve the pinned platform executable, never npm's Node launcher. */
const binary = Effect.gen(function* () {
  const name = packages[`${process.platform} ${process.arch}`];
  if (name === undefined)
    return yield* new WorkerdError({ stage: "binary", reason: "unsupported_platform" });
  return yield* Effect.try({
    try: () => {
      const outer = createRequire(import.meta.url);
      const manifest = outer.resolve("workerd/package.json");
      decodeVersion(outer("workerd/package.json"));
      const inner = createRequire(manifest);
      decodeVersion(inner(`${name}/package.json`));
      return join(
        dirname(inner.resolve(`${name}/package.json`)),
        "bin",
        process.platform === "win32" ? "workerd.exe" : "workerd"
      );
    },
    catch: (cause) => new WorkerdError({ stage: "binary", reason: "resolution_failed", cause })
  });
});

// The offline CLI ships this worker already bundled; tsc-built services still build their loader.
declare const __PATCHY_PACKED_LOADER__: boolean;
let source: Promise<string> | undefined;
const loaderSource = Effect.tryPromise({
  try: () =>
    (source ??= (async () => {
      if (typeof __PATCHY_PACKED_LOADER__ !== "undefined" && __PATCHY_PACKED_LOADER__)
        return await readFile(new URL("./loader.js", import.meta.url), "utf8");
      // The offline CLI omits esbuild and uses the prebuilt branch above.
      const { build } = await import("esbuild");
      const result = await build({
        entryPoints: [
          fileURLToPath(
            new URL(
              import.meta.url.endsWith(".ts") ? "./loader.ts" : "./loader.js",
              import.meta.url
            )
          )
        ],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        conditions: import.meta.url.endsWith(".ts") ? ["development"] : [],
        external: ["cloudflare:workers"],
        minify: true,
        legalComments: "none",
        metafile: true
      });
      for (const output of Object.values(result.metafile.outputs)) {
        if (output.imports.some(({ path }) => path !== "cloudflare:workers"))
          throw new WorkerdError({ stage: "bundle", reason: "unsupported_import" });
      }
      const output = result.outputFiles[0];
      if (output === undefined || output.text.length === 0)
        throw new WorkerdError({ stage: "bundle", reason: "empty_output" });
      return output.text;
    })().catch((cause) => {
      source = undefined;
      throw cause;
    })),
  catch: (cause) =>
    isWorkerdError(cause)
      ? cause
      : new WorkerdError({ stage: "bundle", reason: "build_failed", cause })
});

function config(callbackUrls: readonly string[] = []): string {
  let callback = "";
  let callbackBinding = "";
  const targets: Record<string, string> = {};
  for (const [index, callbackUrl] of callbackUrls.entries()) {
    const url = new URL(callbackUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    )
      throw new WorkerdError({ stage: "config", reason: "invalid_callback_url" });
    const address = `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    const protocol =
      url.protocol === "https:" ? "https = (tlsOptions = (trustBrowserCas = true))" : "http = ()";
    const name = `callback${index}`;
    targets[callbackUrl] = name;
    callback += `, (name = "${name}", external = (address = ${JSON.stringify(address)}, ${protocol}))`;
    callbackBinding += `, (name = "${name}", service = "${name}")`;
  }
  if (callbackUrls.length !== 0)
    callbackBinding += `, (name = "callbackUrls", json = ${JSON.stringify(JSON.stringify(targets))})`;
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "loader", worker = (
      modules = [(name = "loader.js", esModule = embed "loader.js")],
      compatibilityDate = "${GuestProtocol.compatibilityDate}",
      compatibilityFlags = ${JSON.stringify([...GuestProtocol.compatibilityFlags, "experimental"])},
      bindings = [(name = "loader", workerLoader = ())${callbackBinding}],
      globalOutbound = "internet"
    )),
    (name = "internet", network = (allow = []))${callback}
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "loader")]
);
`;
}

function reservePort(): Promise<number> {
  // Promise.withResolvers is outside this package's ES2022 library contract.
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new WorkerdError({ stage: "spawn", reason: "unavailable_port" }));
      } else server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

export interface WorkerdProcess {
  readonly url: string;
  readonly child: ChildProcess;
  readonly directory: string;
}

let nextUid = 60_000;
let clockTicks: Promise<number> | undefined;

export interface ProcessSample {
  readonly rssBytes: number;
  readonly peakRssBytes: number;
  readonly cpuSeconds: number;
}

/** Sample before killing; after exit only the supervisor's retained sample remains. */
export const sampleProcess = (
  pid: number
): Effect.Effect<ProcessSample | undefined, WorkerdError> =>
  Effect.tryPromise({
    try: async () => {
      if (process.platform === "darwin") {
        const output = await new Promise<string>((resolve, reject) => {
          execFile("ps", ["-o", "rss=", "-o", "time=", "-p", String(pid)], (error, stdout) => {
            if (error !== null && error.code !== 1) reject(error);
            else resolve(stdout);
          });
        });
        const match = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):([\d.]+)\s*$/.exec(output);
        if (match === null) return undefined;
        return {
          rssBytes: Number(match[1]) * 1024,
          peakRssBytes: Number(match[1]) * 1024,
          cpuSeconds:
            Number(match[2] ?? 0) * 86400 +
            Number(match[3] ?? 0) * 3600 +
            Number(match[4]) * 60 +
            Number(match[5])
        };
      }
      const ticks = await (clockTicks ??= new Promise<number>((resolve, reject) => {
        execFile("getconf", ["CLK_TCK"], (error, stdout) => {
          const value = Number(stdout.trim());
          if (error !== null) reject(error);
          else if (!Number.isSafeInteger(value) || value <= 0)
            reject(new Error("Invalid process CPU clock frequency"));
          else resolve(value);
        });
      }));
      try {
        const [stat, status] = await Promise.all([
          readFile(`/proc/${pid}/stat`, "utf8"),
          readFile(`/proc/${pid}/status`, "utf8")
        ]);
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return {
          cpuSeconds: (Number(fields[11]) + Number(fields[12])) / ticks,
          rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024,
          peakRssBytes: Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024
        };
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          (cause.code === "ENOENT" || cause.code === "ESRCH")
        )
          return undefined;
        throw cause;
      }
    },
    catch: (cause) => new WorkerdError({ stage: "sample", reason: "request_failed", cause })
  });

/** A direct process for tests and inspection. The owning scope kills and reaps it. */
export const startWorkerd = Effect.fn("Execution.startWorkerd")(function* (
  options: {
    readonly callbackUrls?: readonly string[];
    readonly separateUid?: boolean;
  } = {}
) {
  const executable = yield* binary;
  const loader = yield* loaderSource;
  const configuration = yield* Effect.try({
    try: () => config(options.callbackUrls),
    catch: (cause) =>
      isWorkerdError(cause)
        ? cause
        : new WorkerdError({ stage: "config", reason: "invalid_callback_url", cause })
  });
  const resource = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const directory = await mkdtemp(join(tmpdir(), "patchy-execution-"));
        try {
          await Promise.all([
            writeFile(join(directory, "loader.js"), loader),
            writeFile(join(directory, "config.capnp"), configuration)
          ]);
          const uid = options.separateUid && process.getuid?.() === 0 ? nextUid++ : undefined;
          if (uid !== undefined) {
            await Promise.all([
              chown(directory, uid, uid),
              chown(join(directory, "loader.js"), uid, uid),
              chown(join(directory, "config.capnp"), uid, uid)
            ]);
          }
          const port = await reservePort();
          // An inherited descriptor lets a dropped UID execute the pinned binary even
          // when the package manager keeps it below a root-only home directory.
          const executableFd =
            uid !== undefined && process.platform === "linux"
              ? openSync(executable, "r")
              : undefined;
          let child: ChildProcess;
          try {
            child = spawn(
              executableFd === undefined ? executable : "/proc/self/fd/3",
              [
                "serve",
                join(directory, "config.capnp"),
                "--experimental",
                `--socket-addr=http=127.0.0.1:${port}`
              ],
              {
                stdio:
                  executableFd === undefined
                    ? ["ignore", "ignore", "pipe"]
                    : ["ignore", "ignore", "pipe", executableFd],
                env: {},
                ...(uid === undefined ? {} : { uid, gid: uid })
              }
            );
          } finally {
            if (executableFd !== undefined) closeSync(executableFd);
          }
          let stderrBytes = 0;
          let spawnError: Error | undefined;
          child.stderr?.on("data", (chunk: Buffer) => {
            stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.byteLength);
          });
          child.once("error", (error) => {
            spawnError = error;
          });
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          let disposal: Promise<void> | undefined;
          const dispose = () =>
            (disposal ??= (async () => {
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              await closed;
            })());
          return {
            url: `http://127.0.0.1:${port}`,
            child,
            directory,
            dispose,
            failure: (reason: "exited" | "timeout") =>
              new WorkerdError({
                stage: "startup",
                reason,
                exitCode: child.exitCode,
                signal: child.signalCode,
                stderrBytes,
                ...(spawnError === undefined ? {} : { cause: spawnError })
              })
          };
        } catch (cause) {
          await rm(directory, { recursive: true, force: true });
          throw cause;
        }
      },
      catch: (cause) =>
        isWorkerdError(cause)
          ? cause
          : new WorkerdError({ stage: "spawn", reason: "acquisition_failed", cause })
    }),
    (resource) =>
      Effect.gen(function* () {
        yield* Effect.promise(resource.dispose);
        yield* Effect.tryPromise({
          try: () => rm(resource.directory, { recursive: true, force: true }),
          catch: (cause) => new WorkerdCleanupError({ directory: resource.directory, cause })
        }).pipe(
          Effect.catchTags({
            WorkerdCleanupError: (error) =>
              Effect.logError(error.message, { directory: error.directory })
          })
        );
      })
  );
  yield* Effect.tryPromise({
    try: async (signal) => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        signal.throwIfAborted();
        if (
          resource.child.exitCode !== null ||
          resource.child.signalCode !== null ||
          resource.child.pid === undefined
        )
          throw resource.failure("exited");
        const response = await fetch(`${resource.url}/healthz`, {
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())))
          ])
        }).catch(() => undefined);
        if (response !== undefined) {
          await response.body?.cancel();
          if (response.ok) return;
        }
        await delay(10, undefined, { signal });
      }
      throw resource.failure("timeout");
    },
    catch: (cause) =>
      isWorkerdError(cause)
        ? cause
        : new WorkerdError({ stage: "startup", reason: "request_failed", cause })
  }).pipe(Effect.onError(() => Effect.promise(resource.dispose)));
  return {
    url: resource.url,
    child: resource.child,
    directory: resource.directory
  } satisfies WorkerdProcess;
});
