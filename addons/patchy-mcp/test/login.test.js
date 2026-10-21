import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "patchy-login-test-"));
  const state = path.join(dir, "credential.json");
  const args = path.join(dir, "args.json");
  await writeFile(
    path.join(dir, "patchy"),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.TEST_ARGS, JSON.stringify(process.argv.slice(2)));
const value = JSON.parse(fs.readFileSync(process.env.TEST_CREDENTIAL, 'utf8'));
if (process.argv[2] === 'login') { console.log(JSON.stringify({status:'awaiting_confirmation',userCode:'ABCD-EFGH'})); process.exit(0); }
if (value.error) { console.error(JSON.stringify(value.failure || {code:value.error,error:'secret-must-not-leak'})); process.exit(1); }
if (process.argv[2] === 'list' || process.argv[2] === 'whoami') {
  if (value.raw || value.version !== 1 || value.instanceUrl !== process.argv[process.argv.indexOf('--api-url')+1]) { console.log('incompatible'); process.exit(0); }
  fetch(value.instanceUrl + (process.argv[2] === 'list' ? '/api/patches' : '/api/me'), {headers:{authorization:'Bearer '+value.token}}).then(async r=>{
    const body=await r.text(); if(r.ok) console.log(body); else {console.error(JSON.stringify({...JSON.parse(body),kind:'rejected'}));process.exitCode=2;}
  });
  return;
}
if (value.raw) { console.log(value.raw); process.exit(0); }
console.log(JSON.stringify(value));
`,
    { mode: 0o755 },
  );
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== "Bearer current-secret") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "Missing or invalid API token." }));
    } else {
      response.end(JSON.stringify(request.url === "/api/me"
        ? { user: { name: "Fixture Person" }, company: { name: "Fixture Company" } }
        : request.url.endsWith("/page")
          ? { id: "page1", name: "private-page", versionNumber: 1, html: "<h1>Private fixture page</h1>" }
          : { patches: [{ id: "page1", name: "private-page" }] }));
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const url = `http://127.0.0.1:${api.address().port}`;
  const env = {
    ...process.env,
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    PATCHY_API_URL: url,
    PATCHY_API_TOKEN: "",
    TEST_ARGS: args,
    TEST_CREDENTIAL: state,
  };
  const save = (value) => writeFile(state, JSON.stringify(value));
  await save({ version: 1, instanceUrl: url, token: "expired-secret" });
  t.after(async () => {
    api.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { env, save, url, args };
}

test("a running MCP reuses refreshed CLI login and sanitizes credential failures", async (t) => {
  const { env, save, url, args } = await fixture(t);
  const client = new Client({ name: "login-check", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env,
      }),
    );
    assert.equal((await client.listTools()).tools.length, 8);
    const call = () => client.callTool({ name: "list_patches", arguments: {} });
    const expired = await call();
    assert.equal(expired.isError, true);
    assert.match(expired.content[0].text, /Sign in to Patchy again/);
    assert.ok(!JSON.stringify(expired).includes("expired-secret"));
    assert.deepEqual(JSON.parse(await readFile(args, "utf8")), [
      "list",
      "--api-url",
      url,
      "--json",
    ]);
    await save({ version: 1, instanceUrl: url, token: "current-secret" });
    assert.equal(
      (await call()).isError,
      undefined,
      "same MCP process picks up completed re-login",
    );
    const page = await client.callTool({ name: "read_page", arguments: { patch: "private-page" } });
    assert.equal(page.isError, undefined);
    assert.match(JSON.parse(page.content[0].text).html, /Private fixture page/);
    assert.deepEqual(JSON.parse(await readFile(args, "utf8")), ["auth", "token", "--api-url", url, "--json"]);
    for (const value of [
      { error: "not_logged_in" },
      { error: "unsupported_cli" },
      { raw: "invalid-json-secret-must-not-leak" },
      { version: 2, instanceUrl: url, token: "secret-must-not-leak" },
      {
        version: 1,
        instanceUrl: "https://other.example",
        token: "secret-must-not-leak",
      },
    ]) {
      await save(value);
      const result = await call();
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes("secret-must-not-leak"));
    }
  } finally {
    await client.close();
  }
});

