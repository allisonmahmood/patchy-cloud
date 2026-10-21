import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const lookup = {
  handler: "accounts.lookup",
  description: "Look up an account by its region, optionally limiting the results.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false,
    properties: { region: { $ref: "#/$defs/Region" }, limit: { type: "integer", minimum: 1 } },
    required: ["region"], $defs: { Region: { type: "string", enum: ["west", "east"] } },
  },
  outputSchema: { type: "object", properties: { count: { type: "number" } } },
};

async function connect(t, protocol, handler) {
  const api = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    response.setHeader("content-type", "application/json");
    await handler(request, response, text ? JSON.parse(text) : undefined);
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const client = new Client({ name: "query-consumer", version: "1" }, {
    versionNegotiation: { mode: protocol === "legacy" ? "legacy" : { pin: protocol } },
  });
  t.after(async () => { await client.close(); api.close(); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: {
    ...process.env, PATCHY_API_URL: `http://127.0.0.1:${api.address().port}`, PATCHY_API_TOKEN: "reader",
  } }));
  return (name, args) => client.callTool({ name, arguments: args });
}

function value(reply) {
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  return reply.structuredContent;
}

for (const protocol of ["legacy", "2026-07-28"]) {
  test(`[${protocol}] discovers schemas and a second Tool with inputs on the same running process`, async (t) => {
    let publishedSecondTool = false;
    const seen = [];
    const call = await connect(t, protocol, (request, response, body) => {
      seen.push({ method: request.method, path: request.url, body, authorization: request.headers.authorization });
      if (request.url === "/api/patches") {
        response.end(JSON.stringify({ patches: [
          { id: "queue1", name: "launch-queue", tier: 2 },
          ...(publishedSecondTool ? [{ id: "accounts2", name: "account-directory", tier: 2 }] : []),
        ] }));
      } else if (request.url === "/api/patches/launch-queue/queries") {
        response.end(JSON.stringify({ patchId: "queue1", versionId: "v1", queries: [{
          handler: "queue.blocked", description: "Blocked launches", inputSchema: { type: "object" }, outputSchema: { type: "array" },
        }] }));
      } else if (request.url === "/api/patches/account-directory/queries" && publishedSecondTool) {
        response.end(JSON.stringify({ patchId: "accounts2", versionId: "v2", queries: [lookup] }));
      } else if (request.url === "/api/patches/accounts2/query" && request.method === "POST") {
        // Fixture Cloud validates operation-specific input; MCP forwards rather than interpreting schemas.
        if (body.args.region !== "west" || Object.keys(body.args).some(key => !["region", "limit"].includes(key))) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "Invalid handler arguments: region must be west or east; unknown properties are forbidden." }));
        } else {
          response.end(JSON.stringify({ patchId: "accounts2", versionId: "v3", result: {
            ok: true, value: { count: 1, accounts: ["West account"], received: body.args },
          } }));
        }
      } else { response.statusCode = 404; response.end(JSON.stringify({ error: "Patch not found." })); }
    });
    assert.equal(JSON.parse((await call("list_patches", {})).content[0].text).patches.length, 1);
    assert.equal(value(await call("list_queries", { patch: "launch-queue" })).queries[0].handler, "queue.blocked");
    assert.equal(seen.some(request => request.method !== "GET"), false, "discovery executes no handlers");

    // Publication is external; this MCP process remains connected without any rebuild or registration change.
    publishedSecondTool = true;
    assert.equal(JSON.parse((await call("list_patches", {})).content[0].text).patches[1].name, "account-directory");
    const catalog = value(await call("list_queries", { patch: "account-directory" }));
    assert.deepEqual(catalog.queries, [lookup], "required/optional inputs, local references and output schemas survive verbatim");
    const reply = value(await call("run_query", { patch: "account-directory", handler: lookup.handler, args: { region: "west", limit: 1 } }));
    assert.equal(reply.versionId, "v3", "return the version Cloud actually executed, even after publication changed");
    assert.deepEqual(reply.value, { count: 1, accounts: ["West account"], received: { region: "west", limit: 1 } });
    assert.deepEqual(seen.at(-1), { method: "POST", path: "/api/patches/accounts2/query", authorization: "Bearer reader",
      body: { handler: lookup.handler, args: { region: "west", limit: 1 } } });
    for (const args of [{}, { region: 12 }, { region: "west", unexpected: true }]) {
      const invalid = await call("run_query", { patch: "account-directory", handler: lookup.handler, args });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0].text, /HTTP 400: Invalid handler arguments/);
    }
    const postCount = seen.filter(request => request.method === "POST").length;
    const write = await call("run_query", { patch: "account-directory", handler: "accounts.delete", args: {} });
    assert.equal(write.isError, true);
    assert.match(write.content[0].text, /No published read-only query.*Mutations and actions cannot be called/);
    assert.equal(seen.filter(request => request.method === "POST").length, postCount);
    const requestsBeforeInvalidMcpInput = seen.length;
    for (const args of [
      { patch: "account-directory", handler: lookup.handler, args: [], mutationKey: "write" },
      { patch: "account-directory", handler: lookup.handler },
      { patch: "..", handler: lookup.handler, args: {} },
    ]) assert.equal((await call("run_query", args)).isError, true);
    assert.equal(seen.length, requestsBeforeInvalidMcpInput, "invalid MCP inputs never reach Cloud");
  });

  test(`[${protocol}] query errors, unavailable Cloud and empty/false/null data remain distinct`, async (t) => {
    let mode = "empty";
    let resultValue = null;
    const call = await connect(t, protocol, (request, response) => {
      if (typeof mode === "number") {
        response.statusCode = mode;
        response.end(JSON.stringify({ error: mode === 404 ? "Patch not found." : mode === 409 ? "Tool is off." : "Refused." }));
      } else if (request.url.endsWith("/queries")) {
        response.end(JSON.stringify(mode === "bad-catalog" ? { queries: [] } : {
          patchId: "accounts2", versionId: "v1", queries: mode === "empty" ? [] : [lookup],
        }));
      } else {
        response.end(JSON.stringify(mode === "bad-reply" ? { patchId: "accounts2", versionId: "v1", result: { ok: true } } : {
          patchId: mode === "wrong-patch" ? "foreign" : "accounts2", versionId: "v1", result: mode === "handler-error"
            ? { ok: false, source: "handler", code: "account_not_found", details: { region: "west" } }
            : { ok: true, value: resultValue },
        }));
      }
    });
    const catalog = () => call("list_queries", { patch: "account-directory" });
    const run = () => call("run_query", { patch: "account-directory", handler: lookup.handler, args: { region: "west" } });
    assert.deepEqual(value(await catalog()).queries, []);
    assert.equal((await run()).isError, true, "empty catalog is not permission to call arbitrary handlers");
    mode = "success";
    for (resultValue of [null, false, 0, "", [], { count: 0 }]) assert.deepEqual(value(await run()).value, resultValue);
    for (const [nextMode, message] of [
      ["bad-catalog", /invalid query catalog/], ["bad-reply", /invalid query reply/], ["wrong-patch", /invalid query reply/],
      ["handler-error", /refused the request \(account_not_found\).*west/],
      [401, /Sign in to Patchy again/], [403, /HTTP 403/], [404, /HTTP 404: Patch not found/],
      [409, /HTTP 409: Tool is off/], [503, /Cloud is unavailable.*HTTP 503/],
    ]) {
      mode = nextMode;
      const error = await run();
      assert.equal(error.isError, true);
      assert.match(error.content[0].text, message);
      assert.equal(error.structuredContent, undefined);
    }
    mode = "success";
    resultValue = { recovered: true };
    assert.deepEqual(value(await run()).value, resultValue);
  });
}
