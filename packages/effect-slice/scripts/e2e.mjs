// The packed-CLI e2e core: real Postgres, the real Effect server, the bundled
// CLI as a separate process. Pack/npm-install is unchanged by Effect; skipped.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(dir, "dist/patchy.js");
const tsx = path.join(dir, "../../node_modules/.bin/tsx");

const port = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const run = (command, args, env, input) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });

const databaseDir = await mkdtemp(path.join(os.tmpdir(), "patchy-slice-e2e-"));
const pgPort = await port();
const embedded = new EmbeddedPostgres({
  databaseDir,
  port: pgPort,
  user: "postgres",
  password: "postgres",
  persistent: false,
  onLog() {}
});
await embedded.initialise();
await embedded.start();
const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres`;
const httpPort = await port();
const apiUrl = `http://127.0.0.1:${httpPort}`;
const server = spawn(tsx, ["--conditions=development", path.join(dir, "src/start.ts")], {
  env: { ...process.env, DATABASE_URL: databaseUrl, PORT: String(httpPort) },
  stdio: ["ignore", "inherit", "inherit"]
});
try {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${apiUrl}/d/none`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(
    `INSERT INTO accounts (id, name) VALUES ('acct_bootstrap', 'Bootstrap Account')`
  );
  await client.query(
    `INSERT INTO api_tokens (id, account_id, name, token_hash, scopes) VALUES ('tok_bootstrap', 'acct_bootstrap', 'Bootstrap API Token', encode(sha256('patchy-e2e-token'::bytea), 'hex'), '["admin","upload"]'::jsonb)`
  );
  await client.end();

  const whoami = await run(cli, ["whoami"], {
    PATCHY_API_URL: apiUrl,
    PATCHY_API_TOKEN: "patchy-e2e-token"
  });
  console.log("[whoami]", JSON.stringify(whoami));
  assert.equal(whoami.code, 0);
  assert.match(whoami.stdout, /^Account: Bootstrap Account \(acct_bootstrap\)$/m);
  assert.match(whoami.stdout, /^API token: Bootstrap API Token \(tok_bootstrap\)$/m);
  assert.match(whoami.stdout, /^Scopes: admin, upload$/m);
  assert.ok(!`${whoami.stdout}${whoami.stderr}`.includes("patchy-e2e-token"), "token leaked");

  const bad = await run(cli, ["whoami"], { PATCHY_API_URL: apiUrl, PATCHY_API_TOKEN: "wrong" });
  console.log("[whoami bad]", JSON.stringify(bad));
  assert.equal(bad.code, 1);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /Missing or invalid API token\./);
  assert.doesNotMatch(bad.stderr, /\n\s+at /, "stack trace leaked to the agent");

  const noUrl = await run(cli, ["whoami"], { PATCHY_API_TOKEN: "x" });
  console.log("[whoami no url]", JSON.stringify(noUrl));
  assert.equal(noUrl.code, 1);
  assert.equal(noUrl.stdout, "");
  assert.match(noUrl.stderr, /PATCHY_API_URL/);
  assert.doesNotMatch(noUrl.stderr, /\n\s+at /, "stack trace leaked to the agent");

  const help = await run(cli, ["--help"], {});
  console.log("[help]", JSON.stringify(help));
  assert.equal(help.code, 0);
  assert.doesNotMatch(help.stdout, /--wizard|--completions|--log-level/);
  const version = await run(cli, ["--version"], {});
  console.log("[version]", JSON.stringify(version));
  assert.equal(version.stdout.trim(), "0.0.1-slice");
  console.log("e2e core OK");
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => server.on("close", r));
  await embedded.stop();
  await rm(databaseDir, { recursive: true, force: true });
}
