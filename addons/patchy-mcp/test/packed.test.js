import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  readFile,
  mkdtemp,
  rm,
  access,
  writeFile,
  realpath,
} from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { checkCurrentWire } from "./support/wire.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

test(
  "the tarball installs without a registry/build and serves current and legacy protocols",
  { timeout: 120_000 },
  async (t) => {
    await exec("npm", ["run", "release"], { cwd: root, timeout: 60_000 });
    const metadata = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    const name = `patchy-mcp-${metadata.version}.tgz`;
    const archive = await readFile(path.join(root, "artifacts", name));
    const checksum = await readFile(
      path.join(root, "artifacts", `${name}.sha256`),
      "utf8",
    );
    assert.equal(
      checksum.split(" ")[0],
      createHash("sha256").update(archive).digest("hex"),
    );
    const temp = await mkdtemp(
      path.join(os.tmpdir(), "patchy-packed-install-"),
    );
    const prefix = path.join(temp, "installed prefix");
    const api = createServer(async (request, response) => {
      if (request.url === `/${name}`) {
        response.setHeader("content-type", "application/octet-stream");
        response.end(archive);
      } else {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/patches/accounts/operations") {
          assert.equal(request.headers.authorization, "Bearer fixture-token");
          response.end(
            JSON.stringify({
              patchId: "accounts",
              versionId: "v1",
              operations: [
                {
                  handler: "rows.add",
                  kind: "mutation",
                  description: "Add a row",
                  inputSchema: { type: "object" },
                  outputSchema: { type: "object" },
                },
              ],
            }),
          );
          return;
        }
        if (request.url === "/api/patches/accounts/mutation") {
          assert.equal(request.headers.authorization, "Bearer fixture-token");
          let raw = "";
          for await (const part of request) raw += part;
          const input = JSON.parse(raw);
          assert.equal(input.versionId, "v1");
          assert.equal(input.handler, "rows.add");
          response.end(
            JSON.stringify({
              patchId: "accounts",
              versionId: "v1",
              result: {
                ok: true,
                value: { id: "fixture-row", ...input.args },
                revisions: { "table:rows": "1" },
              },
            }),
          );
          return;
        }

        if (request.headers.authorization !== "Bearer fixture-token") {
          response.statusCode = 401;
          response.end(
            JSON.stringify({ error: "Missing or invalid API token." }),
          );
        } else if (request.url === "/api/patches") {
          response.end(
            JSON.stringify({
              patches: [{ id: "page1", name: "notes", tier: 0 }],
            }),
          );
        } else if (request.url === "/api/patches/notes") {
          response.end(
            JSON.stringify({
              id: "page1",
              name: "notes",
              description: "Installed Page",
            }),
          );
        } else if (request.url === "/api/patches/notes/page") {
          response.end(
            JSON.stringify({
              id: "page1",
              name: "notes",
              versionNumber: 1,
              html: "<p>Company only.</p>",
            }),
          );
        } else if (
          request.url === "/api/patches/launch-queue/query" &&
          request.method === "POST"
        ) {
          response.end(
            JSON.stringify({
              patchId: "queue1",
              versionId: "version1",
              result: {
                ok: true,
                value: {
                  blocked: [
                    {
                      title: "Installed launch",
                      owner: "Mira",
                      blocker: "Review pending",
                    },
                  ],
                  total: 1,
                },
              },
            }),
          );
        } else if (request.url === "/api/patches/accounts/queries") {
          response.end(
            JSON.stringify({
              patchId: "accounts",
              versionId: "v1",
              queries: [
                {
                  handler: "accounts.count",
                  description: "Count accounts in a region",
                  inputSchema: {
                    type: "object",
                    properties: { region: { type: "string" } },
                    required: ["region"],
                  },
                  outputSchema: { type: "object" },
                },
              ],
            }),
          );
        } else if (
          request.url === "/api/patches/accounts/query" &&
          request.method === "POST"
        ) {
          let text = "";
          for await (const chunk of request) text += chunk;
          assert.deepEqual(JSON.parse(text), {
            handler: "accounts.count",
            args: { region: "west" },
          });
          response.end(
            JSON.stringify({
              patchId: "accounts",
              versionId: "v1",
              result: {
                ok: true,
                value: { count: 3, region: "west" },
              },
            }),
          );
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "Patch not found." }));
        }
      }
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const url = `http://127.0.0.1:${api.address().port}`;
    let client;
    try {
      // Registry deliberately unreachable. Bundled runtime dependencies must be sufficient.
      await exec(
        "npm",
        [
          "install",
          "--global",
          "--prefix",
          prefix,
          "--cache",
          path.join(temp, "empty cache"),
          "--registry",
          "http://127.0.0.1:1",
          "--ignore-scripts",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          `${url}/${name}`,
        ],
        { timeout: 60_000 },
      );
      const binary = path.join(prefix, "bin/patchy-mcp");
      assert.equal(
        (await exec(binary, ["--version"])).stdout.trim(),
        metadata.version,
      );
      const installed = path.join(prefix, "lib/node_modules/patchy-mcp");
      assert.ok(
        (await realpath(binary)).startsWith(
          `${await realpath(installed)}${path.sep}`,
        ),
      );
      await access(path.join(installed, "SETUP.md"));
      await assert.rejects(access(path.join(installed, "src")));
      await assert.rejects(
        access(path.join(installed, "node_modules/typescript")),
      );
      for (const file of [
        "api.js",
        "cli.js",
        "index.js",
        "queries.js",
        "operations.js",
        "http.js",
        "oauth.js",
        "stdio.js",
      ]) {
        assert.doesNotMatch(
          await readFile(path.join(installed, "dist", file), "utf8"),
          /patchy-cloud|\/private\/tmp\/patchy|\/Users\/srikar\//,
          "runtime has no Cloud checkout or developer path dependency",
        );
      }
      const sdk = JSON.parse(
        await readFile(
          path.join(
            installed,
            "node_modules/@modelcontextprotocol/server/package.json",
          ),
          "utf8",
        ),
      );
      assert.equal(
        sdk.version,
        metadata.dependencies["@modelcontextprotocol/server"],
      );
      // Import the installed HTTP entry, proving every new runtime dependency was bundled.
      const { createHttpApp } = await import(
        pathToFileURL(path.join(installed, "dist/http.js")).href
      );
      const reserve = createServer();
      reserve.listen(0, "127.0.0.1");
      await once(reserve, "listening");
      const httpPort = reserve.address().port;
      await new Promise((resolve) => reserve.close(resolve));
      const httpOrigin = `http://127.0.0.1:${httpPort}`;
      const http = createHttpApp(httpOrigin, url);
      const listener = http.app.listen(httpPort, "127.0.0.1");
      await once(listener, "listening");
      try {
        assert.equal(
          (await fetch(`${httpOrigin}/mcp`, { method: "POST" })).status,
          401,
        );
        const discovery = await (
          await fetch(`${httpOrigin}/.well-known/oauth-authorization-server`)
        ).json();
        assert.equal(discovery.issuer, httpOrigin);
      } finally {
        await http.close();
        listener.closeAllConnections();
        await new Promise((resolve) => listener.close(resolve));
      }
      const env = {
        ...process.env,
        PATCHY_API_URL: url,
        PATCHY_API_TOKEN: "fixture-token",
        PATCHY_LAUNCH_QUEUE_PATCH: "",
      };
      for (const protocol of ["legacy", "2026-07-28"]) {
        client = new Client(
          { name: "installed-agent", version: "1" },
          {
            versionNegotiation: {
              mode: protocol === "legacy" ? "legacy" : { pin: protocol },
            },
          },
        );
        await client.connect(
          new StdioClientTransport({ command: binary, env }),
        );
        assert.equal(
          client.getProtocolEra(),
          protocol === "legacy" ? "legacy" : "modern",
        );
        assert.equal(client.getServerVersion().version, metadata.version);
        assert.equal((await client.listTools()).tools.length, 8);
        const call = async (name, args = {}) => {
          const response = await client.callTool({ name, arguments: args });
          assert.notEqual(response.isError, true, JSON.stringify(response));
          return JSON.parse(response.content[0].text);
        };
        assert.equal((await call("list_patches")).patches[0].name, "notes");
        assert.equal(
          (await call("get_patch", { patch: "notes" })).description,
          "Installed Page",
        );
        assert.match(
          (await call("read_page", { patch: "notes" })).html,
          /Company only/,
        );
        assert.equal((await call("check_launch_queue")).total, 1);
        assert.deepEqual(
          (await call("list_queries", { patch: "accounts" })).queries[0]
            .inputSchema.required,
          ["region"],
        );
        assert.deepEqual(
          (
            await call("run_query", {
              patch: "accounts",
              handler: "accounts.count",
              args: { region: "west" },
            })
          ).value,
          { count: 3, region: "west" },
        );
        const operations = await call("list_operations", { patch: "accounts" });
        const changed = await call("run_mutation", {
          patch: operations.patchId,
          versionId: operations.versionId,
          mutationKey: operations.mutationKey,
          handler: "rows.add",
          args: { label: "packed fixture" },
        });
        assert.equal(changed.outcome, "committed");
        assert.equal(changed.value.id, "fixture-row");
        const missing = await client.callTool({
          name: "read_page",
          arguments: { patch: "missing" },
        });
        assert.equal(missing.isError, true);
        assert.match(missing.content[0].text, /HTTP 404/);
        await client.close();
      }
      await checkCurrentWire(t, {
        command: binary,
        env,
        version: metadata.version,
      });
      // Uninstalling the connector must not delete a separately managed Patchy login.
      const savedLogin = path.join(temp, "separate-login-state");
      await writeFile(savedLogin, "fixture login remains owned by Patchy");
      await exec("npm", [
        "uninstall",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "patchy-mcp",
      ]);
      await assert.rejects(access(binary));
      await assert.rejects(access(installed));
      assert.equal(
        await readFile(savedLogin, "utf8"),
        "fixture login remains owned by Patchy",
      );
    } finally {
      await client?.close();
      api.close();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
