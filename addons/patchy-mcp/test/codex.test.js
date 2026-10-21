import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const exec = promisify(execFile);
const server = process.env.PATCHY_TEST_CODEX_SERVER;
const signInRequired = process.env.PATCHY_TEST_SIGN_IN_REQUIRED === "1";
assert.ok(
  server,
  "Set PATCHY_TEST_CODEX_SERVER to the isolated Codex registration to check.",
);
assert.ok(
  process.env.PATCHY_API_URL,
  "Set the exact PATCHY_API_URL; no hosted fallback is allowed.",
);
assert.ok(
  signInRequired ||
    process.env.PATCHY_TEST_PAGE ||
    process.env.PATCHY_TEST_LAUNCH_QUEUE ||
    process.env.PATCHY_TEST_QUERY_PATCH,
  "Select existing read-only Cloud content using PATCHY_TEST_PAGE, PATCHY_TEST_LAUNCH_QUEUE or PATCHY_TEST_QUERY_PATCH.",
);

// This checks a real agent application's MCP connection, without a model turn.
// Keep it opt-in and separate from both fixtures and natural-language acceptance.
test(
  "Codex loads the installed registration and consumes existing Cloud content",
  { timeout: 90_000 },
  async (t) => {
    const registration = JSON.parse(
      (await exec("codex", ["mcp", "get", server, "--json"])).stdout,
    );
    assert.equal(registration.transport.type, "stdio");
    assert.equal(
      registration.transport.env.PATCHY_API_URL,
      process.env.PATCHY_API_URL,
    );
    assert.ok(
      !registration.transport.env.PATCHY_API_TOKEN,
      "test saved login, rather than an environment token",
    );
    if (process.env.PATCHY_TEST_MCP_COMMAND) {
      assert.equal(
        await realpath(process.env.PATCHY_TEST_MCP_COMMAND),
        await realpath(registration.transport.args[0]),
        "Codex points to the installed package selected for this test",
      );
    }
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), "patchy-codex-connection-"),
    );
    const child = spawn("codex", ["app-server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    const pending = new Map();
    let id = 0;
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error)
        request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    child.on("error", (error) => {
      for (const request of pending.values()) request.reject(error);
    });
    child.on("close", () => {
      for (const request of pending.values())
        request.reject(
          new Error(`Codex closed before replying. ${stderr.slice(-1000)}`),
        );
    });
    const deadline = setTimeout(() => child.kill("SIGTERM"), 80_000);
    t.after(async () => {
      clearTimeout(deadline);
      lines.close();
      child.kill("SIGTERM");
      await closed;
      await rm(cwd, { recursive: true, force: true });
    });
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        child.stdin.write(
          `${JSON.stringify({ id: requestId, method, params })}\n`,
        );
      });
    await rpc("initialize", {
      clientInfo: { name: "patchy-install-check", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const started = await rpc("thread/start", {
      cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const threadId = started.thread.id;
    const inventory = await rpc("mcpServerStatus/list", { threadId });
    const patchy = inventory.data.find((item) => item.name === server);
    assert.ok(patchy, "Codex loaded the selected registration");
    assert.deepEqual(Object.keys(patchy.tools).sort(), [
      "check_launch_queue",
      "get_patch",
      "list_operations",
      "list_patches",
      "list_queries",
      "read_page",
      "run_mutation",
      "run_query",
    ]);
    if (signInRequired) {
      const response = await rpc("mcpServer/tool/call", {
        threadId,
        server,
        tool: "list_patches",
        arguments: {},
      });
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, /Sign in to Patchy again/);
      console.log(
        "Codex loaded all six tools; fresh unsigned-in state returned sign-in instructions, without content.",
      );
      return;
    }
    const call = async (tool, args) => {
      const response = await rpc("mcpServer/tool/call", {
        threadId,
        server,
        tool,
        arguments: args,
      });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      console.log(`Codex MCP call passed: ${server}/${tool}`);
      return (
        response.structuredContent ??
        JSON.parse(response.content.find((item) => item.type === "text").text)
      );
    };
    const { patches } = await call("list_patches", {});
    if (process.env.PATCHY_TEST_PAGE) {
      const page = patches.find(
        (patch) => patch.name === process.env.PATCHY_TEST_PAGE,
      );
      assert.ok(page, "existing Page appears in discovery");
      const metadata = await call("get_patch", { patch: page.id });
      const document = await call("read_page", { patch: page.name });
      assert.equal(document.id, page.id);
      assert.equal(document.versionNumber, metadata.currentVersion);
      assert.ok(document.html.length);
      if (process.env.PATCHY_TEST_TEXT)
        assert.ok(document.html.includes(process.env.PATCHY_TEST_TEXT));
    }
    if (process.env.PATCHY_TEST_LAUNCH_QUEUE) {
      const queue = await call("check_launch_queue", {});
      assert.equal(queue.total, queue.blocked.length);
      if (process.env.PATCHY_TEST_TOTAL !== undefined)
        assert.equal(queue.total, Number(process.env.PATCHY_TEST_TOTAL));
    }
    if (process.env.PATCHY_TEST_QUERY_PATCH) {
      const patch = process.env.PATCHY_TEST_QUERY_PATCH;
      const handler = process.env.PATCHY_TEST_QUERY_HANDLER;
      assert.ok(
        handler && process.env.PATCHY_TEST_QUERY_ARGS,
        "provide the existing handler and input JSON",
      );
      const catalog = await call("list_queries", { patch });
      assert.ok(catalog.queries.some((query) => query.handler === handler));
      const result = await call("run_query", {
        patch,
        handler,
        args: JSON.parse(process.env.PATCHY_TEST_QUERY_ARGS),
      });
      assert.equal(result.patchId, catalog.patchId);
      if (process.env.PATCHY_TEST_QUERY_EXPECTED !== undefined)
        assert.deepEqual(
          result.value,
          JSON.parse(process.env.PATCHY_TEST_QUERY_EXPECTED),
        );
    }
  },
);
