import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createSecureServer, type Http2SecureServer, type ServerHttp2Session } from "node:http2";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { Client } from "pg";
import type EmbeddedPostgres from "embedded-postgres";
import type { BrowserContext } from "@playwright/test";
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
};
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
  ): Promise<void>;
  publish(scope?: "company" | "public", html?: string, patchId?: string): Promise<Published>;
  lifecycle(patchId: string, action: "rollback" | "retire", versionNumber?: number): Promise<void>;
  restart(): Promise<void>;
  pauseStreams(paused: boolean): void;
  /** Drop the next stream's first bytes but retain its upstream socket until released. */
  loseNextStreamHello(): () => void;
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
async function stopServer(server: Server) {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  server.closeAllConnections();
  await closed.promise;
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = Promise.withResolvers<void>();
  child.once("exit", () => done.resolve());
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await done.promise;
  } finally {
    clearTimeout(timer);
  }
}

/** Only the front proxy's hostile navigation endpoints are synthetic.
 * Every publish, session verification, runtime call, file and database mutation is production. */
export async function startInstance(options: { tls?: boolean } = {}): Promise<Instance> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "patchy-tier1-"));
  let postgres: EmbeddedPostgres | undefined;
  let child: ChildProcess | undefined;
  let platform: Client | undefined;
  let proxy: Server | Http2SecureServer | undefined;
  const sessions = new Set<ServerHttp2Session>();
  let foreign: Server | undefined;
  const connections = new Set<Client>();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const connection of connections) await connection.end();
    for (const session of sessions) session.destroy();
    if (proxy) {
      if ("closeAllConnections" in proxy) await stopServer(proxy);
      else await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    }
    if (foreign) await stopServer(foreign);
    if (child) await stopChild(child);
    if (platform) await platform.end();
    if (postgres) await postgres.stop();
    await rm(directory, { recursive: true, force: true });
  };
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
    const databasePort = await listen(reservation);
    postgres = new Postgres({
      databaseDir: path.join(directory, "postgres"),
      port: databasePort,
      user: PG_USER,
      password: PG_PASSWORD,
      persistent: false,
      postgresFlags: [...PG_FLAGS, "-c", "listen_addresses=127.0.0.1"],
      onLog() {},
      onError() {}
    });
    await postgres.initialise();
    await stopServer(reservation);
    await postgres.start();
    await postgres.createDatabase("patchy");
    const databaseUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${databasePort}/patchy`;
    const serverReservation = createServer();
    const port = await listen(serverReservation);
    const runtimeRequests: Instance["runtimeRequests"] = [];
    const streamConnections = new Set<string>();
    const streamClosers = new Set<() => void>();
    let streamsPaused = false;
    let abandonNextStream: ((release: () => void) => void) | undefined;
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
    proxy.on("request", (request, response) => {
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
            }
            incoming.pipe(response);
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
    const backendOrigin = `http://127.0.0.1:${port}`;
    await stopServer(serverReservation);
    let log = "";
    const launch = async () => {
      log = "";
      child = spawn(process.execPath, [path.join(root, "apps/server/dist/start.js")], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          NODE_ENV: "test",
          ...clerkEnv(),
          CLERK_AUTHORIZED_PARTIES: origin,
          PORT: String(port),
          DATABASE_URL: databaseUrl,
          PATCHY_COMPANY_DB_ADMIN_URL: databaseUrl,
          PATCHY_COMPANY_DB_URL: databaseUrl,
          PATCHY_CREDENTIAL_KEYS: `test:${Buffer.alloc(32, 1).toString("base64")}`,
          PATCHY_STORAGE_DIR: path.join(directory, "storage"),
          PATCHY_PUBLIC_BASE_URL: origin
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        log += chunk.toString();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        log += chunk.toString();
      });
      const deadline = Date.now() + 30_000;
      while (!log.includes("Patchy Cloud server listening on")) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Tier 1 server failed to start: ${log}`);
        await delay(50);
      }
    };
    await launch();
    const health = await fetch(`${backendOrigin}/healthz`);
    if (!health.ok) throw new Error(`Tier 1 health returned ${health.status}`);
    const { applyDevSeed } = await import(
      pathToFileURL(path.join(root, "packages/auth/dist/seed.js")).href
    );
    await applyDevSeed(databaseUrl);
    platform = new Client({ connectionString: databaseUrl });
    await platform.connect();
    await platform.query(
      "INSERT INTO users (id, clerk_user_id, company_id, email, name, role) VALUES ('usr_colleague', 'user_colleague', $1, 'colleague@patchy.local', 'Colleague', 'member')",
      [seed.companyId]
    );
    const release = (await (await fetch(`${backendOrigin}/api/release`)).json()) as {
      release: string;
      manifestVersion: number;
    };
    const bundle = await build({
      entryPoints: [path.join(root, "test/browser-tier1/fixture-client.ts")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      alias: { "patchy/client": path.join(root, "packages/patchy/dist/client.js") }
    });
    const html = `<!doctype html><html><head><title>Tier one acceptance</title><style>body{margin:0}td{height:20px}table{border-collapse:collapse}@media print{button{display:none}}</style></head><body><h1>Tier one acceptance</h1><p id="identity">waiting</p><p id="route"></p><button id="route-next">Next route</button><button id="download">Download file</button><img id="own-image" alt="Own file"><table><tbody id="rows"></tbody></table><script>${bundle.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
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
      async restart() {
        await stopChild(child!);
        await launch();
      },
      async lifecycle(patchId, action, versionNumber) {
        const response = await fetch(`${backendOrigin}/api/patches/${patchId}/${action}`, {
          method: "POST",
          headers: { authorization: `Bearer ${seed.token}`, "content-type": "application/json" },
          body: JSON.stringify(action === "rollback" ? { versionNumber } : {})
        });
        if (!response.ok) throw new Error(`${action}: ${response.status} ${await response.text()}`);
      },
      async session(context, user = "owner", expiresInSeconds = 3600) {
        await context.clearCookies();
        if (user === "none") {
          // A known signed-out development browser needs no live Clerk browser-registration hop.
          await context.addCookies([
            { name: "__clerk_db_jwt", value: "offline-browser", url: origin },
            { name: "__client_uat", value: "0", url: origin }
          ]);
          return;
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
      },
      async publish(scope = "company", content = html, patchId) {
        const response = await fetch(`${backendOrigin}/api/publish`, {
          method: "POST",
          headers: { authorization: `Bearer ${seed.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            publishKey: crypto.randomUUID(),
            ...(patchId ? { patchId } : {}),
            manifest: {
              ...manifest,
              release: release.release,
              manifestVersion: release.manifestVersion
            },
            metadata: {},
            html: content,
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
