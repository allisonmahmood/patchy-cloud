import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  auth,
} from "@modelcontextprotocol/client";
import { createHttpApp } from "../dist/http.js";

const hash = (value) => createHash("sha256").update(value).digest("base64url");
const manual = { redirect: "manual" };
async function jsonPost(url, body) {
  return fetch(url, {
    ...manual,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function form(url, body, cookie) {
  return fetch(url, {
    ...manual,
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: new URL(url).origin,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(body),
  });
}
async function fixture(
  t,
  durable = false,
  credentialLifetime = 60 * 86_400_000,
) {
  const devices = new Map(),
    seen = [],
    revoked = new Set();
  let mode = "normal";
  const api = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const input = Buffer.concat(chunks).toString(),
      body = input && JSON.parse(input);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/login/device") {
      const code = `device-${devices.size}`;
      devices.set(code, undefined);
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          ok: true,
          deviceCode: code,
          userCode: code,
          verificationUrl: `${cloudUrl}/login/device?code=${code}`,
          interval: 0.001,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }),
      );
      return;
    }
    if (req.url === "/api/login/device/token") {
      const user = devices.get(body.deviceCode);
      res.end(
        JSON.stringify(
          user === "denied"
            ? { status: "denied" }
            : user
              ? {
                  ok: true,
                  status: "complete",
                  token: `cloud-${user}`,
                  expiresAt: new Date(
                    Date.now() + credentialLifetime,
                  ).toISOString(),
                }
              : { ok: true, status: "pending" },
        ),
      );
      return;
    }
    const user = req.headers.authorization?.replace("Bearer cloud-", "");
    if (!["alice", "bob"].includes(user) || revoked.has(user)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }
    seen.push({ user, path: req.url, body });
    if (req.url === "/api/me") {
      if (mode === "unavailable") {
        res.statusCode = 503;
        res.end('{"error":"Unavailable"}');
        return;
      }
      res.end(
        JSON.stringify({
          user: { id: mode === "changed-identity" ? "mallory" : user },
          company: { id: user === "alice" ? "company-a" : "company-b" },
          machine: { id: `machine-${user}` },
        }),
      );
      return;
    }
    if (req.url === "/api/logout") {
      revoked.add(user);
      res.end('{"ok":true}');
      return;
    }
    const ref = req.url.split("/")[3];
    if (ref === "alice" && user === "bob") {
      res.statusCode = 404;
      res.end('{"error":"Patch not found."}');
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, user === "alice" ? 10 : 1),
    );
    const metadata = {
      id: user,
      name: user,
      tier: 0,
      description: `${user}'s private Page`,
    };
    if (req.url.endsWith("/operations")) {
      res.end(
        JSON.stringify({
          patchId: user,
          versionId: "v1",
          operations: [
            {
              handler: "rows.save",
              kind: "mutation",
              description: "Save a row",
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
            },
            {
              handler: "read.value",
              kind: "query",
              description: "Read a value",
              inputSchema: { type: "object" },
              outputSchema: { type: "string" },
            },
          ],
        }),
      );
      return;
    }
    if (req.url.endsWith("/mutation")) {
      res.end(
        JSON.stringify({
          patchId: user,
          versionId: "v1",
          result: {
            ok: true,
            value: { owner: user, ...body.args },
            revisions: { "table:rows": "1" },
          },
        }),
      );
      return;
    }
    if (req.url === "/api/patches")
      res.end(JSON.stringify({ patches: [metadata] }));
    else if (req.url.endsWith("/page"))
      res.end(
        JSON.stringify({
          id: user,
          name: user,
          versionNumber: 1,
          html: `<p>${user}'s private content</p>`,
        }),
      );
    else if (req.url.endsWith("/queries"))
      res.end(
        JSON.stringify({
          patchId: user,
          versionId: "v1",
          queries: [
            {
              handler: "read.value",
              description: "Read a value",
              inputSchema: { type: "object" },
              outputSchema: { type: "string" },
            },
          ],
        }),
      );
    else if (req.url.endsWith("/query"))
      res.end(
        JSON.stringify({
          patchId: ref === "launch-queue" ? "queue" : user,
          versionId: "v1",
          result: {
            ok: true,
            value: ref === "launch-queue" ? { blocked: [], total: 0 } : user,
          },
        }),
      );
    else res.end(JSON.stringify(metadata));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const cloudUrl = `http://127.0.0.1:${api.address().port}`;
  // Reserve a random loopback port so OAuth metadata is pinned before app construction.
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const stateDir = durable
    ? await mkdtemp(path.join(os.tmpdir(), "patchy-oauth-test-"))
    : undefined;
  let runtime = createHttpApp(origin, cloudUrl, { stateDir });
  let server = runtime.app.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await runtime.close();
    server.closeAllConnections();
    api.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => api.close(resolve)),
    ]);
  });
  if (stateDir) t.after(() => rm(stateDir, { recursive: true, force: true }));
  return {
    stateDir,
    async restart() {
      await runtime.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      runtime = createHttpApp(origin, cloudUrl, { stateDir });
      server = runtime.app.listen(port, "127.0.0.1");
      await once(server, "listening");
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
    origin,
    cloudUrl,
    devices,
    seen,
    revoked,
    setMode: (value) => {
      mode = value;
    },
  };
}
async function register(f, overrides = {}) {
  const metadata = {
    client_name: "Test MCP",
    redirect_uris: ["http://127.0.0.1:19384/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    ...overrides,
  };
  const res = await jsonPost(`${f.origin}/oauth/register`, metadata);
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}
async function authorization(f, client, user, overrides = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const params = {
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge: hash(verifier),
    code_challenge_method: "S256",
    resource: `${f.origin}/mcp`,
    scope: "patchy:tools patchy:write",
    state: randomBytes(16).toString("hex"),
    ...overrides,
  };
  const consent = await fetch(
    `${f.origin}/oauth/authorize?${new URLSearchParams(params)}`,
    manual,
  );
  if (consent.status !== 200) return { response: consent };
  const html = await consent.text(),
    path = /action="([^"]+)\/start"/.exec(html)?.[1];
  assert.equal(consent.headers.get("referrer-policy"), "same-origin");
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const cookie = consent.headers.get("set-cookie").split(";")[0];
  return {
    client,
    verifier,
    params,
    path,
    csrf,
    cookie,
    response: consent,
    async approve(permission = "read-write") {
      const started = await form(
        `${f.origin}${path}/start`,
        { csrf, permission },
        cookie,
      );
      assert.equal(started.status, 303, await started.clone().text());
      const waiting = await fetch(`${f.origin}${path}`, {
        ...manual,
        headers: { cookie },
      });
      const deviceCode = /confirm code <strong>([^<]+)<\/strong>/.exec(
        await waiting.text(),
      )[1];
      f.devices.set(deviceCode, user);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const completed = await fetch(`${f.origin}${path}`, {
        ...manual,
        headers: { cookie },
      });
      assert.equal(completed.status, 302, await completed.clone().text());
      const location = new URL(completed.headers.get("location"));
      assert.equal(location.searchParams.get("state"), params.state);
      assert.equal(location.searchParams.get("iss"), f.origin);
      return location.searchParams.get("code");
    },
  };
}
function exchange(f, flow, code, overrides = {}) {
  return form(`${f.origin}/oauth/token`, {
    client_id: flow.client.client_id,
    grant_type: "authorization_code",
    redirect_uri: flow.params.redirect_uri,
    resource: `${f.origin}/mcp`,
    code_verifier: flow.verifier,
    code,
    ...overrides,
  });
}
async function tokenFor(f, user, client) {
  client ??= await register(f);
  const flow = await authorization(f, client, user),
    code = await flow.approve();
  const response = await exchange(f, flow, code);
  assert.equal(response.status, 200, await response.clone().text());
  return { ...(await response.json()), client, flow, code };
}
async function connect(t, origin, token, era = "2026-07-28") {
  const client = new Client(
    { name: "test-http", version: "1" },
    {
      versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: era } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      authProvider: { token: async () => token },
    }),
  );
  t.after(() => client.close());
  return client;
}
const result = (value) => {
  assert.notEqual(value.isError, true, JSON.stringify(value));
  assert.deepEqual(JSON.parse(value.content[0].text), value.structuredContent);
  return value.structuredContent;
};

