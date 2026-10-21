import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

// Literal spec values keep this check independent of the SDK's client and codecs.
export const currentProtocol = "2026-07-28";
export const currentMeta = {
  "io.modelcontextprotocol/protocolVersion": currentProtocol,
  "io.modelcontextprotocol/clientInfo": { name: "plain-jsonrpc", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

export function startWire(t, options) {
  const child = spawn(options.command, options.args ?? [], {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(() => child.kill());
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  let id = 0;
  return {
    async request(method, params = {}) {
      const requestId = ++id;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`,
      );
      while (true) {
        const { value, done } = await lines.next();
        assert.equal(done, false, `MCP exited before replying: ${stderr}`);
        const message = JSON.parse(value);
        assert.equal(message.jsonrpc, "2.0", "stdout contains only JSON-RPC");
        if (message.id === requestId) return message;
        assert.equal(
          message.id,
          undefined,
          "only notifications may occur between replies",
        );
      }
    },
    async close() {
      child.stdin.end();
      assert.deepEqual(await closed, [0, null]);
      assert.equal(stderr, "");
    },
  };
}

export async function checkCurrentWire(t, options) {
  const wire = startWire(t, options);
  const request = (method, params = {}) =>
    wire.request(method, { ...params, _meta: currentMeta });
  const complete = (reply) => {
    assert.equal(reply.error, undefined);
    assert.equal(reply.result.resultType, "complete");
    assert.equal(
      reply.result._meta["io.modelcontextprotocol/serverInfo"].name,
      "patchy",
    );
    assert.equal(
      reply.result._meta["io.modelcontextprotocol/serverInfo"].version,
      options.version,
    );
    return reply.result;
  };

  // An unsupported opening can be corrected on the same pipe, as provided by the SDK.
  const unsupportedRevision = await wire.request("server/discover", {
    _meta: {
      ...currentMeta,
      "io.modelcontextprotocol/protocolVersion": "2099-01-01",
    },
  });
  assert.equal(unsupportedRevision.error.code, -32022);

  // No initialize/initialized exchange: the current protocol carries its envelope per request.
  const discovered = complete(await request("server/discover"));
  assert.ok(discovered.supportedVersions.includes(currentProtocol));
  assert.ok(discovered.capabilities.tools);
  assert.equal(
    discovered.serverInfo,
    undefined,
    "identity belongs in response metadata",
  );
  assert.equal(discovered.ttlMs, 0);
  assert.equal(discovered.cacheScope, "private");
  const inventory = complete(await request("tools/list"));
  assert.deepEqual(inventory.tools.map((tool) => tool.name).sort(), [
    "check_launch_queue",
    "get_patch",
    "list_operations",
    "list_patches",
    "list_queries",
    "read_page",
    "run_mutation",
    "run_query",
  ]);
  assert.equal(inventory.ttlMs, 0);
  assert.equal(inventory.cacheScope, "private");
  const page = complete(
    await request("tools/call", {
      name: "read_page",
      arguments: { patch: "notes" },
    }),
  );
  assert.notEqual(page.isError, true);
  assert.match(JSON.parse(page.content[0].text).html, /Company only/);
  const catalog = complete(
    await request("tools/call", {
      name: "list_queries",
      arguments: { patch: "accounts" },
    }),
  );
  assert.notEqual(catalog.isError, true);
  assert.deepEqual(catalog.structuredContent.queries[0].inputSchema.required, [
    "region",
  ]);
  const query = complete(
    await request("tools/call", {
      name: "run_query",
      arguments: {
        patch: "accounts",
        handler: "accounts.count",
        args: { region: "west" },
      },
    }),
  );
  assert.notEqual(query.isError, true);
  assert.deepEqual(query.structuredContent.value, { count: 3, region: "west" });
  const deniedOperation = complete(
    await request("tools/call", {
      name: "run_query",
      arguments: {
        patch: "accounts",
        handler: "accounts.delete",
        args: {},
      },
    }),
  );
  assert.equal(deniedOperation.isError, true);
  assert.match(deniedOperation.content[0].text, /No published read-only query/);

  const missing = complete(
    await request("tools/call", {
      name: "read_page",
      arguments: { patch: "missing" },
    }),
  );
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /HTTP 404/);
  const invalid = complete(
    await request("tools/call", {
      name: "read_page",
      arguments: { patch: "" },
    }),
  );
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /patch id or exact name/);
  const unknown = await request("tools/call", {
    name: "unknown",
    arguments: {},
  });
  assert.equal(unknown.error.code, -32602);
  assert.equal(unknown.result, undefined);
  const unsupportedMethod = await request("patchy/unknown");
  assert.equal(unsupportedMethod.error.code, -32601);
  const missingEnvelope = await wire.request("tools/list");
  assert.equal(missingEnvelope.error.code, -32602);
  const badEnvelope = await wire.request("tools/list", {
    _meta: {
      ...currentMeta,
      "io.modelcontextprotocol/clientCapabilities": "invalid",
    },
  });
  assert.equal(badEnvelope.error.code, -32602);
  // Errors do not poison the connection or silently downgrade its era.
  complete(await request("tools/list"));
  await wire.close();
}
