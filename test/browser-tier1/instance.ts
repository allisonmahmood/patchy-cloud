import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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

const root = fileURLToPath(new URL("../../", import.meta.url));
const seed = { companyId: "cmp_dev", userId: "usr_dev", token: "patchy-dev-token" };
export const manifest = {
  manifestVersion: 1,
  release: "",
  tier: 1,
  tables: { rows: { columns: { label: { kind: "text" } }, indexes: {} } },
  files: { assets: {} },
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
    user?: "owner" | "colleague" | "expired" | "none"
  ): Promise<void>;
  publish(scope?: "company" | "public", html?: string): Promise<Published>;
  company(): Promise<Client>;
  close(): Promise<void>;
}
async function listen(server: Server): Promise<number> {
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
export async function startInstance(): Promise<Instance> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "patchy-tier1-"));
  let postgres: EmbeddedPostgres | undefined;
  let child: ChildProcess | undefined;
  let platform: Client | undefined;
  let proxy: Server | undefined;
  let foreign: Server | undefined;
  const connections = new Set<Client>();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const connection of connections) await connection.end();
    if (proxy) await stopServer(proxy);
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
    const foreignRequests: string[] = [];
    foreign = createServer((request, response) => {
      foreignRequests.push(request.url ?? "/");
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
    proxy = createServer((request, response) => {
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
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: request.url,
            method: request.method,
            headers: request.headers
          },
          (incoming) => {
            const parts: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => parts.push(chunk));
            incoming.on("end", () => {
              const bytes = Buffer.concat(parts);
              const headers = incoming.headers;
              response.writeHead(incoming.statusCode ?? 500, headers);
              response.end(bytes);
            });
          }
        );
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        upstream.end(body);
      });
    });
    const origin = `http://127.0.0.1:${await listen(proxy)}`;
    await stopServer(serverReservation);
    let log = "";
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
        PATCHY_PUBLIC_BASE_URL: origin,
        PATCHY_RUNTIME_CALLS_PER_MINUTE: "10000"
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
    const health = await fetch(`${origin}/healthz`);
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
    const release = (await (await fetch(`${origin}/api/release`)).json()) as {
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
      async session(context, user = "owner") {
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
          exp: user === "expired" ? now - 60 : now + 3600
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
      async publish(scope = "company", content = html) {
        const response = await fetch(`${origin}/api/publish`, {
          method: "POST",
          headers: { authorization: `Bearer ${seed.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            publishKey: crypto.randomUUID(),
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
        if (response.status !== 201)
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
