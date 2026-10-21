import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloud } from "./business.js";

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

export async function httpBusiness(t, entry) {
  const reserve = createServer().listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const dir = await mkdtemp(path.join(tmpdir(), "patchy-business-http-"));
  const trace = path.join(dir, "requests.jsonl");
  const stateDir = path.join(dir, "state");
  const connections = [];
  let server, health;
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const ended = once(server, "exit");
    server.kill("SIGTERM");
    await ended;
  }
  async function start() {
    server = spawn(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("./observe-cloud.js", import.meta.url)),
        entry,
        "serve",
        "--api-url",
        cloud,
        "--port",
        String(port),
        "--state-dir",
        stateDir,
      ],
      {
        // HTTP must work without the developer's CLI credentials or registration.
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PATCHY_HTTP_ACCEPTANCE_TRACE: trace,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let error = "";
    server.stderr.on("data", (data) => {
      error = (error + data).slice(-1000);
    });
    for (let n = 0; n < 100; n++) {
      if (server.exitCode !== null)
        throw new Error(`Installed listener exited: ${error}`);
      try {
        const current = await (await fetch(`${origin}/healthz`)).json();
        assert.equal(current.instanceUrl, cloud);
        if (health) assert.deepEqual(current, health);
        return (health = current);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`Listener did not start: ${error}`);
  }
  t.after(async () => {
    const failures = [];
    for (const c of connections) {
      await c.client.close().catch((e) => failures.push(e.message));
      const r = await form(`${origin}/oauth/revoke`, {
        client_id: c.clientId,
        token: c.refreshToken,
      }).catch(() => null);
      if (r && r.status !== 200)
        failures.push(`OAuth revocation HTTP ${r.status}`);
    }
    // Also cover a connection whose browser flow completed before its client failed.
    const state = await readFile(path.join(stateDir, "oauth.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    for (const [, grant] of state?.grants || []) {
      if (!grant.cloudToken) continue;
      const r = await fetch(`${cloud}/api/logout`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.cloudToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      if (![200, 401].includes(r.status))
        failures.push(`Cloud revocation HTTP ${r.status}`);
    }
    await stop();
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(
      failures,
      [],
      "Only this test's dedicated connections must be cleaned up",
    );
    console.log(
      "HTTP cleanup: dedicated grants revoked; listener and private state removed.",
    );
  });
  await start();

  async function connect(persona, permission) {
    const registrationResponse = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Disposable combined business acceptance",
        redirect_uris: ["http://127.0.0.1:19384/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json();
    const verifier = randomBytes(32).toString("base64url");
    const consent = await fetch(
      `${origin}/oauth/authorize?${new URLSearchParams({
        client_id: registration.client_id,
        redirect_uri: registration.redirect_uris[0],
        response_type: "code",
        resource: `${origin}/mcp`,
        scope: "patchy:tools patchy:write",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        state: "combined-business",
      })}`,
      manual,
    );
    assert.equal(consent.status, 200);
    const cookie = consent.headers.get("set-cookie").split(";")[0];
    const html = await consent.text();
    assert.match(html, /value="read-only" checked/);
    assert.match(html, /value="read-write"/);
    const flow = /action="([^"]+)\/start"/.exec(html)[1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    assert.equal(
      (
        await form(
          `${origin}${flow}/start`,
          { csrf, browserFlow: "direct", permission },
          cookie,
        )
      ).status,
      303,
    );
    const waiting = await (
      await fetch(`${origin}${flow}`, { headers: { cookie } })
    ).text();
    const verification = /href="([^"]+)" target="_blank"/
      .exec(waiting)[1]
      .replaceAll("&amp;", "&");
    assert.equal(new URL(verification).origin, new URL(cloud).origin);
    const login = await fetch(
      `${cloud}/dev/sign-in?${new URLSearchParams({ as: persona, return: "/" })}`,
      manual,
    );
    assert.equal(login.status, 303);
    const cloudCookie = login.headers.get("set-cookie").split(";")[0];
    const confirmHtml = await (
      await fetch(verification, { headers: { cookie: cloudCookie } })
    ).text();
    const code = /name="code" value="([^"]+)"/.exec(confirmHtml)[1];
    const userId = /name="userId" value="([^"]+)"/.exec(confirmHtml)[1];
    const approval = await form(
      `${cloud}/login/device`,
      {
        code,
        userId,
        machineName: "Disposable combined MCP acceptance",
        action: "confirm",
      },
      cloudCookie,
    );
    assert.ok([200, 303].includes(approval.status));
    await new Promise((resolve) => setTimeout(resolve, 5100));
    const done = await fetch(`${origin}${flow}`, {
      ...manual,
      headers: { cookie },
    });
    assert.equal(done.status, 302);
    const callback = new URL(done.headers.get("location"));
    assert.equal(callback.searchParams.get("state"), "combined-business");
    const exchanged = await form(`${origin}/oauth/token`, {
      client_id: registration.client_id,
      grant_type: "authorization_code",
      redirect_uri: registration.redirect_uris[0],
      resource: `${origin}/mcp`,
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
    });
    assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json();
    assert.equal(
      tokens.scope,
      permission === "read-write"
        ? "patchy:tools patchy:write"
        : "patchy:tools",
    );
    const c = {
      httpUrl: `${origin}/mcp`,
      token: tokens.access_token,
      refreshToken: tokens.refresh_token,
      clientId: registration.client_id,
      userId,
      persona,
      permission,
      client: new Client({ name: "combined-business-http", version: "1" }),
    };
    connections.push(c);
    await c.client.connect(
      new StreamableHTTPClientTransport(new URL(c.httpUrl), {
        authProvider: { token: async () => c.token },
      }),
    );
    c.call = (name, args) => c.client.callTool({ name, arguments: args });
    c.value = async (name, args) => {
      const reply = await c.call(name, args);
      assert.notEqual(reply.isError, true, JSON.stringify(reply));
      assert.deepEqual(
        reply.structuredContent,
        JSON.parse(reply.content[0].text),
      );
      return reply.structuredContent;
    };
    c.query = async (patch, handler, args = {}) =>
      (await c.value("run_query", { patch, handler, args })).value;
    c.mutate = async (patch, handler, args) => {
      const catalog = await c.value("list_operations", { patch });
      return c.call("run_mutation", {
        patch: catalog.patchId,
        versionId: catalog.versionId,
        mutationKey: catalog.mutationKey,
        handler,
        args,
      });
    };
    c.refresh = async () => {
      const response = await form(`${origin}/oauth/token`, {
        client_id: c.clientId,
        grant_type: "refresh_token",
        refresh_token: c.refreshToken,
        resource: c.httpUrl,
      });
      assert.equal(response.status, 200);
      const renewed = await response.json();
      assert.notEqual(renewed.refresh_token, c.refreshToken);
      assert.equal(renewed.scope, tokens.scope);
      c.token = renewed.access_token;
      c.refreshToken = renewed.refresh_token;
    };
    return c;
  }
  return {
    health,
    connect,
    restart: async () => {
      await stop();
      await start();
    },
    requests: async () =>
      (await readFile(trace, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse),
    stateSummary: async () => {
      const s = JSON.parse(
        await readFile(path.join(stateDir, "oauth.json"), "utf8"),
      );
      return {
        clients: s.clients.length,
        grants: s.grants.map(([id, g]) => ({
          id,
          userId: g.identity.user.id,
          scopes: g.scopes,
        })),
      };
    },
  };
}
