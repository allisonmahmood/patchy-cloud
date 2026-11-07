/** Run from the repo root with: pnpm exec tsx --conditions=development test/embed-prototype/run.ts */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { Client } from "pg";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as NodeCryptography from "../../packages/core/src/NodeCryptography.js";
import { Session } from "@patchy/auth";
import { liveClient } from "../../packages/auth/live/fixtures.js";
import { developerEnvFile, readDeveloperEnv } from "../../scripts/dev/src/developerEnv.js";
import { startCluster, type Published } from "../browser-tier1/instance.js";
import { startProxy, listen, closeServer } from "./proxy.js";
import { checkBrowsers } from "./check.js";
import { publishSpend } from "./spend.js";
import { checkWorkflow } from "./workflow.js";

const workflow = process.argv.includes("--workflow");

const keys = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* readDeveloperEnv(yield* developerEnvFile(homedir()));
  }).pipe(Effect.provide(NodeServices.layer))
);
if (
  !keys.CLERK_SECRET_KEY?.startsWith("sk_test_") ||
  !keys.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")
)
  throw new Error("This prototype requires development Clerk keys in patchy-cloud/dev.env.");
const run = `embed-${Date.now().toString(36)}`;
const provider = ConfigProvider.fromUnknown(keys);
const clerk = await Effect.runPromise(
  liveClient.pipe(Effect.provide(ConfigProvider.layer(provider)))
);
const users: { id: string; email: string; kind: string }[] = [];
const directory = await mkdtemp(join(tmpdir(), "patchy-embed-prototype-"));
const cleanup: (() => Promise<unknown>)[] = [() => rm(directory, { recursive: true, force: true })];
process.stdout.write("Preparing isolated Clerk people and local server\n");
try {
  // Only these exact run-scoped test users are ever created/deleted. No invitations or mail.
  for (const kind of workflow ? ["member", "requester"] : ["member", "guest", "outsider"]) {
    const email = `${run}-${kind}+clerk_test@example.com`;
    const user = await clerk.users.createUser({
      emailAddress: [email],
      firstName: "Embed",
      lastName: kind,
      skipPasswordRequirement: true,
      skipLegalChecks: true
    });
    users.push({ id: user.id, email, kind });
  }
  const cluster = await startCluster();
  cleanup.push(() => cluster.close());
  const database = await cluster.clonePlatform();
  cleanup.push(() => database.drop());
  const sql = new Client({ connectionString: database.url });
  await sql.connect();
  cleanup.push(() => sql.end());
  for (const user of users) {
    const id = {
      member: "usr_dev",
      guest: "usr_guest",
      outsider: "usr_colleague",
      requester: "usr_colleague"
    }[user.kind]!;
    await sql.query("UPDATE users SET clerk_user_id=$1, email=$2, company_id=$3 WHERE id=$4", [
      user.id,
      user.email,
      user.kind === "member" || user.kind === "requester" ? "cmp_dev" : "cmp_pine",
      id
    ]);
  }
  if (workflow) {
    await sql.query("UPDATE users SET name='Review manager' WHERE id='usr_dev'");
    await sql.query("UPDATE users SET name='Project teammate' WHERE id='usr_colleague'");
  }
  const proxy = await startProxy();
  cleanup.push(() => proxy.close());
  const config = {
    CLERK_SECRET_KEY: keys.CLERK_SECRET_KEY,
    CLERK_PUBLISHABLE_KEY: keys.CLERK_PUBLISHABLE_KEY,
    PATCHY_PUBLIC_BASE_URL: proxy.origin,
    CLERK_AUTHORIZED_PARTIES: proxy.origin
  };
  const auth = await Effect.runPromise(
    Session.make.pipe(
      Effect.provide(NodeCryptography.layer),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config)))
    )
  );
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  const upstream = `http://127.0.0.1:${port}`;
  const server = spawn(join(process.cwd(), "node_modules/bun/bun"), ["apps/server/dist/start.js"], {
    env: {
      // oxlint-disable-next-line no-restricted-properties -- runner forwards the executable search path only.
      PATH: process.env.PATH,
      HOME: directory,
      NODE_ENV: "development",
      ...config,
      PORT: String(port),
      DATABASE_URL: database.url,
      PATCHY_COMPANY_DB_ADMIN_URL: database.url,
      PATCHY_COMPANY_DB_URL: database.url,
      PATCHY_CREDENTIAL_KEYS: `test:${Buffer.alloc(32, 1).toString("base64")}`,
      PATCHY_STORAGE_DIR: join(directory, "storage")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let announced = false;
  server.stdout.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("Patchy Cloud server listening on")) announced = true;
  });
  server.stderr.on("data", () => {});
  cleanup.push(async () => {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
  for (let attempt = 0; ; attempt++) {
    const ready =
      announced &&
      (await fetch(`${upstream}/healthz`, { signal: AbortSignal.timeout(750) })
        .then(async (response) => {
          await response.arrayBuffer();
          return response.ok;
        })
        .catch(() => false));
    if (ready) break;
    if (attempt > 150 || server.exitCode !== null)
      throw new Error("Prototype server did not start.");
    await delay(200);
  }
  process.stdout.write("Publishing local fixtures\n");
  const release = (await (
    await fetch(`${upstream}/api/release`, { signal: AbortSignal.timeout(15_000) })
  ).json()) as { release: string; manifestVersion: number };
  const bundle = await build({
    entryPoints: ["test/embed-prototype/patch.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    conditions: ["development"]
  });
  const html = `<!doctype html><html><head><title>Embed feasibility fixture</title></head><body>
    <h1>Shared notes</h1><p id="identity">Loading</p><button id="add">Add a note</button><p id="result"></p><pre id="rows"></pre>
    <script>${bundle.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const api = (path: string, method: string, body?: unknown) =>
    fetch(`${upstream}/api/${path}`, {
      signal: AbortSignal.timeout(30_000),
      method,
      headers: { authorization: "Bearer patchy-dev-token", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  // CLI init downloads this local server's release through its advertised proxy address.
  proxy.configure({ upstream, auth, clerk, patches: [] });
  const publish = async (scope: "company" | "public") => {
    const response = await api("publish", "POST", {
      publishKey: crypto.randomUUID(),
      metadata: {},
      html,
      scope,
      manifest: {
        release: release.release,
        manifestVersion: release.manifestVersion,
        tier: 1,
        tables: {
          rows: { description: "Notes", columns: { label: { kind: "text" } }, indexes: {} }
        },
        files: {},
        uses: {}
      }
    });
    if (response.status !== 201)
      throw new Error(`Fixture publish failed (${response.status}): ${await response.text()}`);
    return (await response.json()) as Published;
  };
  const spend = workflow ? await publishSpend(directory, upstream) : undefined;
  const privatePatch = spend?.patch ?? (await publish("company"));
  const publicPatch = await publish("public");
  const grant = async (remove = false) => {
    const email = users.find((user) => user.kind === "guest")!.email;
    const response = await api(
      `patches/${privatePatch.patchId}/guests${remove ? `/usr_guest` : ""}`,
      remove ? "DELETE" : "POST",
      remove ? undefined : { email }
    );
    if (!response.ok) throw new Error(`Fixture guest grant failed (${response.status}).`);
  };
  if (!workflow) await grant();
  proxy.configure({ upstream, auth, clerk, patches: [privatePatch, publicPatch] });
  const hosts = [];
  for (let index = 0; index < 2; index++) {
    const host = createServer((request, response) => {
      const target =
        new URL(request.url ?? "/", "http://localhost").searchParams.get("target") ?? "";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Throwaway team app</title></head><body>
        <h1>Team app · local prototype</h1><iframe id="embedded" title="Patchy patch" width="900" height="600" src="${target.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe></body></html>`);
    });
    hosts.push(`http://localhost:${await listen(host)}`);
    cleanup.push(() => closeServer(host));
  }
  proxy.approved.add(hosts[0]!);
  const output = workflow ? ".local/embed-workflow" : ".local/embed-prototype";
  await mkdir(output, { recursive: true });
  const input = {
    proxy,
    hosts,
    users,
    clerk,
    frontend: auth.clerk!.frontendApiHost,
    privatePatch,
    publicPatch,
    grant,
    api
  };
  const report = spend
    ? await checkWorkflow({ ...input, republish: spend.republish })
    : await checkBrowsers(input);
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.browsers.some((browser) => browser.blocker)) process.exitCode = 1;
} finally {
  let failed = false;
  for (const close of cleanup.toReversed()) {
    try {
      await close();
    } catch {
      failed = true;
    }
  }
  if (failed) process.stderr.write("Prototype local teardown failed.\n");
  for (const user of users) await clerk.users.deleteUser(user.id);
  process.stdout.write(
    "Prototype cleanup: run-scoped Clerk users deleted; local instance removed.\n"
  );
}
