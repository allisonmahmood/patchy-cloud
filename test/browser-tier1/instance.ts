import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import {
  createSecureServer,
  type Http2SecureServer,
  type Http2ServerRequest,
  type ServerHttp2Session
} from "node:http2";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Transform, pipeline } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { build } from "esbuild";
import { Client, escapeIdentifier } from "pg";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { applyDevSeed } from "@patchy/auth/seed";
import * as LocalTaskProvider from "../../packages/execution/src/localTaskProvider.js";
import type { BrowserContext } from "@playwright/test";
import type { Manifest } from "../../packages/api/src/index.js";
import { migrations } from "../../apps/server/src/migrations.js";
import { layerFromUrl, migrate } from "../../packages/sql/src/index.js";
import { clerkEnv, signedInCookies, signSession } from "../../packages/auth/src/testing.js";
import { WIRE_VERSION } from "../../packages/patchy/src/release.js";
import { PG_FLAGS, PG_PASSWORD, PG_USER } from "../../scripts/dev/src/postgres.js";
import { escapeAttribute } from "../../packages/core/src/html.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const seed = { companyId: "cmp_dev", userId: "usr_dev", token: "patchy-dev-token" };
export const manifest = {
  manifestVersion: 1,
  release: "",
  tier: 1,
  tables: {
    rows: {
      description: "Labeled records keyed by id.",
      columns: { label: { kind: "text" } },
      indexes: {}
    }
  },
  files: { assets: { description: "Browser fixture assets keyed by file name." } },
  uses: {}
} as const;
export interface Published {
  patchId: string;
  versionId: string;
  address: string;
  name: string;
}
export interface Instance {
  origin: string;
  foreignOrigin: string;
  wire: number;
  html: string;
  platform: Client;
  runtimeRequests: Array<{ method: string; path: string; body: string }>;
  foreignRequests: string[];
  session(
    context: BrowserContext,
    user?: "owner" | "colleague" | "expired" | "none",
    expiresInSeconds?: number
  ): Promise<string | null>;
  publish(
    scope?: "company" | "public",
    html?: string,
    patchId?: string,
    declarations?: Partial<
      Pick<typeof Manifest.Type, "tier" | "tables" | "files" | "uses" | "handlers">
    >,
    options?: { readonly server?: string; readonly force?: boolean }
  ): Promise<Published>;
  lifecycle(
    patchId: string,
    action: "rollback" | "retire" | "restore",
    versionNumber?: number,
    force?: boolean
  ): Promise<void>;
  share(patchId: string, scope: "company" | "public"): Promise<void>;
  restart(environment?: Readonly<Record<string, string>>): Promise<void>;
  /** A second real host sharing this instance's databases, storage and session verifier. */
  startReplica(): Promise<{ origin: string; stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void> }>;
  pauseStreams(paused: boolean): void;
  /** Hold real SSE bytes at ingress, without fabricating lifecycle frames. */
  holdStreamFrames(held: boolean): void;
  /** Drop the next stream's first bytes but retain its upstream socket until released. */
  loseNextStreamHello(): () => void;
  /** Drop one admitted frame without interrupting either side of the live stream. */
  loseNextAdmitted(sequence: number): Promise<void>;
  readonly streamConnections: Set<string>;
  company(): Promise<Client>;
  close(): Promise<void>;
}
const embeddingPage = (url: string) =>
  `<!doctype html><h1>Embedding probe</h1><iframe id="embedded" src="${escapeAttribute(new URL(url, "http://localhost").searchParams.get("target") ?? "")}"></iframe>`;
