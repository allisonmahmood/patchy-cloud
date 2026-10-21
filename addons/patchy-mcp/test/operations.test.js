import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const schemas = {
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};
const operations = [
  {
    handler: "rows.list",
    kind: "query",
    description: "Read existing rows",
    ...schemas,
  },
  ...["add", "update", "remove", "reject"].map((verb) => ({
    handler: `rows.${verb}`,
    kind: "mutation",
    description: `${verb} a row`,
    ...schemas,
  })),
];
async function fixture(t, era) {
  const seen = [],
    rows = new Map(),
    commits = new Map();
  let mode = "normal",
    versionId = "v1",
    revision = 0;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const body = text && JSON.parse(text);
    seen.push({
      method: req.method,
      path: req.url,
      body,
      token: req.headers.authorization,
    });
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/operations")) {
      res.end(
        JSON.stringify({
          patchId: "tool1",
          versionId,
          operations:
            mode === "bad-catalog" ? [{ kind: "action" }] : operations,
        }),
      );
      return;
    }
    if (!req.url.endsWith("/mutation")) {
      res.statusCode = 404;
      res.end('{"error":"Not found"}');
      return;
    }
    if (mode === "version-race") {
      res.statusCode = 409;
      res.end(
        '{"ok":false,"source":"patchy","code":"version_changed","error":"Version changed"}',
      );
      return;
    }
    if (mode === "unknown-host") {
      res.statusCode = 503;
      res.end(
        '{"ok":false,"source":"patchy","code":"unknown_outcome","error":"Unknown outcome","correlationId":"corr1"}',
      );
      return;
    }
    if (mode === "forbidden") {
      res.statusCode = 403;
      res.end(
        '{"ok":false,"source":"patchy","code":"access_denied","error":"Access denied"}',
      );
      return;
    }
    if (mode === "malformed") {
      res.end("<html>bad reply</html>");
      return;
    }
    if (mode === "wrong-version") {
      res.end(
        JSON.stringify({
          patchId: "tool1",
          versionId: "wrong",
          result: { ok: true, value: true },
        }),
      );
      return;
    }
    if (mode === "missing-value") {
      res.end(
        JSON.stringify({ patchId: "tool1", versionId, result: { ok: true } }),
      );
      return;
    }
    const request = JSON.stringify(body),
      previous = commits.get(body.mutationKey);
    if (previous) {
      if (previous.request !== request) {
        res.statusCode = 400;
        res.end(
          '{"code":"invalid_request","error":"Key reused with different input"}',
        );
        return;
      }
      res.end(JSON.stringify(previous.reply));
      return;
    }
    if (body.handler === "rows.reject") {
      res.end(
        JSON.stringify({
          patchId: "tool1",
          versionId,
          result: {
            ok: false,
            source: "handler",
            code: "business_rule",
            details: { reason: "refused" },
          },
        }),
      );
      return;
    }
    let value;
    if (body.handler === "rows.add") {
      value = { id: "row1", label: body.args.label };
      rows.set("row1", value);
    } else if (body.handler === "rows.update") {
      value = { id: body.args.id, label: body.args.label };
      rows.set(body.args.id, value);
    } else if (body.handler === "rows.remove")
      value = rows.delete(body.args.id);
    else throw new Error("MCP must not POST an undeclared operation");
    const reply = {
      patchId: "tool1",
      versionId,
      result: {
        ok: true,
        value,
        revisions: { "table:rows": String(++revision) },
      },
    };
    commits.set(body.mutationKey, { request, reply });
    if (mode === "lost-response") {
      req.socket.destroy();
      return;
    }
    res.end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new Client(
    { name: "operations-test", version: "1" },
    {
      versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: era } },
    },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...process.env,
        PATCHY_API_URL: `http://127.0.0.1:${server.address().port}`,
        PATCHY_API_TOKEN: "reader-a",
      },
    }),
  );
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = (name, args) => client.callTool({ name, arguments: args });
  const prepare = async (handler, args) => {
    const catalog = (await call("list_operations", { patch: "tool1" }))
      .structuredContent;
    assert.match(catalog.mutationKey, /^\d+-[A-Za-z0-9_-]{22}$/);
    return {
      patch: catalog.patchId,
      versionId: catalog.versionId,
      handler,
      args,
      mutationKey: catalog.mutationKey,
    };
  };
  return {
    client,
    seen,
    rows,
    commits,
    call,
    prepare,
    mode: (value) => {
      mode = value;
    },
    version: (value) => {
      versionId = value;
    },
  };
}
function success(reply) {
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  assert.equal(reply.structuredContent.outcome, "committed");
  return reply.structuredContent;
}
function failure(reply, outcome) {
  assert.equal(reply.isError, true);
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent);
  assert.equal(reply.structuredContent.outcome, outcome);
  return reply.structuredContent;
}