test("doctor checks Page credentials as well as identity and setup stores working executable paths without secrets", async (t) => {
  const { env, save, url, args } = await fixture(t);
  await save({ version: 1, instanceUrl: url, token: "current-secret" });
  const doctor = await exec(process.execPath, [entry, "doctor"], { env });
  const checked = JSON.parse(doctor.stdout);
  assert.equal(checked.instanceUrl, url);
  assert.equal(checked.credentialSource, "patchy-cli");
  assert.equal(checked.identity.company.name, "Fixture Company");
  assert.ok(!doctor.stdout.includes("current-secret"));
  assert.deepEqual(JSON.parse(await readFile(args, "utf8")), ["auth", "token", "--api-url", url, "--json"]);

  // The public discovery commands work; only the credential interface is too old.
  await save({ version: 1, instanceUrl: url, token: "current-secret", credentialUnsupported: true });
  const patchy = path.join(path.dirname(args), "patchy");
  await writeFile(patchy, (await readFile(patchy, "utf8")).replace(
    "if (value.raw)",
    "if (value.credentialUnsupported) { console.error('unsupported CLI'); process.exit(1); }\nif (value.raw)"
  ));
  await assert.rejects(exec(process.execPath, [entry, "doctor"], { env }), (error) => {
    assert.match(error.stderr, /Page and Tool reads require.*auth token/);
    assert.equal(error.stdout, "");
    return true;
  });

  await save({ version: 1, instanceUrl: url, token: "current-secret" });
  const codexArgs = path.join(path.dirname(args), "codex-args.json");
  await writeFile(path.join(path.dirname(args), "codex"), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.TEST_CODEX_ARGS, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o755 });
  const setupEnv = { ...env, TEST_CODEX_ARGS: codexArgs, PATCHY_LAUNCH_QUEUE_PATCH: "queue1", PATCHY_STATE_DIR: "/temporary fixture login" };
  const setup = await exec(process.execPath, [entry, "setup", "codex"], { env: setupEnv });
  assert.equal(JSON.parse(setup.stdout).ok, true);
  const registration = JSON.parse(await readFile(codexArgs, "utf8"));
  assert.deepEqual(registration.slice(0, 3), ["mcp", "add", "patchy"]);
  assert.ok(registration.includes(`PATCHY_API_URL=${url}`));
  assert.ok(registration.includes("PATCHY_API_TOKEN="), "saved login wins over a future parent-process token override");
  assert.ok(registration.includes("PATCHY_LAUNCH_QUEUE_PATCH=queue1"));
  assert.ok(registration.includes("PATCHY_STATE_DIR=/temporary fixture login"));
  assert.deepEqual(registration.slice(-3), ["--", process.execPath, entry]);
  assert.ok(!registration.join(" ").includes("current-secret"));
  await exec(process.execPath, [entry, "remove", "codex"], { env: setupEnv });
  assert.deepEqual(JSON.parse(await readFile(codexArgs, "utf8")), ["mcp", "remove", "patchy"]);
  const separate = await exec(process.execPath, [entry, "setup", "codex", "--name", "patchy-local-test", "--api-url", url], { env: setupEnv });
  assert.equal(JSON.parse(separate.stdout).registrationName, "patchy-local-test");
  assert.deepEqual(JSON.parse(await readFile(codexArgs, "utf8")).slice(0, 3), ["mcp", "add", "patchy-local-test"]);
  await exec(process.execPath, [entry, "remove", "codex", "--name", "patchy-local-test"], { env: setupEnv });
  assert.deepEqual(JSON.parse(await readFile(codexArgs, "utf8")), ["mcp", "remove", "patchy-local-test"]);
  for (const flags of [["--name"], ["--name", "bad.name"], ["--name", "--help"], ["--name", "a", "--name", "b"], ["--unknown", "x"]]) {
    await assert.rejects(exec(process.execPath, [entry, "setup", "codex", ...flags], { env: setupEnv }));
    assert.deepEqual(JSON.parse(await readFile(codexArgs, "utf8")), ["mcp", "remove", "patchy-local-test"], "bad options never mutate the registration");
  }
});

test("CLI discovery distinguishes missing login, rejected patches and unavailable Cloud", async (t) => {
  const { env, save } = await fixture(t);
  const client = new Client({ name: "cli-errors", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env }));
    for (const [failure, expected] of [
      [{ kind: "local", error: "No publishing key is stored for https://example.test.\nRun: patchy login" }, /Sign in to Patchy again/],
      [{ kind: "rejected", error: "Missing or invalid API token.\nExtra hosted CLI hint." }, /Sign in to Patchy again/],
      [{ kind: "rejected", error: "Patch not found." }, /Patch not found/],
      [{ kind: "unreachable", error: "Network error" }, /Cloud is unavailable/],
    ]) {
      await save({ error: "fixture", failure });
      const result = await client.callTool({ name: "get_patch", arguments: { patch: "private-page" } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, expected);
    }
  } finally { await client.close(); }
});

test("login forwards the existing handoff with one explicit instance; doctor refuses stale credentials", async (t) => {
  const { env, args, url } = await fixture(t);
  const login = await exec(
    process.execPath,
    [entry, "login", "--api-url", url, "--json"],
    { env },
  );
  assert.equal(JSON.parse(login.stdout).status, "awaiting_confirmation");
  assert.deepEqual(JSON.parse(await readFile(args, "utf8")), [
    "login",
    "--api-url",
    url,
    "--json",
  ]);
  await assert.rejects(
    exec(process.execPath, [entry, "doctor"], { env }),
    (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /Sign in to Patchy again/);
      assert.ok(!error.stderr.includes("expired-secret"));
      return true;
    },
  );
});
