import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type EmbeddedPostgres from "embedded-postgres";
import { PG_FLAGS, PG_PASSWORD, PG_USER } from "../../scripts/dev/src/postgres.js";

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface BrowserInstance {
  origin: string;
  cli(args: string[], token?: string): Promise<CliResult>;
  close(): Promise<void>;
}

interface Child {
  process: ChildProcess;
  done: Promise<CliResult>;
  settled: boolean;
  failed: boolean;
  stdout: string;
}

interface PortReservation {
  port: number;
  release(): Promise<void>;
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const terminationSignals = ["SIGHUP", "SIGINT", "SIGTERM", "SIGBREAK"] as const;

/** Real server and installed CLI, with no checkout or developer authentication state. */
export async function startInstance(clerkUserId: string): Promise<BrowserInstance> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey?.trim() || !publishableKey?.trim()) {
    throw new Error("Browser tests require CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY.");
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "patchy-clerk-browser-"));
  const consumerDir = path.join(tempRoot, "clean consumer");
  const packDir = path.join(tempRoot, "packed artifacts");
  const home = path.join(tempRoot, "home");
  const children = new Set<Child>();
  let postgres: EmbeddedPostgres | undefined;
  let postgresStarted = false;
  let serverPort: PortReservation | undefined;
  let databasePort: PortReservation | undefined;
  let closePromise: Promise<void> | undefined;

  // Keep tools usable, but never forward ambient product, Clerk, storage or Node overrides.
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
    "CI",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE"
  ]) {
    if (process.env[name] !== undefined) baseEnv[name] = process.env[name];
  }
  const runtimeEnv = {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local")
  };

  function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Child {
    if (closePromise) throw new Error("Browser instance is closed.");
    const childProcess = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });
    const { promise, resolve } = Promise.withResolvers<CliResult>();
    const child: Child = {
      process: childProcess,
      done: promise,
      settled: false,
      failed: false,
      stdout: ""
    };
    let stderr = "";
    childProcess.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      child.stdout += chunk;
    });
    childProcess.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Resolve even on spawn errors: teardown and health checks can always await the lifecycle.
    childProcess.once("error", () => {
      child.failed = true;
    });
    childProcess.once("close", (status) => {
      child.settled = true;
      resolve({ status: status ?? 1, stdout: child.stdout, stderr });
    });
    children.add(child);
    return child;
  }

  async function run(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs = 120_000
  ): Promise<CliResult> {
    const child = launch(command, args, cwd, env);
    const deadline = new AbortController();
    try {
      const result = await Promise.race([
        child.done,
        delay(timeoutMs, undefined, { signal: deadline.signal }).then(() => undefined)
      ]);
      if (result === undefined) {
        await terminate(child);
        throw new Error("Browser instance command timed out.");
      }
      if (child.failed) throw new Error("Could not launch browser instance command.");
      return result;
    } finally {
      deadline.abort();
      if (child.settled) children.delete(child);
    }
  }

  async function checked(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const result = await run(command, args, cwd, env);
    if (result.status !== 0) {
      // Do not include subprocess output or argv: either can contain credentials.
      throw new Error(`Browser instance build/package command failed (exit ${result.status}).`);
    }
    return result;
  }

  function close(): Promise<void> {
    closePromise ??= (async () => {
      const failures = await Promise.allSettled([
        ...Array.from(children, terminate),
        serverPort?.release(),
        databasePort?.release()
      ]);
      try {
        if (postgresStarted) await postgres!.stop();
      } catch {
        failures.push({
          status: "rejected",
          reason: new Error("Could not stop browser Postgres.")
        });
      }
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch {
        failures.push({ status: "rejected", reason: new Error("Could not remove browser state.") });
      }
      if (failures.some((result) => result.status === "rejected")) {
        throw new Error("Browser instance cleanup failed.");
      }
    })();
    return closePromise;
  }

  let stage = "preparing temporary state";
  try {
    await Promise.all([mkdir(consumerDir), mkdir(packDir), mkdir(home)]);
    stage = "reserving server port";
    serverPort = await reserveLoopbackPort();
    stage = "building server";
    // Keep the tool manager's home/cache; the server and installed CLI never receive it.
    const buildEnv = { ...baseEnv, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const pnpmEntry = process.env.npm_execpath;
    const pnpmCommand = process.platform === "win32" ? process.execPath : "pnpm";
    const pnpmPrefix = process.platform === "win32" && pnpmEntry ? [pnpmEntry] : [];
    if (process.platform === "win32" && (!pnpmEntry || !/pnpm\.(?:c?js|mjs)$/i.test(pnpmEntry))) {
      throw new Error("Run browser tests through pnpm on Windows.");
    }
    await checked(
      pnpmCommand,
      [...pnpmPrefix, "--filter", "@patchy/server...", "build"],
      repoRoot,
      buildEnv
    );
    stage = "building CLI";
    await checked(
      pnpmCommand,
      [...pnpmPrefix, "--filter", "@patchy/cli", "build"],
      repoRoot,
      buildEnv
    );
    stage = "packing CLI";
    const packed = await checked(
      pnpmCommand,
      [
        ...pnpmPrefix,
        "pack",
        "--config.ignore-scripts=true",
        "--json",
        "--pack-destination",
        packDir
      ],
      path.join(repoRoot, "packages/cli"),
      buildEnv
    );
    const parsed: unknown = JSON.parse(packed.stdout);
    const packs: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const tarballs = (await readdir(packDir)).filter((file) => file.endsWith(".tgz"));
    const pack = packs[0];
    if (
      packs.length !== 1 ||
      tarballs.length !== 1 ||
      !pack ||
      typeof pack !== "object" ||
      !("filename" in pack) ||
      typeof pack.filename !== "string" ||
      path.basename(pack.filename) !== tarballs[0]
    ) {
      throw new Error("pnpm pack did not produce one exact CLI tarball.");
    }
    stage = "installing packed CLI";
    await writeFile(path.join(consumerDir, "package.json"), '{"private":true}\n');
    await checked(
      process.execPath,
      [
        path.join(repoRoot, "node_modules/npm/bin/npm-cli.js"),
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        path.join(packDir, tarballs[0]!)
      ],
      consumerDir,
      runtimeEnv
    );
    const cliEntry = path.join(consumerDir, "node_modules/@patchy/cli/dist/index.js");
    await access(cliEntry);

    stage = "starting Postgres";
    // A static import would install process-exiting hooks before we could preserve the worker's handlers.
    const listenersBefore = terminationSignals.map(
      (signal) => [signal, new Set(process.listeners(signal))] as const
    );
    const { default: Postgres } = await import("embedded-postgres");
    for (const [signal, listeners] of listenersBefore) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.has(listener)) process.removeListener(signal, listener);
      }
    }
    databasePort = await reserveLoopbackPort();
    postgres = new Postgres({
      databaseDir: path.join(tempRoot, "postgres"),
      port: databasePort.port,
      user: PG_USER,
      password: PG_PASSWORD,
      persistent: false,
      postgresFlags: [...PG_FLAGS, "-c", "listen_addresses=127.0.0.1"],
      onLog() {},
      onError() {}
    });
    await postgres.initialise();
    await databasePort.release();
    await postgres.start();
    postgresStarted = true;
    await postgres.createDatabase("patchy");
    const databaseUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${databasePort.port}/patchy`;

    stage = "starting server";
    const port = String(serverPort.port);
    const origin = `http://127.0.0.1:${port}`;
    // Ignore the in-memory Vitest tier's URL; release our own reservation only at spawn.
    await serverPort.release();
    const server = launch(
      process.execPath,
      [path.join(repoRoot, "apps/server/dist/start.js")],
      repoRoot,
      {
        ...runtimeEnv,
        PORT: port,
        DATABASE_URL: databaseUrl,
        PATCHY_STORAGE_DIR: path.join(tempRoot, "objects"),
        PATCHY_PUBLIC_BASE_URL: origin,
        CLERK_SECRET_KEY: secretKey,
        CLERK_PUBLISHABLE_KEY: publishableKey,
        CLERK_AUTHORIZED_PARTIES: origin
      }
    );
    const readyLine = `Patchy Cloud server listening on http://0.0.0.0:${port}`;
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (server.failed || server.settled)
        throw new Error("Browser server exited before readiness.");
      // Never mistake an unrelated listener for our child if a free-port handoff races.
      if (server.stdout.split(/\r?\n/).includes(readyLine)) {
        try {
          const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(750) });
          const body: unknown = await response.json();
          if (
            response.status === 200 &&
            body &&
            typeof body === "object" &&
            "ok" in body &&
            body.ok === true
          ) {
            ready = true;
            break;
          }
        } catch {
          /* Retry until the readiness deadline. */
        }
      }
      await delay(100);
    }
    if (!ready) throw new Error("Browser server readiness timed out.");
    stage = "seeding browser membership";
    // Import after the build; seed's actual API takes the Clerk id as a string.
    const { applyDevSeed } = await import(
      pathToFileURL(path.join(repoRoot, "packages/auth/dist/seed.js")).href
    );
    await applyDevSeed(databaseUrl, clerkUserId);

    return {
      origin,
      cli: (args, token) =>
        run(process.execPath, [cliEntry, ...args], consumerDir, {
          ...runtimeEnv,
          PATCHY_API_URL: origin,
          ...(token === undefined ? {} : { PATCHY_API_TOKEN: token })
        }),
      close
    };
  } catch {
    let cleanupFailed = false;
    try {
      await close();
    } catch {
      cleanupFailed = true;
    }
    // SDK/SQL errors can embed configuration; never propagate their raw causes.
    throw new Error(
      `Browser instance failed while ${stage}.${cleanupFailed ? " Cleanup also failed." : ""}`
    );
  }
}

async function reserveLoopbackPort(): Promise<PortReservation> {
  const server = createServer();
  const release = async () => {
    if (server.listening) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((error) => (error ? reject(error) : resolve()));
      await promise;
    }
  };
  try {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    await promise;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Could not reserve a loopback port.");
    return { port: address.port, release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function terminate(child: Child): Promise<void> {
  function signal(value: NodeJS.Signals) {
    if (!child.process.pid) return;
    try {
      if (process.platform === "win32") {
        if (!child.settled) child.process.kill(value);
      } else {
        process.kill(-child.process.pid, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  async function wait(ms: number) {
    const controller = new AbortController();
    try {
      await Promise.race([child.done, delay(ms, undefined, { signal: controller.signal })]);
    } finally {
      controller.abort();
    }
  }
  signal("SIGTERM");
  await wait(2_000);
  // Also reap descendants when the process group leader exited first.
  signal("SIGKILL");
  await wait(2_000);
  if (!child.settled) throw new Error("Browser subprocess did not exit after termination.");
}
