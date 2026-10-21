import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

assert.ok(process.env.PATCHY_API_URL?.trim(), "Set PATCHY_API_URL to the disposable Cloud instance; no hosted fallback is allowed.");
assert.ok(process.env.PATCHY_TEST_PAGE || process.env.PATCHY_TEST_LAUNCH_QUEUE || process.env.PATCHY_TEST_QUERY_PATCH,
  "Set PATCHY_TEST_PAGE, PATCHY_TEST_LAUNCH_QUEUE=1 and/or PATCHY_TEST_QUERY_PATCH to opt in to real Cloud tests.");
const transport = () => new StdioClientTransport({
  command: process.env.PATCHY_TEST_MCP_COMMAND || process.execPath,
  args: process.env.PATCHY_TEST_MCP_COMMAND ? [] : [fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
  env: { ...process.env },
});

// Opt-in, read-only integration test against a running Cloud and an existing Page.
for (const protocol of ["legacy", "2026-07-28"]) {
  const clientOptions = {
    versionNegotiation: { mode: protocol === "legacy" ? "legacy" : { pin: protocol } },
  };
  test(`[${protocol}] discovers and executes an existing published query with input`, {
    skip: !process.env.PATCHY_TEST_QUERY_PATCH,
  }, async () => {
    const patch = process.env.PATCHY_TEST_QUERY_PATCH;
    const handler = process.env.PATCHY_TEST_QUERY_HANDLER;
    assert.ok(handler, "Set PATCHY_TEST_QUERY_HANDLER to an existing published read-only query.");
    assert.ok(process.env.PATCHY_TEST_QUERY_ARGS, "Set PATCHY_TEST_QUERY_ARGS to its JSON input object.");
    const args = JSON.parse(process.env.PATCHY_TEST_QUERY_ARGS);
    assert.ok(args && typeof args === "object" && !Array.isArray(args));
    assert.ok(Object.keys(args).length, "Select a query with input for this acceptance check.");
    const client = new Client({ name: "patchy-generic-query-check", version: "1" }, clientOptions);
    try {
      await client.connect(transport());
      const call = async (name, arguments_) => {
        const response = await client.callTool({ name, arguments: arguments_ });
        assert.notEqual(response.isError, true, JSON.stringify(response));
        return response.structuredContent;
      };
      const catalog = await call("list_queries", { patch });
      const operation = catalog.queries.find(query => query.handler === handler);
      assert.ok(operation, "Query appears in the live published catalog");
      assert.ok(operation.description.trim());
      assert.ok(operation.inputSchema.properties);
      assert.ok(operation.outputSchema);
      const response = await call("run_query", { patch, handler, args });
      assert.equal(response.patchId, catalog.patchId);
      assert.equal(response.handler, handler);
      assert.ok(response.versionId);
      if (process.env.PATCHY_TEST_QUERY_EXPECTED !== undefined)
        assert.deepEqual(response.value, JSON.parse(process.env.PATCHY_TEST_QUERY_EXPECTED));
      console.log(`Discovered ${handler} and ran it with ${JSON.stringify(args)} on ${response.patchId}/${response.versionId}`);
    } finally { await client.close(); }
  });
  test(
    `[${protocol}] stdio MCP discovers a real Cloud Page`,
    {
      skip: !process.env.PATCHY_TEST_PAGE,
    },
    async () => {
      assert.ok(process.env.PATCHY_API_URL);
      const client = new Client({ name: "patchy-agent-check", version: "0.1.0" }, clientOptions);
      try {
        await client.connect(
          transport(),
        );
        assert.equal(client.getProtocolEra(), protocol === "legacy" ? "legacy" : "modern");
        const call = async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          return JSON.parse(result.content[0].text);
        };
        const { patches } = await call("list_patches", {});
        const found = patches.find(
          (p) => p.name === process.env.PATCHY_TEST_PAGE,
        );
        assert.ok(found, "Page appears in discovery");
        assert.equal(found.scope, "company");
        assert.equal(found.tier, 0);
        const detail = await call("get_patch", { patch: found.id });
        assert.equal((await call("get_patch", { patch: found.name })).id, found.id);
        assert.equal(detail.name, found.name);
        assert.equal(detail.id, found.id);
        for (const patch of [found.id, found.name]) {
          const page = await call("read_page", { patch });
          assert.equal(page.id, found.id);
          assert.equal(page.versionNumber, detail.currentVersion);
          assert.equal(page.address, detail.address);
          assert.ok(page.html.length > 0);
          if (process.env.PATCHY_TEST_TEXT)
            assert.ok(page.html.includes(process.env.PATCHY_TEST_TEXT));
        }
        console.log(
          `Discovered and read company Page ${detail.name}, version ${detail.currentVersion}`,
        );
      } finally {
        await client.close();
      }
    },
  );

  test(
    `[${protocol}] stdio MCP invokes the real published Launch Queue query`,
    {
      skip: !process.env.PATCHY_TEST_LAUNCH_QUEUE,
    },
    async () => {
      assert.ok(process.env.PATCHY_API_URL);
      const client = new Client({ name: "patchy-query-check", version: "0.1.0" }, clientOptions);
      try {
        await client.connect(
          transport(),
        );
        assert.equal(client.getProtocolEra(), protocol === "legacy" ? "legacy" : "modern");
        const response = await client.callTool({
          name: "check_launch_queue",
          arguments: {},
        });
        assert.notEqual(response.isError, true, JSON.stringify(response));
        const value = response.structuredContent;
        assert.ok(value.patchId);
        assert.ok(value.versionId);
        assert.equal(value.total, value.blocked.length);
        if (process.env.PATCHY_TEST_TOTAL !== undefined)
          assert.equal(value.total, Number(process.env.PATCHY_TEST_TOTAL));
        if (process.env.PATCHY_TEST_BLOCKER) {
          assert.ok(
            value.blocked.some(
              (item) => item.blocker === process.env.PATCHY_TEST_BLOCKER,
            ),
          );
        }
      } finally {
        await client.close();
      }
    },
  );
}
