import { assert, describe, it } from "@effect/vitest";
import * as Revisions from "./Revisions.js";

const meta = (version: string = Revisions.MODERN) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2.1.308" },
  "io.modelcontextprotocol/clientCapabilities": {}
});

/** A modern request with the headers a conforming client sends. */
const modern = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => ({
  body: { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta() } },
  headers: {
    protocolVersion: Revisions.MODERN,
    method,
    ...(typeof params["name"] === "string" ? { name: params["name"] } : {})
  }
});

const refusal = (classified: Revisions.Classified) => {
  if (classified.kind !== "refused") return assert.fail(`Expected a refusal: ${classified.kind}`);
  return classified;
};

describe("which era a request belongs to", () => {
  it("serves a request carrying the per-request envelope statelessly at 2026-07-28", () => {
    const classified = Revisions.classify(modern("tools/call", { name: "find_patches" }));
    assert.deepStrictEqual(classified, {
      kind: "request",
      era: "modern",
      id: 1,
      method: "tools/call",
      params: { name: "find_patches", _meta: meta() },
      version: Revisions.MODERN,
      clientInfo: { name: "claude-code", version: "2.1.308" }
    });
  });

  it("serves initialize, and a request without an envelope, as legacy", () => {
    const initialize = Revisions.classify({
      body: {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: "0.163.0" }
        }
      },
      headers: {}
    });
    assert.include(initialize, {
      kind: "request",
      era: "legacy",
      method: "initialize",
      version: "2025-06-18"
    });
    assert.deepStrictEqual(initialize.kind === "request" && initialize.clientInfo, {
      name: "codex-mcp-client",
      version: "0.163.0"
    });
    assert.include(
      Revisions.classify({
        body: { jsonrpc: "2.0", id: "a", method: "tools/list" },
        headers: { protocolVersion: "2025-06-18" }
      }),
      { kind: "request", era: "legacy", version: "2025-06-18" }
    );
    // Before 2025-06-18 a client sent no header; nothing depends on it.
    assert.include(
      Revisions.classify({ body: { jsonrpc: "2.0", id: 2, method: "ping" }, headers: {} }),
      { kind: "request", era: "legacy", version: undefined }
    );
  });

  it("never refuses a legacy initialize, whatever version or header it names", () => {
    for (const [requested, protocolVersion] of [
      ["1999-01-01", undefined],
      ["2026-07-28", undefined],
      [undefined, undefined],
      ["2025-11-25", Revisions.MODERN]
    ] as const) {
      const classified = Revisions.classify({
        body: {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: requested === undefined ? {} : { protocolVersion: requested }
        },
        headers: protocolVersion === undefined ? {} : { protocolVersion }
      });
      assert.include(classified, { kind: "request", era: "legacy", method: "initialize" });
    }
  });

  it("answers the newest legacy version to an initialize naming one it doesn't serve", () => {
    assert.strictEqual(Revisions.negotiate("2025-06-18"), "2025-06-18");
    assert.strictEqual(Revisions.negotiate("2025-11-25"), "2025-11-25");
    for (const requested of ["2025-03-26", "2024-11-05", "2026-07-28", "soon", undefined])
      assert.strictEqual(Revisions.negotiate(requested), "2025-11-25", String(requested));
  });

  it("acknowledges a notification in either era, keeping what spoke it", () => {
    assert.deepStrictEqual(
      Revisions.classify({
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
        headers: { protocolVersion: "2025-06-18" }
      }),
      {
        kind: "notification",
        era: "legacy",
        method: "notifications/initialized",
        version: "2025-06-18",
        clientInfo: undefined
      }
    );
    assert.deepStrictEqual(
      Revisions.classify({
        body: {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1, _meta: meta() }
        },
        headers: {}
      }),
      {
        kind: "notification",
        era: "modern",
        method: "notifications/cancelled",
        version: Revisions.MODERN,
        clientInfo: { name: "claude-code", version: "2.1.308" }
      }
    );
  });
});

