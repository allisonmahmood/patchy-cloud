// PROTOTYPE for #315: an isolated server for the boundary proofs, offline like #313/#314's
// tier 1 acceptance instance (test/browser-tier1/instance.ts): its own embedded Postgres, fake
// Clerk keys, signed session cookies for the owner (the dev seed) and a colleague, and the
// production publish, runtime, shell and engine. Nothing here touches a developer instance.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import type EmbeddedPostgres from "embedded-postgres";
import type { BrowserContext } from "@playwright/test";
import { clerkEnv, signedInCookies, signSession } from "../../packages/auth/src/testing.js";
import { PG_FLAGS, PG_PASSWORD, PG_USER } from "../../scripts/dev/src/postgres.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const seed = { companyId: "cmp_dev", userId: "usr_dev", token: "patchy-dev-token" };
export const HIDDEN_GRACE_MS = 1500;

export type User = "owner" | "colleague";
export interface Published {
  readonly patchId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly address: string;
  readonly schemaRevision: number;
  readonly warnings: readonly string[];
}
export interface Instance {
  readonly origin: string;
  readonly release: string;
  session(context: BrowserContext, user: User): Promise<void>;
  cookie(user: User): string;
  publish(
    body: Record<string, unknown>
  ): Promise<{ status: number; body: Published & Record<string, unknown> }>;
  stats(patchId: string): Promise<Record<string, number>>;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  const ready = Promise.withResolvers<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  return address.port;
}
async function reserve(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function startInstance(): Promise<Instance> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "patchy-prototype-crm-"));
  let postgres: EmbeddedPostgres | undefined;
  let child: ChildProcess | undefined;
  let platform: Client | undefined;
  const close = async () => {
    if (platform) await platform.end().catch(() => {});
    if (child && child.exitCode === null) {
      const done = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child!.kill("SIGKILL"), 5000);
      await done;
      clearTimeout(timer);
    }
    if (postgres) await postgres.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
    const previous = signals.map((signal) => [signal, new Set(process.listeners(signal))] as const);
    const { default: Postgres } = await import("embedded-postgres");
    for (const [signal, listeners] of previous)
      for (const listener of process.listeners(signal))
        if (!listeners.has(listener)) process.removeListener(signal, listener);
    const databasePort = await reserve();
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
    await postgres.start();
    await postgres.createDatabase("patchy");
    const databaseUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${databasePort}/patchy`;
    const port = await reserve();
    const origin = `http://127.0.0.1:${port}`;
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
        PATCHY_RUNTIME_CALLS_PER_MINUTE: "100000",
        PATCHY_PROTOTYPE_HIDDEN_GRACE_MS: String(HIDDEN_GRACE_MS)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await mkdir(path.join(root, ".local/prototype-crm-results"), { recursive: true });
    const serverLog = createWriteStream(path.join(root, ".local/prototype-crm-results/server.log"));
    child.stdout!.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      serverLog.write(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      serverLog.write(chunk);
    });
    const deadline = Date.now() + 60_000;
    while (!log.includes("Patchy Cloud server listening on")) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Prototype server failed to start: ${log}`);
      await delay(50);
    }
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
    const release = (await (await fetch(`${origin}/api/release`)).json()) as { release: string };
    const token = (user: User) => {
      const now = Math.floor(Date.now() / 1000);
      return signSession({
        azp: origin,
        sub: user === "colleague" ? "user_colleague" : "user_dev",
        email: user === "colleague" ? "colleague@patchy.local" : "dev@patchy.local",
        iat: now - 120,
        nbf: now - 120,
        exp: now + 3600
      });
    };
    return {
      origin,
      release: release.release,
      cookie: (user) => signedInCookies(token(user)),
      async session(context, user) {
        await context.clearCookies();
        await context.addCookies(
          signedInCookies(token(user))
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
      async publish(body) {
        const response = await fetch(`${origin}/api/publish`, {
          method: "POST",
          headers: { authorization: `Bearer ${seed.token}`, "content-type": "application/json" },
          body: JSON.stringify({ publishKey: crypto.randomUUID(), metadata: {}, ...body })
        });
        return { status: response.status, body: (await response.json()) as never };
      },
      async stats(patchId) {
        return (await (
          await fetch(`${origin}/api/runtime/prototype/stats?patchId=${patchId}`)
        ).json()) as Record<string, number>;
      },
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
