// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalTimers:off globalTimersInEffect:off globalDate:off preferSchemaOverJson:off -- direct child ownership and wall-clock startup must work under TestClock too.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import * as GuestProtocol from "@patchy/api/guest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class WorkerdError extends Schema.TaggedError<WorkerdError>()("WorkerdError", {
  stage: Schema.Literals(["binary", "bundle", "config", "spawn", "startup"]),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  override get message() {
    return `The execution process failed at ${this.stage}.`;
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
const binary = Effect.try({
  try: () => {
    const outer = createRequire(import.meta.url);
    const manifest = outer.resolve("workerd/package.json");
    decodeVersion(outer("workerd/package.json"));
    const inner = createRequire(manifest);
    const name = packages[`${process.platform} ${process.arch}`];
    if (name === undefined) throw new Error("Unsupported workerd platform.");
    decodeVersion(inner(`${name}/package.json`));
    return join(
      dirname(inner.resolve(`${name}/package.json`)),
      "bin",
      process.platform === "win32" ? "workerd.exe" : "workerd"
    );
  },
  catch: (cause) => new WorkerdError({ stage: "binary", cause })
});

let source: Promise<string> | undefined;
const loaderSource = Effect.tryPromise({
  try: () =>
    (source ??= build({
      entryPoints: [
        fileURLToPath(
          new URL(import.meta.url.endsWith(".ts") ? "./loader.ts" : "./loader.js", import.meta.url)
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
    }).then((result) => {
      for (const output of Object.values(result.metafile.outputs)) {
        if (output.imports.some(({ path }) => path !== "cloudflare:workers"))
          throw new Error("The loader retains an unsupported external import.");
      }
      const output = result.outputFiles[0];
      if (output === undefined) throw new Error("No loader output.");
      return output.text;
    })),
  catch: (cause) => new WorkerdError({ stage: "bundle", cause })
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
      throw new Error("Invalid callback URL.");
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
      globalOutbound = (name = "loader", entrypoint = "Outbound")
    )),
    (name = "internet", network = (allow = []))${callback}
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "loader")]
);
`;
}

const reservePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("No loopback port."));
      } else server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

export interface WorkerdProcess {
  readonly url: string;
  readonly child: ChildProcess;
  readonly directory: string;
}

/** A direct process for tests and inspection. The owning scope kills and reaps it. */
export const startWorkerd = Effect.fn("Execution.startWorkerd")(function* (
  options: { readonly callbackUrls?: readonly string[]; readonly startupTimeoutMs?: number } = {}
) {
  const executable = yield* binary;
  const loader = yield* loaderSource;
  const configuration = yield* Effect.try({
    try: () => config(options.callbackUrls),
    catch: (cause) => new WorkerdError({ stage: "config", cause })
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
          const port = await reservePort();
          const child = spawn(
            executable,
            [
              "serve",
              join(directory, "config.capnp"),
              "--experimental",
              `--socket-addr=http=127.0.0.1:${port}`
            ],
            {
              stdio: ["ignore", "ignore", "pipe"],
              env: {}
            }
          );
          let stderr = "";
          let spawnError: Error | undefined;
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-8192);
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
              await rm(directory, { recursive: true, force: true });
            })());
          return {
            url: `http://127.0.0.1:${port}`,
            child,
            directory,
            dispose,
            failure: () => spawnError ?? new Error(stderr)
          };
        } catch (cause) {
          await rm(directory, { recursive: true, force: true });
          throw cause;
        }
      },
      catch: (cause) => new WorkerdError({ stage: "spawn", cause })
    }),
    (resource) => Effect.promise(resource.dispose)
  );
  yield* Effect.tryPromise({
    try: async (signal) => {
      const deadline = performance.now() + (options.startupTimeoutMs ?? 5_000);
      while (performance.now() < deadline) {
        signal.throwIfAborted();
        if (
          resource.child.exitCode !== null ||
          resource.child.signalCode !== null ||
          resource.child.pid === undefined
        )
          throw resource.failure();
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
      throw resource.failure();
    },
    catch: (cause) => new WorkerdError({ stage: "startup", cause })
  }).pipe(Effect.onError(() => Effect.promise(resource.dispose)));
  return {
    url: resource.url,
    child: resource.child,
    directory: resource.directory
  } satisfies WorkerdProcess;
});
