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
    { mode: 0o755 }
  );
  const api = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== "Bearer current-secret") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "Missing or invalid API token." }));
    } else {
      response.end(
        JSON.stringify(
          request.url === "/api/me"
            ? { user: { name: "Fixture Person" }, company: { name: "Fixture Company" } }
            : request.url.endsWith("/page")
              ? {
                  id: "page1",
                  name: "private-page",
                  versionNumber: 1,
                  html: "<h1>Private fixture page</h1>"
                }
              : { patches: [{ id: "page1", name: "private-page" }] }
        )
      );
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
    TEST_CREDENTIAL: state
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
        env
      })
    );
    assert.equal((await client.listTools()).tools.length, 8);
    const call = () => client.callTool({ name: "list_patches", arguments: {} });
    const expired = await call();
    assert.equal(expired.isError, true);
    assert.match(expired.content[0].text, /Sign in to Patchy again/);
    assert.ok(!JSON.stringify(expired).includes("expired-secret"));
    assert.deepEqual(JSON.parse(await readFile(args, "utf8")), [
      "auth",
      "token",
      "--api-url",
      url,
      "--json"
    ]);
    await save({ version: 1, instanceUrl: url, token: "current-secret" });
    assert.equal((await call()).isError, undefined, "same MCP process picks up completed re-login");
    const page = await client.callTool({ name: "read_page", arguments: { patch: "private-page" } });
    assert.equal(page.isError, undefined);
    assert.match(JSON.parse(page.content[0].text).html, /Private fixture page/);
    assert.deepEqual(JSON.parse(await readFile(args, "utf8")), [
      "auth",
      "token",
      "--api-url",
      url,
      "--json"
    ]);
    for (const value of [
      { error: "not_logged_in" },
      { error: "unsupported_cli" },
      { raw: "invalid-json-secret-must-not-leak" },
      { version: 2, instanceUrl: url, token: "secret-must-not-leak" },
      {
        version: 1,
        instanceUrl: "https://other.example",
        token: "secret-must-not-leak"
      }
    ]) {
      await save(value);
      const result = await call();
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes("secret-must-not-leak"));
      assert.match(
        result.content[0].text,
        value.error === "not_logged_in" ? /patchy-mcp login/ : /auth token|credential response/
      );
    }
  } finally {
    await client.close();
  }
});