describe("the modern status table", () => {
  it("refuses an envelope naming a version Patchy doesn't serve per request, listing the ones it does", () => {
    for (const version of ["2027-01-01", "2025-06-18"]) {
      const request = modern("tools/list");
      const refused = refusal(
        Revisions.classify({
          body: { ...request.body, params: { _meta: meta(version) } },
          headers: { ...request.headers, protocolVersion: version }
        })
      );
      assert.strictEqual(refused.status, 400);
      assert.deepStrictEqual(refused.error.code, -32022);
      assert.deepStrictEqual(refused.error.data, {
        supported: ["2026-07-28", "2025-11-25", "2025-06-18"],
        requested: version
      });
      assert.strictEqual(refused.id, 1);
      assert.strictEqual(refused.reason, "unsupported_version");
    }
  });

  it("refuses missing or mismatched MCP-Protocol-Version, Mcp-Method and Mcp-Name headers", () => {
    const call = modern("tools/call", { name: "find_patches", arguments: {} });
    for (const headers of [
      { method: "tools/call", name: "find_patches" },
      { ...call.headers, protocolVersion: "2025-11-25" },
      { protocolVersion: Revisions.MODERN, name: "find_patches" },
      { ...call.headers, method: "tools/list" },
      { protocolVersion: Revisions.MODERN, method: "tools/call" },
      { ...call.headers, name: "open_patch" },
      { ...call.headers, name: "=?base64?not base64?=" },
      { ...call.headers, name: "=?base64?b3Blbl9wYXRjaA==?=" }
    ]) {
      const refused = refusal(Revisions.classify({ body: call.body, headers }));
      assert.strictEqual(refused.status, 400, JSON.stringify(headers));
      assert.strictEqual(refused.error.code, -32020, JSON.stringify(headers));
      assert.strictEqual(refused.reason, "header_mismatch");
      // Its event still says what the request said of itself.
      assert.include(refused, { era: "modern", method: "tools/call", version: Revisions.MODERN });
      assert.deepStrictEqual(refused.clientInfo, { name: "claude-code", version: "2.1.308" });
    }
    // prompts/get and resources/read mirror theirs too, though the door serves neither.
    for (const [method, params, header] of [
      ["prompts/get", { name: "summary" }, undefined],
      ["prompts/get", { name: "summary" }, "other"],
      ["resources/read", { uri: "file:///a" }, undefined],
      ["resources/read", { uri: "file:///a" }, "file:///b"]
    ] as const) {
      const request = modern(method, params);
      const refused = refusal(
        Revisions.classify({
          body: request.body,
          headers: { protocolVersion: Revisions.MODERN, method, name: header }
        })
      );
      assert.strictEqual(refused.error.code, -32020, `${method} ${header}`);
    }
    // The base64 sentinel carries a name a header can't; it decodes before comparing.
    assert.include(
      Revisions.classify({
        body: { ...call.body, params: { ...call.body.params, name: "find_patches" } },
        headers: { ...call.headers, name: "=?base64?ZmluZF9wYXRjaGVz?=" }
      }),
      { kind: "request", era: "modern" }
    );
  });

  it("refuses a modern header without the envelope, and an envelope missing what it requires", () => {
    for (const [params, headers] of [
      [{}, { protocolVersion: Revisions.MODERN, method: "tools/list" }],
      [{ _meta: {} }, { protocolVersion: "2099-01-01", method: "tools/list" }],
      [
        {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": Revisions.MODERN
          }
        },
        { protocolVersion: Revisions.MODERN, method: "tools/list" }
      ],
      [
        { _meta: { ...meta(), "io.modelcontextprotocol/clientCapabilities": "all" } },
        { protocolVersion: Revisions.MODERN, method: "tools/list" }
      ],
      [
        { _meta: { ...meta(), "io.modelcontextprotocol/protocolVersion": 20260728 } },
        { protocolVersion: Revisions.MODERN, method: "tools/list" }
      ],
      [
        { _meta: { ...meta(), "io.modelcontextprotocol/clientInfo": { name: 1 } } },
        { protocolVersion: Revisions.MODERN, method: "tools/list" }
      ]
    ] as const) {
      const refused = refusal(
        Revisions.classify({
          body: { jsonrpc: "2.0", id: 7, method: "tools/list", params },
          headers
        })
      );
      assert.strictEqual(refused.status, 400, JSON.stringify(params));
      assert.strictEqual(refused.error.code, -32602, JSON.stringify(params));
      assert.strictEqual(refused.reason, "invalid_envelope");
    }
  });

  it("refuses a legacy request naming a version Patchy doesn't serve", () => {
    const refused = refusal(
      Revisions.classify({
        body: { jsonrpc: "2.0", id: 3, method: "tools/list" },
        headers: { protocolVersion: "2025-03-26" }
      })
    );
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(refused.error.code, -32022);
    assert.include(refused, { era: "legacy", version: "2025-03-26" });
  });
});

describe("one request is one message", () => {
  it("refuses a batch in any era, and anything that isn't one JSON-RPC request", () => {
    for (const body of [
      [],
      [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } }],
      null,
      "tools/list",
      { id: 1, method: "ping" },
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 1, method: 7 },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: {}, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: "ping", params: [] }
    ]) {
      const refused = refusal(Revisions.classify({ body, headers: {} }));
      assert.strictEqual(refused.status, 400, JSON.stringify(body));
      assert.strictEqual(refused.error.code, -32600, JSON.stringify(body));
    }
  });

  it("echoes the id of a request it can read", () => {
    const refused = refusal(
      Revisions.classify({
        body: { jsonrpc: "2.0", id: "req-9", method: "ping", params: [] },
        headers: {}
      })
    );
    assert.strictEqual(refused.id, "req-9");
  });
});
