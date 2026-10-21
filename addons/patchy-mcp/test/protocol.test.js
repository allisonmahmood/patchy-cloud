import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { checkCurrentWire } from "./support/wire.js";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const exec = promisify(execFile);

// Independent wire check: a matching SDK client alone can hide compatibility problems.
for (const protocolVersion of ["2024-10-07", "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
  test(`stdio negotiates ${protocolVersion} with JSON-only stdout and shuts down on EOF`, { timeout: 5000 }, async (t) => {
    const child = spawn(process.execPath, [entry], { env: {
      ...process.env, PATCHY_API_TOKEN: "", PATCHY_API_URL: "http://127.0.0.1:1"
    } });
    t.after(() => child.kill());
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const receive = async (id) => {
      while (true) {
        const { value, done } = await lines.next();
        assert.equal(done, false, `MCP exited early: ${stderr}`);
        const message = JSON.parse(value);
        assert.equal(message.jsonrpc, "2.0");
        if (message.id === id) return message;
        assert.equal(message.id, undefined, "only protocol notifications may appear between replies");
      }
    };
    send({ id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "plain-jsonrpc", version: "1" } } });
    const initialized = await receive(1);
    assert.equal(initialized.result.protocolVersion, protocolVersion);
    assert.equal(initialized.result.serverInfo.name, "patchy");
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list", params: {} });
    assert.equal((await receive(2)).result.tools.length, 8);
    const closed = once(child, "close");
    child.stdin.end();
    assert.deepEqual(await closed, [0, null]);
    assert.equal(stderr, "");
  });
}

test("current 2026-07-28 wire: discovery, calls, result envelopes, protocol and tool errors", { timeout: 10000 }, async (t) => {
  const seen = [];
  const api = createServer(async (request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/patches/notes/page")
      response.end(JSON.stringify({ id: "page1", name: "notes", versionNumber: 1, html: "<p>Company only.</p>" }));
    else if (request.url === "/api/patches/accounts/queries")
      response.end(JSON.stringify({ patchId: "accounts", versionId: "v1", queries: [{
        handler: "accounts.count", description: "Count accounts in a region",
        inputSchema: { type: "object", properties: { region: { type: "string" } }, required: ["region"] },
        outputSchema: { type: "object" },
      }] }));
    else if (request.url === "/api/patches/accounts/query") {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { handler: "accounts.count", args: { region: "west" } });
      response.end(JSON.stringify({ patchId: "accounts", versionId: "v1", result: { ok: true, value: { count: 3, region: "west" } } }));
    }
    else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Patch not found." }));
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  t.after(() => api.close());
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await checkCurrentWire(t, { command: process.execPath, args: [entry], version, env: {
    ...process.env, PATCHY_API_URL: `http://127.0.0.1:${api.address().port}`, PATCHY_API_TOKEN: "fixture-token",
  } });
  assert.deepEqual(seen, [
    { path: "/api/patches/notes/page", authorization: "Bearer fixture-token" },
    { path: "/api/patches/accounts/queries", authorization: "Bearer fixture-token" },
    { path: "/api/patches/accounts/queries", authorization: "Bearer fixture-token" },
    { path: "/api/patches/accounts/query", authorization: "Bearer fixture-token" },
    { path: "/api/patches/accounts/queries", authorization: "Bearer fixture-token" },
    { path: "/api/patches/missing/page", authorization: "Bearer fixture-token" },
  ], "invalid protocol requests and tool arguments never reach Cloud");
});

test("help/version tolerate invalid config; doctor reports it without a stack trace", async () => {
  const env = { ...process.env, PATCHY_API_URL: "not-a-url" };
  assert.match((await exec(process.execPath, [entry, "--help"], { env })).stdout, /stdio waits for an MCP client/);
  assert.match((await exec(process.execPath, [entry, "--version"], { env })).stdout, /^\d+\.\d+\.\d+\n$/);
  await assert.rejects(exec(process.execPath, [entry, "doctor"], { env }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.equal(error.stderr, "Invalid Patchy instance URL.\n");
    return true;
  });
});
