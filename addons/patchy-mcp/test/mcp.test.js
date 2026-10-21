import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { test } from "node:test";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

for (const protocol of ["legacy", "2026-07-28"]) {
  const clientOptions = {
    versionNegotiation: {
      mode: protocol === "legacy" ? "legacy" : { pin: protocol },
    },
  };

  test(`[${protocol}] an MCP client discovers Patchy pages and reads one patch`, async () => {
    const seen = [];
    const api = createServer((request, response) => {
      seen.push({
        path: request.url,
        authorization: request.headers.authorization,
      });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/patches") {
        response.end(
          JSON.stringify({
            patches: [{ id: "patch_1", name: "notes", tier: 0 }],
          }),
        );
      } else if (request.url === "/api/patches/notes") {
        response.end(
          JSON.stringify({
            id: "patch_1",
            name: "notes",
            description: "Team notes",
          }),
        );
      } else if (request.url === "/api/patches/notes/page") {
        response.end(
          JSON.stringify({
            id: "patch_1",
            name: "notes",
            versionNumber: 1,
            html: "<h1>Team notes</h1><p>Company only.</p>",
          }),
        );
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, error: "Patch not found." }));
      }
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    assert.ok(address && typeof address !== "string");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...process.env,
        PATCHY_API_URL: `http://127.0.0.1:${address.port}`,
        PATCHY_API_TOKEN: "test-token",
      },
    });
    const client = new Client(
      { name: "patchy-mcp-test", version: "0.1.0" },
      clientOptions,
    );
    try {
      await client.connect(transport);
      assert.equal(
        client.getProtocolEra(),
        protocol === "legacy" ? "legacy" : "modern",
      );
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "check_launch_queue",
        "get_patch",
        "list_operations",
        "list_patches",
        "list_queries",
        "read_page",
        "run_mutation",
        "run_query",
      ]);

      const patches = await client.callTool({
        name: "list_patches",
        arguments: {},
      });
      assert.equal(patches.isError, undefined);
      assert.deepEqual(JSON.parse(patches.content[0].text), {
        patches: [{ id: "patch_1", name: "notes", tier: 0 }],
      });

      const detail = await client.callTool({
        name: "get_patch",
        arguments: { patch: "notes" },
      });
      assert.equal(detail.isError, undefined);
      assert.equal(
        JSON.parse(detail.content[0].text).description,
        "Team notes",
      );

      const page = await client.callTool({
        name: "read_page",
        arguments: { patch: "notes" },
      });
      assert.equal(page.isError, undefined);
      assert.match(JSON.parse(page.content[0].text).html, /Company only/);
      const denied = await client.callTool({
        name: "read_page",
        arguments: { patch: "foreign" },
      });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /HTTP 404: Patch not found/);

      const missing = await client.callTool({
        name: "get_patch",
        arguments: { patch: "missing" },
      });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /HTTP 404: Patch not found/);
      for (const tool of listed.tools)
        assert.equal(
          tool.annotations.readOnlyHint,
          tool.name !== "run_mutation",
        );
      const invalid = await client.callTool({
        name: "read_page",
        arguments: { patch: "https://example.test/notes" },
      });
      assert.equal(invalid.isError, true);
      assert.match(invalid.content[0].text, /patch id or exact name/);
      const extra = await client.callTool({
        name: "check_launch_queue",
        arguments: { handler: "other.mutate" },
      });
      assert.equal(extra.isError, true);
      assert.deepEqual(seen, [
        { path: "/api/patches", authorization: "Bearer test-token" },
        { path: "/api/patches/notes", authorization: "Bearer test-token" },
        { path: "/api/patches/notes/page", authorization: "Bearer test-token" },
        {
          path: "/api/patches/foreign/page",
          authorization: "Bearer test-token",
        },
        { path: "/api/patches/missing", authorization: "Bearer test-token" },
      ]);
    } finally {
      await client.close();
      api.close();
    }
  });

  test(`[${protocol}] Launch Queue uses one fixed Cloud query and validates its result`, async () => {
    const seen = [];
    let mode = "success";
    const api = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      seen.push({
        method: request.method,
        path: request.url,
        token: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.setHeader("content-type", "application/json");
      if (mode === "denied") {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "Patch not found." }));
      } else {
        response.end(
          JSON.stringify(
            mode === "no-envelope"
              ? {}
              : {
                  patchId: "launchqueue1",
                  versionId: "ver_current",
                  result: {
                    ok: mode !== "refused",
                    ...(mode === "refused" ? { code: "handler_failed" } : {}),
                    value:
                      mode === "malformed"
                        ? {}
                        : {
                            blocked: [
                              {
                                title: "Launch",
                                owner: "Mira",
                                blocker: "Review pending",
                              },
                            ],
                            total: mode === "wrong-total" ? 0 : 1,
                          },
                  },
                },
          ),
        );
      }
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const client = new Client(
      { name: "query-test", version: "0.1.0" },
      clientOptions,
    );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [entry],
          env: {
            ...process.env,
            PATCHY_API_URL: `http://127.0.0.1:${api.address().port}`,
            PATCHY_API_TOKEN: "reader",
            PATCHY_LAUNCH_QUEUE_PATCH: "launchqueue1",
          },
        }),
      );
      const operation = (await client.listTools()).tools.find(
        (t) => t.name === "check_launch_queue",
      );
      assert.equal(operation.annotations.readOnlyHint, true);
      assert.ok(operation.outputSchema);
      const result = await client.callTool({
        name: "check_launch_queue",
        arguments: {},
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.total, 1);
      assert.equal(
        result.structuredContent.blocked[0].blocker,
        "Review pending",
      );
      assert.deepEqual(seen[0], {
        method: "POST",
        path: "/api/patches/launchqueue1/query",
        token: "Bearer reader",
        body: { handler: "queue.blocked", args: {} },
      });
      mode = "denied";
      assert.equal(
        (await client.callTool({ name: "check_launch_queue", arguments: {} }))
          .isError,
        true,
      );
      for (const nextMode of [
        "malformed",
        "wrong-total",
        "no-envelope",
        "refused",
      ]) {
        mode = nextMode;
        const error = await client.callTool({
          name: "check_launch_queue",
          arguments: {},
        });
        assert.equal(error.isError, true);
        assert.match(
          error.content[0].text,
          mode === "refused" ? /refused.*handler_failed/ : /invalid response/,
        );
        assert.equal(error.structuredContent, undefined);
      }
    } finally {
      await client.close();
      api.close();
    }
  });

  test(`[${protocol}] Cloud errors stay distinct from valid empty results and recover on the same connection`, async () => {
    let mode = 200;
    const api = createServer((_request, response) => {
      response.statusCode = mode === "html" ? 404 : mode;
      response.end(
        mode === "html"
          ? "<h1>Not found</h1>"
          : JSON.stringify(
              mode === 200
                ? { patches: [] }
                : { error: mode === 404 ? "Patch not found." : "Refused." },
            ),
      );
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const client = new Client({ name: "errors", version: "1" }, clientOptions);
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [entry],
          env: {
            ...process.env,
            PATCHY_API_URL: `http://127.0.0.1:${api.address().port}`,
            PATCHY_API_TOKEN: "secret-fixture-token",
          },
        }),
      );
      const call = () =>
        client.callTool({ name: "list_patches", arguments: {} });
      assert.deepEqual(JSON.parse((await call()).content[0].text), {
        patches: [],
      });
      for (const [status, expected] of [
        [401, /Sign in to Patchy again/],
        [403, /HTTP 403/],
        [404, /HTTP 404: Patch not found/],
        [503, /Cloud is unavailable.*HTTP 503/],
        ["html", /HTTP 404 without a valid JSON API response/],
      ]) {
        mode = status;
        const error = await call();
        assert.equal(error.isError, true);
        assert.match(error.content[0].text, expected);
        assert.ok(!JSON.stringify(error).includes("secret-fixture-token"));
      }
      mode = 200;
      assert.equal((await call()).isError, undefined);
      await new Promise((resolve) => api.close(resolve));
      const down = await call();
      assert.equal(down.isError, true);
      assert.match(down.content[0].text, /Cloud is unavailable.*127.0.0.1/);
    } finally {
      await client.close();
      api.close();
    }
  });
}