async function listen(server: Server | Http2SecureServer): Promise<number> {
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  server.removeListener("error", ready.reject);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return address.port;
}
/** A port free right now; the caller must bind it before something else does. */
async function freePort(): Promise<number> {
  const reservation = createServer();
  const port = await listen(reservation);
  await stopServer(reservation);
  return port;
}
/** A reserved port another process bound before the server did. */
class PortTaken extends Error {}
async function stopServer(server: Server) {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  server.closeAllConnections();
  await closed.promise;
}
async function stopChild(child: ChildProcess, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = Promise.withResolvers<void>();
  child.once("exit", () => done.resolve());
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await done.promise;
  } finally {
    clearTimeout(timer);
  }
}
/** Runs every step in order, even after one throws, then rethrows the first failure. */
async function settle(steps: ReadonlyArray<() => unknown>) {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}

const PLATFORM = "patchy";
const TEMPLATE = "patchy_tier1_template";
/** Cluster-wide state a test could leave for the next one: databases, roles with their
 * attributes, memberships and settings. Databases by identity only: vacuum moves their other columns. */
async function clusterState(admin: Client) {
  const state = await admin.query<{ entry: string }>(
    `SELECT 'database ' || datname || ' ' || oid || ' ' || datallowconn AS entry FROM pg_database
      UNION ALL SELECT 'role ' || pg_roles::text FROM pg_roles
      UNION ALL SELECT 'membership ' || pg_auth_members::text FROM pg_auth_members
      UNION ALL SELECT 'setting ' || pg_db_role_setting::text FROM pg_db_role_setting`
  );
  return state.rows.map(({ entry }) => entry);
}
/** One test's `patchy` database, cloned from the cluster's template. */
export interface PlatformDatabase {
  readonly url: string;
  /** Drops the company databases this platform placed, then the platform itself. */
  drop(): Promise<void>;
}
export interface Cluster {
  /** A fresh platform database, after checking that the cluster is back at its baseline. */
  clonePlatform(): Promise<PlatformDatabase>;
  close(): Promise<void>;
}
/** One embedded Postgres for a Playwright worker's lifetime, holding a migrated, seeded template.
 * A worker runs one test at a time, so the cluster serves one test at a time: every
 * cluster-wide query a spec makes sees only its own databases and connections. */