for (const era of ["legacy", "2026-07-28"]) {
  test(`[${era}] existing declared operations add, update and delete with structured results and conservative annotations`, async (t) => {
    const f = await fixture(t, era);
    const tools = (await f.client.listTools()).tools;
    const write = tools.find((tool) => tool.name === "run_mutation");
    assert.deepEqual(write.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    assert.match(write.description, /DELETE.*potentially destructive/);
    for (const tool of tools.filter((t) => t.name !== "run_mutation")) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
    }
    const added = success(
      await f.call(
        "run_mutation",
        await f.prepare("rows.add", { label: "new row" }),
      ),
    );
    assert.deepEqual(added.value, { id: "row1", label: "new row" });
    assert.equal(added.patchId, "tool1");
    assert.equal(added.revisions["table:rows"], "1");
    const updated = success(
      await f.call(
        "run_mutation",
        await f.prepare("rows.update", { id: "row1", label: "updated" }),
      ),
    );
    assert.deepEqual(updated.args, { id: "row1", label: "updated" });
    assert.equal(updated.value.label, "updated");
    const deleted = success(
      await f.call(
        "run_mutation",
        await f.prepare("rows.remove", { id: "row1" }),
      ),
    );
    assert.equal(deleted.value, true);
    assert.deepEqual(deleted.args, { id: "row1" });
    assert.equal(f.rows.size, 0);
    assert.ok(f.seen.every((req) => req.token === "Bearer reader-a"));
    assert.ok(
      f.seen.every(
        (req) =>
          req.path.endsWith("/operations") || req.path.endsWith("/mutation"),
      ),
    );
    const refused = failure(
      await f.call("run_mutation", await f.prepare("rows.reject", {})),
      "rolled_back",
    );
    assert.equal(refused.error.code, "business_rule");
    assert.deepEqual(refused.error.details, { reason: "refused" });
  });

  test(`[${era}] uncertain writes are never automatically retried; explicit same-key recovery reuses the exact version and arguments`, async (t) => {
    const f = await fixture(t, era),
      input = await f.prepare("rows.add", { label: "once" });
    f.mode("lost-response");
    const unknown = failure(await f.call("run_mutation", input), "unknown");
    assert.equal(unknown.error.code, "unknown_outcome");
    assert.match(unknown.error.message, /Do not automatically retry/);
    assert.equal(unknown.mutationKey, input.mutationKey);
    assert.deepEqual(unknown.args, input.args);
    assert.equal(unknown.versionId, input.versionId);
    assert.equal(f.seen.filter((r) => r.method === "POST").length, 1);
    assert.equal(f.rows.size, 1);
    assert.equal(f.commits.size, 1);
    f.mode("normal");
    // This second tool invocation is an explicit recovery, not connector retry logic.
    const recovered = success(await f.call("run_mutation", input));
    assert.deepEqual(recovered.value, { id: "row1", label: "once" });
    assert.equal(f.commits.size, 1);
    const mismatch = failure(
      await f.call("run_mutation", { ...input, args: { label: "different" } }),
      "refused",
    );
    assert.equal(mismatch.error.code, "invalid_request");
    for (const mode of [
      "unknown-host",
      "malformed",
      "wrong-version",
      "missing-value",
    ]) {
      f.mode(mode);
      const before = f.seen.filter((r) => r.method === "POST").length;
      const result = failure(await f.call("run_mutation", input), "unknown");
      assert.equal(result.mutationKey, input.mutationKey);
      assert.equal(
        f.seen.filter((r) => r.method === "POST").length,
        before + 1,
      );
      if (mode === "unknown-host")
        assert.equal(result.error.correlationId, "corr1");
    }
  });

  test(`[${era}] mutations refuse undeclared handlers, actions, reads, malformed inputs and changed versions before writing`, async (t) => {
    const f = await fixture(t, era),
      input = await f.prepare("rows.add", { label: "safe" });
    for (const handler of [
      "rows.list",
      "rows.send",
      "tables.insert",
      "arbitrary.sql",
    ])
      failure(
        await f.call("run_mutation", { ...input, handler }),
        "not_attempted",
      );
    f.version("v2");
    const changed = failure(
      await f.call("run_mutation", input),
      "not_attempted",
    );
    assert.equal(changed.error.code, "version_changed");
    assert.equal(f.seen.filter((req) => req.method === "POST").length, 0);
    f.version("v1");
    const before = f.seen.length;
    for (const invalid of [
      { ...input, principal: { userId: "admin" } },
      { ...input, mutationKey: "bad" },
      { ...input, patch: "https://example.test/tool" },
      { ...input, versionId: "" },
    ])
      assert.equal((await f.call("run_mutation", invalid)).isError, true);
    assert.equal(f.seen.length, before);
    f.mode("version-race");
    assert.equal(
      failure(await f.call("run_mutation", input), "refused").error.code,
      "version_changed",
    );
    f.mode("forbidden");
    assert.equal(
      failure(await f.call("run_mutation", input), "refused").error.code,
      "access_denied",
    );
    f.mode("bad-catalog");
    assert.equal(
      (await f.call("list_operations", { patch: "tool1" })).isError,
      true,
    );
    const count = f.seen.filter((req) => req.method === "POST").length;
    failure(await f.call("run_mutation", input), "not_attempted");
    assert.equal(f.seen.filter((req) => req.method === "POST").length, count);
  });
}

test("one stdio mutation's discovery and POST retain the same credential if saved-login override changes", async (t) => {
  const { credentialRequest } = await import("../dist/api.js");
  const headers = [];
  const server = createServer((req, res) => {
    headers.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previous = process.env.PATCHY_API_TOKEN;
  try {
    process.env.PATCHY_API_TOKEN = "person-a";
    const call = credentialRequest(`http://127.0.0.1:${server.address().port}`);
    await call("/discovery");
    process.env.PATCHY_API_TOKEN = "person-b";
    await call("/mutation", {});
    assert.deepEqual(headers, ["Bearer person-a", "Bearer person-a"]);
    await credentialRequest(`http://127.0.0.1:${server.address().port}`)(
      "/next-change",
    );
    assert.equal(
      headers.at(-1),
      "Bearer person-b",
      "next intended change can use the repaired login",
    );
  } finally {
    if (previous === undefined) delete process.env.PATCHY_API_TOKEN;
    else process.env.PATCHY_API_TOKEN = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