test("Codex registration supports code and rotating refresh tokens", async (t) => {
  const f = await fixture(t);
  const client = await register(f, {
    client_name: "Codex",
    grant_types: ["authorization_code", "refresh_token"],
  });
  assert.deepEqual(client.grant_types, ["authorization_code", "refresh_token"]);
  const signedIn = await tokenFor(f, "alice", client);
  assert.ok(signedIn.refresh_token);
  for (const grant_types of [["refresh_token"], ["client_credentials"], []]) {
    const refused = await jsonPost(`${f.origin}/oauth/register`, {
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types,
    });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "invalid_client_metadata");
  }
});

test("HTTP OAuth discovery and SDK client sign-in, on both protocol eras; all eight structured outputs", async (t) => {
  const f = await fixture(t);
  const unauthenticated = await fetch(`${f.origin}/mcp`, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  assert.match(
    unauthenticated.headers.get("www-authenticate"),
    /resource_metadata=/,
  );
  const prm = await (
    await fetch(`${f.origin}/.well-known/oauth-protected-resource/mcp`)
  ).json();
  assert.equal(prm.resource, `${f.origin}/mcp`);
  assert.deepEqual(prm.authorization_servers, [f.origin]);
  const as = await (
    await fetch(`${f.origin}/.well-known/oauth-authorization-server`)
  ).json();
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  // Exercise official client's discovery, registration, PKCE and code exchange too.
  let clientInfo, tokens, verifier, authUrl, discovery;
  const provider = {
    get redirectUrl() {
      return "http://127.0.0.1:19384/callback";
    },
    get clientMetadata() {
      return {
        client_name: "Official SDK",
        redirect_uris: [this.redirectUrl],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        scope: "patchy:tools patchy:write",
        response_types: ["code"],
      };
    },
    clientInformation: () => clientInfo,
    saveClientInformation: (v) => {
      clientInfo = v;
    },
    tokens: () => tokens,
    saveTokens: (v) => {
      tokens = v;
    },
    redirectToAuthorization: (url) => {
      authUrl = url;
    },
    saveCodeVerifier: (v) => {
      verifier = v;
    },
    codeVerifier: () => verifier,
    saveDiscoveryState: (v) => {
      discovery = v;
    },
    discoveryState: () => discovery,
  };
  assert.equal(
    await auth(provider, { serverUrl: new URL(`${f.origin}/mcp`) }),
    "REDIRECT",
  );
  const consent = await fetch(authUrl, manual),
    html = await consent.text();
  const path = /action="([^"]+)\/start"/.exec(html)[1],
    csrf = /name="csrf" value="([^"]+)"/.exec(html)[1],
    cookie = consent.headers.get("set-cookie").split(";")[0];
  await form(
    `${f.origin}${path}/start`,
    { csrf, permission: "read-write" },
    cookie,
  );
  f.devices.set([...f.devices.keys()].at(-1), "alice");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const completed = await fetch(`${f.origin}${path}`, {
    ...manual,
    headers: { cookie },
  });
  const code = new URL(completed.headers.get("location")).searchParams.get(
    "code",
  );
  assert.equal(
    await auth(provider, {
      serverUrl: new URL(`${f.origin}/mcp`),
      authorizationCode: code,
      iss: f.origin,
    }),
    "AUTHORIZED",
  );
  assert.ok(tokens.access_token);
  assert.notEqual(tokens.access_token, "cloud-alice");
  const originalRefresh = tokens.refresh_token;
  assert.equal(
    await auth(provider, { serverUrl: new URL(`${f.origin}/mcp`) }),
    "AUTHORIZED",
  );
  assert.notEqual(tokens.refresh_token, originalRefresh);
  for (const era of ["2026-07-28", "legacy"]) {
    const c = await connect(t, f.origin, tokens.access_token, era);
    const tools = (await c.listTools()).tools;
    assert.equal(tools.length, 8);
    for (const tool of tools) {
      assert.ok(tool.outputSchema, tool.name);
      assert.equal(tool.annotations.readOnlyHint, tool.name !== "run_mutation");
    }
    assert.equal(
      result(await c.callTool({ name: "list_patches", arguments: {} }))
        .patches[0].id,
      "alice",
    );
    assert.equal(
      result(
        await c.callTool({ name: "get_patch", arguments: { patch: "alice" } }),
      ).id,
      "alice",
    );
    assert.match(
      result(
        await c.callTool({ name: "read_page", arguments: { patch: "alice" } }),
      ).html,
      /alice/,
    );
    assert.equal(
      result(
        await c.callTool({
          name: "list_queries",
          arguments: { patch: "alice" },
        }),
      ).queries[0].handler,
      "read.value",
    );
    assert.equal(
      result(
        await c.callTool({
          name: "run_query",
          arguments: { patch: "alice", handler: "read.value", args: {} },
        }),
      ).value,
      "alice",
    );
    assert.equal(
      result(await c.callTool({ name: "check_launch_queue", arguments: {} }))
        .total,
      0,
    );
    const catalog = result(
      await c.callTool({
        name: "list_operations",
        arguments: { patch: "alice" },
      }),
    );
    const changed = result(
      await c.callTool({
        name: "run_mutation",
        arguments: {
          patch: catalog.patchId,
          versionId: catalog.versionId,
          mutationKey: catalog.mutationKey,
          handler: "rows.save",
          args: { label: "HTTP change" },
        },
      }),
    );
    assert.equal(changed.outcome, "committed");
    assert.equal(changed.value.owner, "alice");
    assert.deepEqual(changed.revisions, { "table:rows": "1" });
  }
});

