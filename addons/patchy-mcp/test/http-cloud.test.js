import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";
import os from "node:os";

const cloud = process.env.PATCHY_TEST_HTTP_CLOUD_URL;
const persona = process.env.PATCHY_TEST_HTTP_PERSONA;
const selected = cloud && new URL(cloud);
if (
  selected &&
  (selected.protocol !== "http:" ||
    (!["127.0.0.1", "localhost", "[::1]"].includes(selected.hostname) &&
      !selected.hostname.endsWith(".localhost")))
)
  throw new Error(
    "This test only admits an explicit local HTTP Cloud instance.",
  );
const manual = { redirect: "manual" };
const form = (url, body, cookie) =>
  fetch(url, {
    ...manual,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: new URL(url).origin,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body),
  });

test(
  "fresh installed/local HTTP walkthrough: sign-in, reads, permission, restart, refresh and dedicated-login revocation",
  { skip: !cloud || !persona, timeout: 45000 },
  async (t) => {
    const reserve = createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const stateDir = await mkdtemp(
      nodePath.join(os.tmpdir(), "patchy-http-walkthrough-"),
    );
    const entry =
      process.env.PATCHY_TEST_MCP_COMMAND ||
      fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    let server, token, refreshToken, registration, client;
    async function stop(signal = "SIGTERM") {
      if (!server || server.exitCode !== null) return;
      const ended = once(server, "exit");
      server.kill(signal);
      await ended;
    }
    async function start(command = entry) {
      server = spawn(
        process.execPath,
        [
          command,
          "serve",
          "--api-url",
          cloud,
          "--port",
          String(port),
          "--state-dir",
          stateDir,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let error = "";
      server.stderr.on("data", (d) => {
        error = (error + d.toString()).slice(-1000);
      });
      for (let i = 0; i < 100; i++) {
        if (server.exitCode !== null)
          throw new Error(`Listener exited: ${error}`);
        try {
          const status = await (
            await fetch(`${origin}/healthz`, {
              headers: { connection: "close" },
            })
          ).json();
          assert.equal(status.instanceUrl, cloud);
          assert.ok(status.buildId);
          return status;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      throw new Error(`Listener did not start: ${error}`);
    }
    const running = await start();
    t.after(async () => {
      if (token)
        await form(`${origin}/oauth/revoke`, {
          token,
          client_id: registration.client_id,
        });
      await client?.close();
      await stop();
      await rm(stateDir, { recursive: true, force: true });
    });
    registration = await (
      await fetch(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "MCP HTTP local auth test",
          redirect_uris: ["http://127.0.0.1:19384/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        }),
      })
    ).json();
    const verifier = randomBytes(32).toString("base64url");
    const consent = await fetch(
      `${origin}/oauth/authorize?${new URLSearchParams({ client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], response_type: "code", resource: `${origin}/mcp`, scope: "patchy:tools patchy:write", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), state: "local-cloud-check" })}`,
      manual,
    );
    assert.equal(consent.status, 200);
    const cookie = consent.headers.get("set-cookie").split(";")[0],
      html = await consent.text();
    assert.match(html, /value="read-only" checked/);
    assert.match(html, /value="read-write"/);
    const path = /action="([^"]+)\/start"/.exec(html)[1],
      csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    assert.equal(
      (
        await form(
          `${origin}${path}/start`,
          { csrf, browserFlow: "direct" },
          cookie,
        )
      ).status,
      303,
    );
    const waiting = await (
      await fetch(`${origin}${path}`, { ...manual, headers: { cookie } })
    ).text();
    const verification = /href="([^"]+)" target="_blank"/
      .exec(waiting)[1]
      .replaceAll("&amp;", "&");
    assert.equal(new URL(verification).origin, new URL(cloud).origin);
    // The instance's documented dev-persona sign-in; no saved CLI login or shared token.
    const login = await fetch(
      `${cloud}/dev/sign-in?${new URLSearchParams({ as: persona, return: "/" })}`,
      manual,
    );
    assert.equal(login.status, 303);
    const cloudCookie = login.headers.get("set-cookie").split(";")[0];
    const confirmation = await fetch(verification, {
      headers: { cookie: cloudCookie },
    });
    assert.equal(confirmation.status, 200);
    const confirmHtml = await confirmation.text();
    const code = /name="code" value="([^"]+)"/.exec(confirmHtml)[1],
      userId = /name="userId" value="([^"]+)"/.exec(confirmHtml)[1];
    const approved = await form(
      `${cloud}/login/device`,
      {
        code,
        userId,
        machineName: `MCP local auth ${randomBytes(4).toString("hex")}`,
        action: "confirm",
      },
      cloudCookie,
    );
    assert.ok(
      [200, 303].includes(approved.status),
      `Device approval HTTP ${approved.status}: ${(await approved.text()).slice(-500)}`,
    );
    // Respect Cloud's five-second poll interval.
    await new Promise((resolve) => setTimeout(resolve, 5100));
    const done = await fetch(`${origin}${path}`, {
      ...manual,
      headers: { cookie },
    });
    assert.equal(done.status, 302, await done.clone().text());
    const callback = new URL(done.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), "local-cloud-check");
    const exchanged = await form(`${origin}/oauth/token`, {
      client_id: registration.client_id,
      grant_type: "authorization_code",
      redirect_uri: registration.redirect_uris[0],
      resource: `${origin}/mcp`,
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
    });
    assert.equal(exchanged.status, 200);
    const initial = await exchanged.json();
    token = initial.access_token;
    refreshToken = initial.refresh_token;
    assert.equal(initial.scope, "patchy:tools");
    assert.ok(refreshToken);
    client = new Client({ name: "real-local-cloud", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        authProvider: { token: async () => token },
      }),
    );
    const inventory = await client.callTool({
      name: "list_patches",
      arguments: {},
    });
    assert.notEqual(inventory.isError, true, JSON.stringify(inventory));
    assert.ok(Array.isArray(inventory.structuredContent.patches));
    assert.deepEqual(
      inventory.structuredContent,
      JSON.parse(inventory.content[0].text),
    );
    const denied = await client.callTool({
      name: "run_mutation",
      arguments: {
        patch: "not-sent",
        versionId: "not-sent",
        handler: "not-sent",
        args: {},
        mutationKey: `${Date.now()}-${randomBytes(16).toString("base64url")}`,
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.outcome, "not_attempted");
    assert.equal(denied.structuredContent.error.code, "insufficient_scope");
    await client.close();
    client = undefined;
    await stop();
    assert.deepEqual(await start(), running);
    // Existing credentials survive a real process restart, with no new device login.
    assert.equal(
      (
        await fetch(`${origin}/mcp`, {
          headers: { authorization: `Bearer ${token}`, connection: "close" },
        })
      ).status,
      405,
    );
    const refreshed = await form(`${origin}/oauth/token`, {
      client_id: registration.client_id,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource: `${origin}/mcp`,
    });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const renewed = await refreshed.json();
    assert.notEqual(renewed.refresh_token, refreshToken);
    token = renewed.access_token;
    refreshToken = renewed.refresh_token;
    client = new Client({ name: "local-cloud-reconnected", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        authProvider: { token: async () => token },
      }),
    );
    const after = await client.callTool({
      name: "list_patches",
      arguments: {},
    });
    assert.notEqual(after.isError, true);
    assert.deepEqual(after.structuredContent, inventory.structuredContent);
    await client.close();
    client = undefined;
    await stop("SIGKILL");
    assert.deepEqual(await start(), running);
    assert.equal(
      (
        await fetch(`${origin}/mcp`, {
          headers: { authorization: `Bearer ${token}`, connection: "close" },
        })
      ).status,
      405,
    );
    if (process.env.PATCHY_TEST_ROLLBACK_COMMAND) {
      await stop();
      const rolledBack = await start(process.env.PATCHY_TEST_ROLLBACK_COMMAND);
      assert.notEqual(rolledBack.version, running.version);
      assert.notEqual(rolledBack.buildId, running.buildId);
      assert.equal(
        (
          await fetch(`${origin}/mcp`, {
            headers: { authorization: `Bearer ${token}`, connection: "close" },
          })
        ).status,
        405,
      );
      await stop();
      assert.deepEqual(await start(), running);
    }
    assert.equal(
      (
        await fetch(`${origin}/mcp`, {
          headers: { authorization: "Bearer invalid-local-check" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await form(`${origin}/oauth/revoke`, {
          client_id: registration.client_id,
          token: refreshToken,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${origin}/mcp`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
      401,
    );
    token = undefined;
    console.log(
      `Verified local Cloud ${cloud}: build ${running.version}/${running.buildId.slice(0, 12)}, fresh device sign-in, ${inventory.structuredContent.patches.length} inventory entries, read-only write refused, process restart and reconnect, rotated refresh, invalid credentials rejected, dedicated login revoked.`,
    );
  },
);
