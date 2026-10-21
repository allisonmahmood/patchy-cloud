import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

export const entry = fileURLToPath(
  new URL("../../dist/cli.js", import.meta.url),
);
export const cloud = process.env.PATCHY_TEST_BUSINESS_CLOUD;
export const enabled =
  cloud && process.env.PATCHY_TEST_BUSINESS_DISPOSABLE === "1";
if (cloud) {
  const url = new URL(cloud);
  assert.equal(url.protocol, "http:");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.hostname.endsWith(".localhost"),
    "Business acceptance only admits a disposable local Cloud",
  );
  assert.equal(url.pathname, "/");
  assert.equal(url.search + url.hash + url.username + url.password, "");
}

export async function deviceLogin(persona) {
  const start = await fetch(`${cloud}/api/login/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machineNameHint: "Disposable MCP business acceptance",
    }),
  });
  assert.equal(start.status, 201);
  const login = await start.json();
  assert.equal(new URL(login.verificationUrl).origin, new URL(cloud).origin);
  const signIn = await fetch(
    `${cloud}/dev/sign-in?${new URLSearchParams({ as: persona, return: "/" })}`,
    { redirect: "manual" },
  );
  assert.equal(signIn.status, 303);
  const cookie = signIn.headers.get("set-cookie").split(";")[0];
  const page = await fetch(login.verificationUrl, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const userId = /name="userId" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(userId);
  const confirm = await fetch(`${cloud}/login/device`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin: new URL(cloud).origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code: login.userCode,
      userId,
      machineName: "Disposable MCP acceptance",
      action: "confirm",
    }),
  });
  assert.ok([200, 303].includes(confirm.status));
  await new Promise((resolve) =>
    setTimeout(resolve, login.interval * 1000 + 100),
  );
  const poll = await fetch(`${cloud}/api/login/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceCode: login.deviceCode }),
  });
  assert.equal(poll.status, 200);
  const result = await poll.json();
  assert.equal(result.status, "complete");
  assert.equal(result.user.email, persona);
  return { token: result.token, userId };
}

export async function connect(t, persona) {
  const identity = await deviceLogin(persona);
  const client = new Client({ name: "business-acceptance", version: "1" });
  t.after(async () => {
    try {
      await client.close();
    } finally {
      const response = await fetch(`${cloud}/api/logout`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${identity.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(response.status, 200);
    }
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        PATH: process.env.PATH,
        PATCHY_API_URL: cloud,
        PATCHY_API_TOKEN: identity.token,
      },
    }),
  );
  const call = (name, args) => client.callTool({ name, arguments: args });
  const value = async (name, args) => {
    const reply = await call(name, args);
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    assert.deepEqual(
      reply.structuredContent,
      JSON.parse(reply.content[0].text),
    );
    return reply.structuredContent;
  };
  const operations = (patch) => value("list_operations", { patch });
  const mutate = async (patch, handler, args) => {
    const catalog = await operations(patch);
    return call("run_mutation", {
      patch: catalog.patchId,
      versionId: catalog.versionId,
      mutationKey: catalog.mutationKey,
      handler,
      args,
    });
  };
  const query = async (patch, handler, args = {}) =>
    (await value("run_query", { patch, handler, args })).value;
  return { ...identity, client, call, value, operations, mutate, query };
}