test("OAuth rejects invalid credentials, PKCE, client, resource, redirect, replay and browser CSRF; cancellation", async (t) => {
  const f = await fixture(t),
    client = await register(f);
  for (const overrides of [
    { redirect_uri: "https://evil.example/callback" },
    { resource: `${f.origin}/other` },
    { code_challenge_method: "plain" },
    { scope: "admin" },
  ]) {
    const flow = await authorization(f, client, "alice", overrides);
    if (overrides.redirect_uri) {
      assert.equal(flow.response.status, 400);
      assert.equal(flow.response.headers.get("location"), null);
    } else {
      assert.equal(flow.response.status, 302);
      assert.ok(
        new URL(flow.response.headers.get("location")).searchParams.get(
          "error",
        ),
      );
    }
  }
  const flow = await authorization(f, client, "alice");
  assert.equal(
    (await form(`${f.origin}${flow.path}/start`, { csrf: flow.csrf })).status,
    400,
  );
  assert.equal(
    (
      await form(
        `${f.origin}${flow.path}/start`,
        { csrf: "wrong" },
        flow.cookie,
      )
    ).status,
    400,
  );
  assert.equal(f.devices.size, 0);
  const code = await flow.approve();
  for (const overrides of [
    { code_verifier: "x".repeat(43) },
    { client_id: "unknown" },
    { resource: "http://127.0.0.1:1/mcp" },
    { redirect_uri: "https://evil.example/callback" },
  ])
    assert.equal((await exchange(f, flow, code, overrides)).status, 400);
  const response = await exchange(f, flow, code),
    token = (await response.json()).access_token;
  assert.ok(token);
  assert.equal((await exchange(f, flow, code)).status, 400);
  for (const authorization of [
    "Bearer invalid",
    "Bearer cloud-alice",
    "Basic abc",
    "Bearer",
  ]) {
    for (const method of ["GET", "POST", "DELETE"])
      assert.equal(
        (await fetch(`${f.origin}/mcp`, { method, headers: { authorization } }))
          .status,
        401,
      );
  }
  assert.equal(
    (await fetch(`${f.origin}/mcp?access_token=${token}`)).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: {
          authorization: `Bearer ${token}`,
          origin: "https://evil.example",
        },
      })
    ).status,
    403,
  );
  const cancel = await authorization(f, client, "bob");
  const canceled = await form(
    `${f.origin}${cancel.path}/cancel`,
    { csrf: cancel.csrf },
    cancel.cookie,
  );
  assert.equal(
    new URL(canceled.headers.get("location")).searchParams.get("error"),
    "access_denied",
  );
  f.setMode("changed-identity");
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
});