export async function startCluster(): Promise<Cluster> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "patchy-tier1-postgres-"));
  // Each resource's release, undone newest first on close.
  const releases: Array<() => unknown> = [() => rm(directory, { recursive: true, force: true })];
  const close = () => settle(releases.toReversed());
  try {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
    const previous = signals.map((signal) => [signal, new Set(process.listeners(signal))] as const);
    // Loading embedded-postgres installs process-exiting hooks; preserve Playwright's handlers.
    const { default: Postgres } = await import("embedded-postgres");
    for (const [signal, listeners] of previous) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.has(listener)) process.removeListener(signal, listener);
      }
    }
    const reservation = createServer();
    const port = await listen(reservation);
    releases.push(() => stopServer(reservation));
    const postgres = new Postgres({
      databaseDir: path.join(directory, "data"),
      port,
      user: PG_USER,
      password: PG_PASSWORD,
      persistent: false,
      // Without ALTER SYSTEM, no server-wide setting can outlive the test that changed it.
      postgresFlags: [
        ...PG_FLAGS,
        "-c",
        "listen_addresses=127.0.0.1",
        "-c",
        "allow_alter_system=off"
      ],
      onLog() {},
      onError() {}
    });
    await postgres.initialise();
    await stopServer(reservation);
    await postgres.start();
    // Only once started: embedded-postgres' stop() never returns for a cluster whose start failed.
    releases.push(() => postgres.stop());
    const url = (database: string) =>
      `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${database}`;
    // Short-lived, so no harness connection is open while a test runs. `end()` returns once
    // the backend has exited, which keeps the next baseline check exact.
    const connect = async <A>(database: string, use: (client: Client) => Promise<A>) => {
      const client = new Client({ connectionString: url(database) });
      await client.connect();
      try {
        return await use(client);
      } finally {
        await client.end();
      }
    };
    // Exactly what a brand-new instance held: the server's migrations, the dev seed and the
    // colleague. No patches, placements or name backfill.
    await postgres.createDatabase(TEMPLATE);
    await Effect.runPromise(
      migrate(migrations).pipe(Effect.provide(layerFromUrl(Redacted.make(url(TEMPLATE)))))
    );
    await applyDevSeed(url(TEMPLATE));
    await connect(TEMPLATE, (template) =>
      template.query(
        "INSERT INTO users (id, clerk_user_id, company_id, email, name, role) VALUES ('usr_colleague', 'user_colleague', $1, 'colleague@patchy.local', 'Colleague', 'member')",
        [seed.companyId]
      )
    );
    const baseline = await connect("postgres", async (admin) => {
      // No test can drift a template nothing connects to; cloning still works.
      await admin.query(`ALTER DATABASE ${TEMPLATE} WITH ALLOW_CONNECTIONS false`);
      // The migration and seed pools send Terminate without waiting for their backends to
      // exit; wait those out so the first baseline check is exact.
      await admin.query(
        "SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity WHERE datname = $1",
        [TEMPLATE]
      );
      // Postgres' own databases and roles, the template, and no settings.
      return clusterState(admin);
    });
    const dropDatabase = (admin: Client, name: string) =>
      admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
    // Every placement the server claimed, ready or not; a claim may never have created its database.
    const placements = () =>
      connect(PLATFORM, (platform) =>
        platform.query<{ database_name: string }>("SELECT database_name FROM company_databases")
      );
    const dropPlatform = () =>
      connect("postgres", (admin) =>
        settle([
          async () =>
            settle(
              (await placements()).rows.map(
                (placement) => () => dropDatabase(admin, placement.database_name)
              )
            ),
          () => dropDatabase(admin, PLATFORM)
        ])
      );
    return {
      clonePlatform: () =>
        connect("postgres", async (admin) => {
          // A teardown that leaked a database, role, setting or connection, or stopped partway, fails here.
          const state = await clusterState(admin);
          const added = state.filter((entry) => !baseline.includes(entry));
          const removed = baseline.filter((entry) => !state.includes(entry));
          if (added.length + removed.length > 0)
            throw new Error(
              `An earlier test changed this worker's cluster: added [${added.join(", ")}], removed [${removed.join(", ")}]`
            );
          const backends = await admin.query<{
            pid: number;
            datname: string | null;
            query: string;
          }>(
            "SELECT pid, datname, query FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()"
          );
          if (backends.rows.length > 0)
            throw new Error(
              `An earlier test left connections open on this worker's cluster: ${JSON.stringify(backends.rows)}`
            );
          await admin.query(`CREATE DATABASE ${PLATFORM} TEMPLATE ${TEMPLATE}`);
          return { url: url(PLATFORM), drop: dropPlatform };
        }),
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Only the front proxy's hostile navigation endpoints are synthetic.
 * Every publish, session verification, runtime call, file and database mutation is production. */
export async function startInstance(options: {
  cluster: Cluster;
  tls?: boolean;
  environment?: Readonly<Record<string, string>>;
}): Promise<Instance> {
  let environment = options.environment ?? {};
  const directory = await mkdtemp(path.join(os.tmpdir(), "patchy-tier1-"));
  let database: PlatformDatabase | undefined;
  let child: ChildProcess | undefined;
  const children = new Set<ChildProcess>();
  let platform: Client | undefined;
  let proxy: Server | Http2SecureServer | undefined;
  const sessions = new Set<ServerHttp2Session>();
  let foreign: Server | undefined;
  const connections = new Set<Client>();
  let closed = false;
  const fleetDirectory = path.join(directory, "execution-fleet");
  let fleetStarted = false;
  let callbackPorts: number[] | undefined;
  // Everything that could touch the databases stops before they are dropped.
  const close = async () => {
    if (closed) return;
    closed = true;
    await settle([
      ...[...connections].map((connection) => () => connection.end()),
      () => {
        for (const session of sessions) session.destroy();
      },
      async () => {
        if (!proxy) return;
        if ("closeAllConnections" in proxy) await stopServer(proxy);
        else await new Promise<void>((resolve) => proxy!.close(() => resolve()));
      },
      async () => {
        if (foreign) await stopServer(foreign);
      },
      ...[...children].map((server) => () => stopChild(server)),
      async () => {
        if (fleetStarted)
          await Effect.runPromise(
            LocalTaskProvider.cleanup(fleetDirectory).pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ NODE_ENV: "test" })))
            )
          );
      },
      () => platform?.end(),
      () => database?.drop(),
      () => rm(directory, { recursive: true, force: true })
    ]);
  };
  try {
    database = await options.cluster.clonePlatform();
    const databaseUrl = database.url;
    const serverReservation = createServer();
    // The proxy follows the backend if a launch has to move to another port.
    let port = await listen(serverReservation);
    // Like an ingress that routes only to healthy targets. A starting host binds its
    // port before it attaches its handler, and a request in that gap hangs forever.
    let backendReady = true;
    const runtimeRequests: Instance["runtimeRequests"] = [];
    const streamConnections = new Set<string>();
    const streamClosers = new Set<() => void>();
    let streamsPaused = false;
    let streamFramesHeld = false;
    const releaseStreamFrames = new Set<() => void>();
    let abandonNextStream: ((release: () => void) => void) | undefined;
    let dropAdmitted: { readonly sequence: number; readonly dropped: () => void } | undefined;
    const foreignRequests: string[] = [];
    foreign = createServer((request, response) => {
      foreignRequests.push(request.url ?? "/");
      if (request.url?.startsWith("/embed?")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(embeddingPage(request.url));
        return;
      }
      if (request.url === "/204") {
        response.writeHead(204).end();
        return;
      }
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/landed" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><h1>Foreign document</h1>");
    });
    const foreignOrigin = `http://localhost:${await listen(foreign)}`;
    if (options.tls) {
      const keyPath = path.join(directory, "ingress.key");
      const certPath = path.join(directory, "ingress.crt");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1,DNS:localhost"
        ],
        { stdio: "ignore" }
      );
      proxy = createSecureServer({
        key: await readFile(keyPath),
        cert: await readFile(certPath),
        allowHTTP1: true
      });
      proxy.on("session", (session) => {
        sessions.add(session);
        session.on("close", () => sessions.delete(session));
      });
    } else {
      proxy = createServer();
    }
    proxy.on("request", (request: IncomingMessage | Http2ServerRequest, response) => {
      if (streamsPaused && request.url?.startsWith("/api/runtime/stream")) {
        response.writeHead(502).end();
        return;
      }
      if (request.url?.startsWith("/~tier1/embed?")) {
        response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        response.end(embeddingPage(request.url));
        return;
      }
      if (request.url?.startsWith("/~tier1/")) {
        const headers = {
          "content-security-policy":
            "sandbox allow-scripts allow-modals; default-src 'none'; script-src 'unsafe-inline'",
          "cache-control": "no-store"
        };
        if (request.url === "/~tier1/redirect") {
          response.writeHead(302, { ...headers, location: `${foreignOrigin}/landed` }).end();
          return;
        }
        if (request.url === "/~tier1/204") {
          response.writeHead(204, headers).end();
          return;
        }
        response.writeHead(200, { ...headers, "content-type": "text/html" });
        response.end(
          "<!doctype html><h1>Replacement document</h1><script>window.received=[];addEventListener('message',e=>{received.push(e.data);for(const p of e.ports){p.start();p.postMessage({kind:'ready',wire:1,nonce:new URL(location.href).searchParams.get('n')})}})</script>"
        );
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        if (request.url?.startsWith("/api/runtime/"))
          runtimeRequests.push({
            method: request.method ?? "GET",
            path: request.url,
            body: body.toString()
          });
        if (!backendReady) {
          response.writeHead(502).end();
          return;
        }
        let retainUpstream = false;
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: request.url,
            method: request.method,
            headers: Object.fromEntries(
              Object.entries(request.headers).filter(([name]) => !name.startsWith(":"))
            )
          },
          (incoming) => {
            const headers = Object.fromEntries(
              Object.entries(incoming.headers).filter(
                ([name]) =>
                  !["connection", "keep-alive", "transfer-encoding", "upgrade"].includes(name)
              )
            );
            response.writeHead(incoming.statusCode ?? 500, headers);
            if (incoming.headers["content-type"]?.startsWith("text/event-stream")) {
              const key = `${request.url}:${crypto.randomUUID()}`;
              streamConnections.add(key);
              const disconnect = () => response.destroy();
              streamClosers.add(disconnect);
              response.on("close", () => {
                streamConnections.delete(key);
                streamClosers.delete(disconnect);
              });
              response.flushHeaders();
              if (abandonNextStream) {
                const abandon = abandonNextStream;
                abandonNextStream = undefined;
                retainUpstream = true;
                abandon(() => upstream.destroy());
                // Lose the real hello in transit while the runtime still observes a live socket.
                incoming.once("data", () => response.destroy());
                incoming.resume();
                return;
              }
              const decoder = new StringDecoder("utf8");
              let buffered = "";
              const heldFrames: string[] = [];
              const releaseFrames = () => {
                for (const event of heldFrames) streamTransform.push(event);
                heldFrames.length = 0;
              };
              releaseStreamFrames.add(releaseFrames);
              response.on("close", () => {
                releaseStreamFrames.delete(releaseFrames);
                heldFrames.length = 0;
              });
              const streamTransform = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  buffered += decoder.write(chunk);
                  let boundary: RegExpExecArray | null;
                  while ((boundary = /\r?\n\r?\n/.exec(buffered)) !== null) {
                    const event = buffered.slice(0, boundary.index + boundary[0].length);
                    buffered = buffered.slice(event.length);
                    const data = event.split(/\r?\n/).find((line) => line.startsWith("data:"));
                    if (dropAdmitted && data) {
                      const frame: unknown = JSON.parse(data.slice(5));
                      if (
                        frame !== null &&
                        typeof frame === "object" &&
                        "type" in frame &&
                        frame.type === "admitted" &&
                        "sequence" in frame &&
                        frame.sequence === dropAdmitted.sequence
                      ) {
                        const dropped = dropAdmitted.dropped;
                        dropAdmitted = undefined;
                        dropped();
                        continue;
                      }
                    }
                    if (streamFramesHeld) heldFrames.push(event);
                    else this.push(event);
                  }
                  callback();
                },
                flush(callback) {
                  this.push(buffered + decoder.end());
                  callback();
                }
              });
              // Like an ingress, a host that dies mid-stream resets the browser's stream;
              // `pipe` would leave it open and silent forever.
              pipeline(incoming, streamTransform, response, () => {});
              return;
            }
            pipeline(incoming, response, () => {});
          }
        );
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        response.on("close", () => {
          if (!retainUpstream) upstream.destroy();
        });
        upstream.end(body);
      });
    });
    const origin = `${options.tls ? "https" : "http"}://127.0.0.1:${await listen(proxy)}`;
    const backendOrigin = () => `http://127.0.0.1:${port}`;
    await stopServer(serverReservation);
    const launch = async (serverPort: number, replica = false) => {
      const fleet = environment.EXECUTION_PROVIDER === "local-fleet";
      if (fleet && callbackPorts === undefined) {
        const reservations = [createServer(), createServer()];
        try {
          callbackPorts = await Promise.all(reservations.map(listen));
        } finally {
          await Promise.all(reservations.map(stopServer));
        }
      }
      if (fleet) fleetStarted = true;
      let log = "";
      const server = spawn(process.execPath, [path.join(root, "apps/server/dist/start.js")], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          NODE_ENV: "test",
          ...clerkEnv(),
          CLERK_AUTHORIZED_PARTIES: origin,
          PORT: String(serverPort),
          DATABASE_URL: databaseUrl,
          PATCHY_COMPANY_DB_ADMIN_URL: databaseUrl,
          PATCHY_COMPANY_DB_URL: databaseUrl,
          PATCHY_CREDENTIAL_KEYS: `test:${Buffer.alloc(32, 1).toString("base64")}`,
          PATCHY_STORAGE_DIR: path.join(directory, "storage"),
          PATCHY_PUBLIC_BASE_URL: origin,
          ...environment,
          ...(fleet
            ? {
                EXECUTION_LOCAL_DIRECTORY: fleetDirectory,
                EXECUTION_CALLBACK_PORT: String(callbackPorts![replica ? 1 : 0]),
                EXECUTION_CALLBACK_URLS: JSON.stringify(
                  callbackPorts!.map((port) => `http://127.0.0.1:${port}/callback`)
                )
              }
            : {})
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      children.add(server);
      server.stdout!.on("data", (chunk: Buffer) => {
        log += chunk.toString();
      });
      server.stderr!.on("data", (chunk: Buffer) => {
        log += chunk.toString();
      });
      const deadline = Date.now() + 30_000;
      while (!log.includes("Patchy Cloud server listening on")) {
        if (server.exitCode !== null && log.includes("EADDRINUSE")) {
          children.delete(server);
          throw new PortTaken(`Port ${serverPort} was taken before the server bound it`);
        }
        if (server.exitCode !== null || Date.now() > deadline)
          throw new Error(`Tier 1 server failed to start: ${log}`);
        await delay(50);
      }
      return server;
    };
    // Between reservation and bind, any outbound connection can take an ephemeral port.
    const launchOnFreePort = async (first: number, replica = false) => {
      for (let attempt = 1, serverPort = first; ; attempt++, serverPort = await freePort()) {
        try {
          return { server: await launch(serverPort, replica), port: serverPort };
        } catch (error) {
          if (!(error instanceof PortTaken) || attempt === 3) throw error;
        }
      }
    };
    ({ server: child, port } = await launchOnFreePort(port));
    const health = await fetch(`${backendOrigin()}/healthz`);
    if (!health.ok) throw new Error(`Tier 1 health returned ${health.status}`);
    platform = new Client({ connectionString: databaseUrl });
    await platform.connect();
    const release = (await (await fetch(`${backendOrigin()}/api/release`)).json()) as {
      release: string;
      manifestVersion: number;
    };
    const bundle = await build({
      entryPoints: [path.join(root, "test/browser-tier1/fixture-client.ts")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      define: { "import.meta.env.DEV": "false" },
      alias: {
        "patchy/client": path.join(root, "packages/patchy/dist/client.js"),
        "patchy/preact": path.join(root, "packages/patchy/dist/preact.js")
      }
    });
    const html = `<!doctype html><html><head><title>Tier one acceptance</title><style>body{margin:0}</style></head><body><h1>Tier one acceptance</h1><p id="identity">waiting</p><p id="route"></p><button id="route-next">Next route</button><button id="download">Download file</button><img id="own-image" alt="Own file"><script>${bundle.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
    return {
      origin,
      foreignOrigin,
      wire: WIRE_VERSION,
      html,
      platform,
      runtimeRequests,
      foreignRequests,
      streamConnections,
      pauseStreams(paused) {
        streamsPaused = paused;
        if (paused) for (const disconnect of streamClosers) disconnect();
      },
      holdStreamFrames(held) {
        streamFramesHeld = held;
        if (!held) for (const release of releaseStreamFrames) release();
      },
      loseNextStreamHello() {
        let release: (() => void) | undefined;
        abandonNextStream = (close) => {
          release = close;
        };
        return () => {
          release?.();
          release = undefined;
        };
      },
      loseNextAdmitted(sequence) {
        const { promise, resolve } = Promise.withResolvers<void>();
        dropAdmitted = { sequence, dropped: resolve };
        return promise;
      },
      async restart(nextEnvironment) {
        if (nextEnvironment) environment = { ...environment, ...nextEnvironment };
        backendReady = false;
        await stopChild(child!);
        children.delete(child!);
        ({ server: child, port } = await launchOnFreePort(port));
        backendReady = true;
      },
      async startReplica() {
        const { server: replica, port: replicaPort } = await launchOnFreePort(
          await freePort(),
          true
        );
        return {
          origin: `http://127.0.0.1:${replicaPort}`,
          async stop(signal) {
            await stopChild(replica, signal);
            children.delete(replica);
          }
        };
      },
      async lifecycle(patchId, action, versionNumber, force) {
        const response = await fetch(`${backendOrigin()}/api/patches/${patchId}/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${seed.token}`, "content-type": "application/json" },
          body: JSON.stringify(action === "rollback" ? { versionNumber } : { force })
        });
        if (!response.ok) throw new Error(`${action}: ${response.status} ${await response.text()}`);
      },
      async share(patchId, scope) {
        const response = await fetch(`${backendOrigin()}/api/patches/${patchId}/share`, {
          method: "POST",
          headers: { authorization: `Bearer ${seed.token}`, "content-type": "application/json" },
          body: JSON.stringify({ scope })
        });
        if (!response.ok) throw new Error(`share: ${response.status} ${await response.text()}`);
      },
      async session(context, user = "owner", expiresInSeconds = 3600) {
        await context.clearCookies();
        if (user === "none") {
          // A known signed-out development browser needs no live Clerk browser-registration hop.
          await context.addCookies([
            { name: "__clerk_db_jwt", value: "offline-browser", url: origin },
            { name: "__client_uat", value: "0", url: origin }
          ]);
          return null;
        }
        const now = Math.floor(Date.now() / 1000);
        const token = signSession({
          azp: origin,
          sub: user === "colleague" ? "user_colleague" : "user_dev",
          email: user === "colleague" ? "colleague@patchy.local" : "dev@patchy.local",
          iat: now - 120,
          nbf: now - 120,
          exp: user === "expired" ? now - 60 : now + expiresInSeconds
        });
        await context.addCookies(
          signedInCookies(token)
            .split("; ")
            .map((cookie) => {
              const at = cookie.indexOf("=");
              return {
                name: cookie.slice(0, at),
                value: cookie.slice(at + 1),
                url: origin,
                sameSite: "Lax" as const
              };
            })
        );
        return token;
      },
      async publish(scope = "company", content = html, patchId, declarations, options) {
        const response = await fetch(`${backendOrigin()}/api/publish`, {
          method: "POST",
          headers: { authorization: `Bearer ${seed.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            publishKey: crypto.randomUUID(),
            ...(patchId ? { patchId } : {}),
            manifest: {
              ...manifest,
              ...declarations,
              release: release.release,
              manifestVersion: release.manifestVersion
            },
            metadata: {},
            html: content,
            ...options,
            scope
          })
        });
        const result = (await response.json()) as Published;
        if (response.status !== (patchId ? 200 : 201))
          throw new Error(`Publish failed ${response.status}: ${JSON.stringify(result)}`);
        return result;
      },
      async company() {
        const placement = await platform!.query<{ database_name: string }>(
          "SELECT database_name FROM company_databases WHERE company_id=$1",
          [seed.companyId]
        );
        const url = new URL(databaseUrl);
        url.pathname = `/${placement.rows[0]!.database_name}`;
        const connection = new Client({ connectionString: url.href });
        await connection.connect();
        connections.add(connection);
        return connection;
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