test("concurrent HTTP users stay isolated; revocation and second instance reject credentials", async (t) => {
  const f = await fixture(t),
    other = await fixture(t);
  const [alice, bob] = await Promise.all([
    tokenFor(f, "alice"),
    tokenFor(f, "bob"),
  ]);
  // Prove HTTP ignores a developer's environment credentials even when present.
  const previous = process.env.PATCHY_API_TOKEN;
  process.env.PATCHY_API_TOKEN = "cloud-alice";
  t.after(() => {
    if (previous === undefined) delete process.env.PATCHY_API_TOKEN;
    else process.env.PATCHY_API_TOKEN = previous;
  });
  const [a, b] = await Promise.all([
    connect(t, f.origin, alice.access_token),
    connect(t, f.origin, bob.access_token),
  ]);
  for (let i = 0; i < 3; i++) {
    const replies = await Promise.all([
      a.callTool({ name: "read_page", arguments: { patch: "alice" } }),
      b.callTool({ name: "read_page", arguments: { patch: "bob" } }),
    ]);
    assert.match(result(replies[0]).html, /alice/);
    assert.match(result(replies[1]).html, /bob/);
  }
  const mutate = async (client, user) => {
    const catalog = result(
      await client.callTool({
        name: "list_operations",
        arguments: { patch: user },
      }),
    );
    return result(
      await client.callTool({
        name: "run_mutation",
        arguments: {
          patch: catalog.patchId,
          versionId: catalog.versionId,
          mutationKey: catalog.mutationKey,
          handler: "rows.save",
          args: { label: user },
        },
      }),
    );
  };
  const writes = await Promise.all([mutate(a, "alice"), mutate(b, "bob")]);
  assert.equal(writes[0].value.owner, "alice");
  assert.equal(writes[1].value.owner, "bob");
  const refusedWrite = await b.callTool({
    name: "run_mutation",
    arguments: {
      patch: "alice",
      versionId: "v1",
      mutationKey: writes[1].mutationKey,
      handler: "rows.save",
      args: { label: "forbidden" },
    },
  });
  assert.equal(refusedWrite.isError, true);
  assert.equal(refusedWrite.structuredContent.outcome, "not_attempted");
  assert.equal(
    f.seen.filter(
      (req) => req.user === "bob" && req.path === "/api/patches/alice/mutation",
    ).length,
    0,
  );
  assert.equal(
    (await b.callTool({ name: "read_page", arguments: { patch: "alice" } }))
      .isError,
    true,
  );
  assert.equal(
    (
      await fetch(`${other.origin}/mcp`, {
        headers: { authorization: `Bearer ${alice.access_token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await form(`${f.origin}/oauth/revoke`, {
        client_id: bob.client.client_id,
        token: alice.access_token,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: { authorization: `Bearer ${alice.access_token}` },
      })
    ).status,
    405,
  );
  assert.equal(
    (
      await form(`${f.origin}/oauth/revoke`, {
        client_id: alice.client.client_id,
        token: alice.access_token,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: { authorization: `Bearer ${alice.access_token}` },
      })
    ).status,
    401,
  );
  assert.equal(f.revoked.has("alice"), true);
  assert.equal(
    result(await b.callTool({ name: "list_patches", arguments: {} })).patches[0]
      .id,
    "bob",
  );
  f.revoked.add("bob");
  assert.equal(
    (
      await fetch(`${f.origin}/mcp`, {
        headers: { authorization: `Bearer ${bob.access_token}` },
      })
    ).status,
    401,
  );
});

test("confidential clients authenticate at exchange; expired codes/tokens and denied device logins fail closed", async (t) => {
  const f = await fixture(t);
  for (const method of ["client_secret_post", "client_secret_basic"]) {
    const client = await register(f, { token_endpoint_auth_method: method });
    const flow = await authorization(f, client, "alice"),
      code = await flow.approve();
    const body = {
      grant_type: "authorization_code",
      redirect_uri: flow.params.redirect_uri,
      resource: `${f.origin}/mcp`,
      code_verifier: flow.verifier,
      code,
      ...(method === "client_secret_post"
        ? { client_id: client.client_id, client_secret: client.client_secret }
        : {}),
    };
    const send = (secret) =>
      method === "client_secret_post"
        ? form(`${f.origin}/oauth/token`, { ...body, client_secret: secret })
        : fetch(`${f.origin}/oauth/token`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              authorization: `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString("base64")}`,
            },
            body: new URLSearchParams(body),
          });
    assert.equal(
      (await send("wrong")).status,
      method === "client_secret_basic" ? 401 : 400,
    );
    assert.equal((await send(client.client_secret)).status, 200);
  }
  const client = await register(f),
    flow = await authorization(f, client, "alice"),
    code = await flow.approve();
  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 61_000;
    assert.equal((await exchange(f, flow, code)).status, 400);
  } finally {
    Date.now = actualNow;
  }
  const token = await tokenFor(f, "alice");
  try {
    Date.now = () => actualNow() + 3_601_000;
    assert.equal(
      (
        await fetch(`${f.origin}/mcp`, {
          headers: { authorization: `Bearer ${token.access_token}` },
        })
      ).status,
      401,
    );
  } finally {
    Date.now = actualNow;
  }
  const denied = await authorization(f, client, "denied");
  const started = await form(
    `${f.origin}${denied.path}/start`,
    { csrf: denied.csrf },
    denied.cookie,
  );
  assert.equal(started.status, 303);
  const waiting = await fetch(`${f.origin}${denied.path}`, {
    ...manual,
    headers: { cookie: denied.cookie },
  });
  const device = /confirm code <strong>([^<]+)<\/strong>/.exec(
    await waiting.text(),
  )[1];
  f.devices.set(device, "denied");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const refusal = await fetch(`${f.origin}${denied.path}`, {
    ...manual,
    headers: { cookie: denied.cookie },
  });
  assert.equal(refusal.status, 302);
  assert.ok(new URL(refusal.headers.get("location")).searchParams.get("error"));
  assert.equal(
    new URL(refusal.headers.get("location")).searchParams.get("code"),
    null,
  );
});

const refresh = (f, token, client, overrides = {}) =>
  form(`${f.origin}/oauth/token`, {
    client_id: client.client_id,
    grant_type: "refresh_token",
    refresh_token: token,
    resource: `${f.origin}/mcp`,
    ...overrides,
  });
const bearerStatus = async (f, token) =>
  (
    await fetch(`${f.origin}/mcp`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).status;

test("durable sign-in survives restart; expired access refreshes without changing identity; replay revokes the family durably", async (t) => {
  const f = await fixture(t, true),
    signed = await tokenFor(f, "alice");
  const confidential = await register(f, {
    token_endpoint_auth_method: "client_secret_post",
  });
  const saved = await readFile(path.join(f.stateDir, "oauth.json"), "utf8");
  assert.ok(!saved.includes(confidential.client_secret));
  assert.ok(!saved.includes(signed.access_token));
  assert.ok(!saved.includes(signed.refresh_token));
  assert.equal((await stat(f.stateDir)).mode & 0o077, 0);
  assert.equal(
    (await stat(path.join(f.stateDir, "oauth.json"))).mode & 0o077,
    0,
  );
  assert.throws(
    () => createHttpApp(f.origin, f.cloudUrl, { stateDir: f.stateDir }),
    /already in use/,
  );
  await f.restart();
  assert.equal(await bearerStatus(f, signed.access_token), 405);
  const other = await register(f);
  assert.equal((await refresh(f, signed.refresh_token, other)).status, 400);
  assert.equal(
    (
      await refresh(f, signed.refresh_token, signed.client, {
        resource: `${f.origin}/wrong`,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await refresh(f, signed.refresh_token, signed.client, {
        scope: "patchy:tools admin",
      })
    ).status,
    400,
  );
  const now = Date.now;
  let renewed;
  try {
    Date.now = () => now() + 3_601_000;
    assert.equal(await bearerStatus(f, signed.access_token), 401);
    const response = await refresh(f, signed.refresh_token, signed.client);
    assert.equal(response.status, 200, await response.clone().text());
    renewed = await response.json();
    assert.notEqual(renewed.refresh_token, signed.refresh_token);
    assert.notEqual(renewed.access_token, signed.access_token);
    assert.equal(renewed.scope, "patchy:tools patchy:write");
    assert.ok(renewed.expires_in <= 3600);
    const client = await connect(t, f.origin, renewed.access_token);
    assert.equal(
      result(await client.callTool({ name: "list_patches", arguments: {} }))
        .patches[0].id,
      "alice",
    );
  } finally {
    Date.now = now;
  }
  await f.restart();
  assert.equal(await bearerStatus(f, renewed.access_token), 405);
  const replay = await refresh(f, signed.refresh_token, signed.client);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
  assert.equal(await bearerStatus(f, renewed.access_token), 401);
  await f.restart();
  assert.equal(
    (await refresh(f, renewed.refresh_token, signed.client)).status,
    400,
  );
});

test("read-only consent denies writes before any Cloud request; refresh cannot widen permission", async (t) => {
  const f = await fixture(t),
    client = await register(f),
    flow = await authorization(f, client, "alice");
  const response = await exchange(f, flow, await flow.approve("read-only"));
  const signed = await response.json();
  assert.equal(signed.scope, "patchy:tools");
  const c = await connect(t, f.origin, signed.access_token);
  assert.equal(
    result(await c.callTool({ name: "list_patches", arguments: {} })).patches[0]
      .id,
    "alice",
  );
  const catalog = result(
    await c.callTool({
      name: "list_operations",
      arguments: { patch: "alice" },
    }),
  );
  const before = f.seen.length;
  const denied = await c.callTool({
    name: "run_mutation",
    arguments: {
      patch: catalog.patchId,
      versionId: catalog.versionId,
      mutationKey: catalog.mutationKey,
      handler: "rows.save",
      args: { label: "refuse" },
    },
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.outcome, "not_attempted");
  assert.equal(denied.structuredContent.error.code, "insufficient_scope");
  assert.match(denied.structuredContent.error.message, /read only/);
  assert.equal(
    f.seen.slice(before).filter((r) => r.path !== "/api/me").length,
    0,
  );
  const wider = await refresh(f, signed.refresh_token, client, {
    scope: "patchy:tools patchy:write",
  });
  assert.equal(wider.status, 400);
  assert.equal((await wider.json()).error, "invalid_scope");
  const refreshed = await refresh(f, signed.refresh_token, client);
  assert.equal(refreshed.status, 200);
  const tokens = await refreshed.json();
  assert.equal(tokens.scope, "patchy:tools");
  assert.equal(
    (
      await form(`${f.origin}/oauth/revoke`, {
        client_id: client.client_id,
        token: tokens.refresh_token,
        token_type_hint: "refresh_token",
      })
    ).status,
    200,
  );
  assert.equal(await bearerStatus(f, tokens.access_token), 401);
  assert.equal(await bearerStatus(f, signed.access_token), 401);
  assert.ok(f.revoked.has("alice"));
  const readRequest = await authorization(f, client, "bob", {
    scope: "patchy:tools",
  });
  const forged = await form(
    `${f.origin}${readRequest.path}/start`,
    { csrf: readRequest.csrf, permission: "read-write" },
    readRequest.cookie,
  );
  assert.equal(forged.status, 400);
});

test("refresh respects finite grant lifetime, Cloud revocation, identity and concurrent replay", async (t) => {
  const f = await fixture(t);
  let signed = await tokenFor(f, "alice");
  f.setMode("changed-identity");
  assert.equal(
    (await refresh(f, signed.refresh_token, signed.client)).status,
    400,
  );
  assert.equal(await bearerStatus(f, signed.access_token), 401);
  f.setMode("normal");
  signed = await tokenFor(f, "alice");
  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 30 * 86_400_000 + 1000;
    assert.equal(
      (await refresh(f, signed.refresh_token, signed.client)).status,
      400,
    );
  } finally {
    Date.now = actualNow;
  }
  signed = await tokenFor(f, "alice");
  const responses = await Promise.all([
    refresh(f, signed.refresh_token, signed.client),
    refresh(f, signed.refresh_token, signed.client),
  ]);
  assert.ok(responses.some((r) => r.status === 400));
  for (const r of responses)
    if (r.status === 200)
      assert.equal(await bearerStatus(f, (await r.json()).access_token), 401);
  signed = await tokenFor(f, "bob");
  f.revoked.add("bob");
  assert.equal(
    (await refresh(f, signed.refresh_token, signed.client)).status,
    400,
  );
});

test("durable state refuses corruption and endpoint changes without resetting credentials", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "patchy-state-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "oauth.json"), '{"format":999}', {
    mode: 0o600,
  });
  assert.throws(
    () =>
      createHttpApp("http://127.0.0.1:54321", "http://127.0.0.1:54322", {
        stateDir: dir,
      }),
    /Cannot load OAuth state/,
  );
  assert.equal(
    await readFile(path.join(dir, "oauth.json"), "utf8"),
    '{"format":999}',
  );
  const f = await fixture(t, true);
  await tokenFor(f, "alice");
  const saved = JSON.parse(
    await readFile(path.join(f.stateDir, "oauth.json"), "utf8"),
  );
  await writeFile(path.join(dir, "oauth.json"), JSON.stringify(saved));
  assert.throws(
    () =>
      createHttpApp("http://127.0.0.1:54321", f.cloudUrl, { stateDir: dir }),
    /Cannot load OAuth state/,
  );
});

test("temporary Cloud outage preserves the refresh token for recovery", async (t) => {
  const f = await fixture(t),
    signed = await tokenFor(f, "alice");
  f.setMode("unavailable");
  const unavailable = await refresh(f, signed.refresh_token, signed.client);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, "temporarily_unavailable");
  f.setMode("normal");
  assert.equal(
    (await refresh(f, signed.refresh_token, signed.client)).status,
    200,
  );
});

test("refresh never extends the original shorter Cloud credential lifetime", async (t) => {
  const f = await fixture(t, false, 30_000),
    signed = await tokenFor(f, "alice");
  assert.ok(signed.expires_in <= 30);
  const now = Date.now;
  try {
    Date.now = () => now() + 31_000;
    assert.equal(
      (await refresh(f, signed.refresh_token, signed.client)).status,
      400,
    );
    assert.equal(await bearerStatus(f, signed.access_token), 401);
  } finally {
    Date.now = now;
  }
});

test("browser sign-in goes directly to Cloud; the waiting tab needs no copied code", async (t) => {
  const f = await fixture(t),
    client = await register(f),
    flow = await authorization(f, client, "alice");
  assert.ok(
    flow.response.headers.get("content-security-policy").includes(f.cloudUrl),
  );
  assert.ok(
    flow.response.headers
      .get("content-security-policy")
      .includes(new URL(client.redirect_uris[0]).origin),
  );
  const script = await fetch(`${f.origin}/oauth/browser.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /form.target = '_blank'/);
  const start = await form(
    `${f.origin}${flow.path}/start`,
    { csrf: flow.csrf, browserFlow: "direct" },
    flow.cookie,
  );
  assert.equal(start.status, 303);
  const verification = new URL(start.headers.get("location"));
  assert.equal(verification.origin, f.cloudUrl);
  assert.match(verification.pathname, /login\/device/);
  const waiting = await fetch(`${f.origin}${flow.path}?wait=1`, {
    headers: { cookie: flow.cookie },
  });
  const html = await waiting.text();
  assert.match(html, /client will connect automatically/);
  assert.doesNotMatch(html, /confirm code <strong>/);
  f.devices.set(verification.searchParams.get("code"), "alice");
  await new Promise((r) => setTimeout(r, 5));
  const completed = await fetch(`${f.origin}${flow.path}`, {
    ...manual,
    headers: { cookie: flow.cookie },
  });
  assert.equal(completed.status, 302);
  const code = new URL(completed.headers.get("location")).searchParams.get(
    "code",
  );
  assert.equal((await exchange(f, flow, code)).status, 200);
});

test("repeated resource indicators accept one identical audience and refuse a different audience", async (t) => {
  const f = await fixture(t),
    client = await register(f),
    flow = await authorization(f, client, "alice");
  const params = new URLSearchParams(flow.params);
  params.append("resource", `${f.origin}/mcp`);
  assert.equal(
    (await fetch(`${f.origin}/oauth/authorize?${params}`, manual)).status,
    200,
  );
  params.append("resource", "https://another.example/mcp");
  const refused = await fetch(`${f.origin}/oauth/authorize?${params}`, manual);
  assert.equal(
    new URL(refused.headers.get("location")).searchParams.get("error"),
    "invalid_target",
  );
  const code = await flow.approve();
  const body = new URLSearchParams({
    client_id: client.client_id,
    grant_type: "authorization_code",
    redirect_uri: flow.params.redirect_uri,
    code,
    code_verifier: flow.verifier,
  });
  body.append("resource", `${f.origin}/mcp`);
  body.append("resource", `${f.origin}/mcp`);
  const token = await fetch(`${f.origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  assert.equal(token.status, 200);
});
