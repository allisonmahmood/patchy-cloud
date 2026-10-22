import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect } from "./fixtures.js";
import { machineTool } from "./machine-tool.js";

test("machine mutations commit once, retain Tool rules, roll back failures and update the normal UI", async ({
  instance,
  context,
  page
}) => {
  const built = await machineTool();
  const patch = await instance.publish(
    "company",
    built.html,
    undefined,
    { tier: 2, files: {}, handlers: built.handlers },
    { server: built.server }
  );
  await instance.session(context, "colleague");
  await page.goto(patch.address);
  const frame = page.frameLocator("#patch");
  await expect(frame.locator("#status")).toHaveText("ready");
  await expect(frame.locator("#rows")).toHaveText("[]");

  // Use the real device-login flow with the browser's non-admin session.
  const start = await context.request.post(`${instance.origin}/api/login/device`, {
    data: { machineNameHint: "Mutation browser acceptance" }
  });
  expect(start.status()).toBe(201);
  const started = await start.json();
  const form = await context.request.get(started.verificationUrl);
  const userId = (await form.text()).match(/name="userId" value="([^"]+)"/)?.[1];
  expect(userId).toBeTruthy();
  const confirm = await context.request.post(`${instance.origin}/login/device`, {
    headers: { origin: instance.origin },
    form: {
      code: started.userCode,
      userId: userId!,
      machineName: "Mutation browser acceptance",
      action: "confirm"
    }
  });
  expect(confirm.status()).toBe(200);
  await delay(5100);
  const poll = await context.request.post(`${instance.origin}/api/login/device/token`, {
    data: { deviceCode: started.deviceCode }
  });
  const login = await poll.json();
  expect(login.status).toBe("complete");
  const headers = { authorization: `Bearer ${login.token}` };
  const base = `${instance.origin}/api/patches/${patch.patchId}`;
  const mint = () => `${Date.now()}-${randomBytes(16).toString("base64url")}`;
  const envelope = (handler: string, args: Record<string, unknown>, mutationKey = mint()) => ({
    versionId: patch.versionId,
    handler,
    args,
    mutationKey
  });
  const execute = (body: unknown) =>
    context.request.post(`${base}/mutation`, { headers, data: body });
  const discover = await context.request.get(`${base}/operations`, { headers });
  expect(discover.status()).toBe(200);
  const catalog = await discover.json();
  expect(catalog.operations.map((op: { handler: string }) => op.handler)).not.toContain(
    "rows.send"
  );
  expect(catalog.operations.find((op: { handler: string }) => op.handler === "rows.add").kind).toBe(
    "mutation"
  );
  const identity = await (
    await context.request.get(`${instance.origin}/api/me`, { headers })
  ).json();
  expect(identity.role).toBe("member");

  const add = envelope("rows.add", { label: "from MCP" });
  const first = await execute(add);
  expect(first.status()).toBe(200);
  const saved = await first.json();
  expect(saved.result.ok).toBe(true);
  expect(saved.result.value).toMatchObject({ label: "from MCP" });
  expect(Object.keys(saved.result.revisions).length).toBeGreaterThan(0);
  await expect(frame.locator("#rows")).toContainText("from MCP");
  for (const replay of await Promise.all([execute(add), execute(add)])) {
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(saved);
  }
  expect((await execute({ ...add, args: { label: "different" } })).status()).toBe(400);
  const id = saved.result.value.id;
  const read = await context.request.post(`${base}/query`, {
    headers,
    data: { handler: "rows.get", args: { id } }
  });
  expect((await read.json()).result.value).toEqual(saved.result.value);
  const update = await execute(envelope("rows.update", { id, label: "updated by MCP" }));
  expect(update.status()).toBe(200);
  expect((await update.json()).result.value).toMatchObject({ id, label: "updated by MCP" });
  await expect(frame.locator("#rows")).toContainText("updated by MCP");
  const refused = await execute(
    envelope("rows.add", { label: "rollback business error", reject: true })
  );
  expect(refused.status()).toBe(200);
  expect((await refused.json()).result).toMatchObject({
    ok: false,
    source: "handler",
    code: "rejected"
  });
  expect((await execute(envelope("rows.invalid", {}))).status()).toBe(500);
  const admin = await execute(envelope("rows.admin", {}));
  expect((await admin.json()).result).toMatchObject({ ok: false, code: "admin_only" });
  expect((await execute(envelope("rows.add", {}))).status()).toBe(400);
  expect((await execute(envelope("rows.add", { label: "x", extra: true }))).status()).toBe(400);
  for (const handler of ["rows.send", "rows.list", "tables.insert"])
    expect((await execute(envelope(handler, {}))).status()).toBe(400);
  expect((await execute({ ...add, principal: { userId: "usr_dev" } })).status()).toBe(400);
  expect(
    (
      await context.request.post(`${base}/query`, {
        headers,
        data: { handler: "rows.add", args: { label: "not a query" } }
      })
    ).status()
  ).toBe(400);
  expect((await context.request.post(`${base}/mutation`, { data: add })).status()).toBe(401);
  const list = await context.request.post(`${base}/query`, {
    headers,
    data: { handler: "rows.list", args: {} }
  });
  expect((await list.json()).result.value).toHaveLength(1);
  const remove = await execute(envelope("rows.remove", { id }));
  expect(remove.status()).toBe(200);
  expect((await remove.json()).result).toMatchObject({ ok: true, value: true });
  await expect(frame.locator("#rows")).toHaveText("[]");

  const logs = await instance.platform.query(
    "SELECT initiating_viewer_id FROM runtime_invocations WHERE patch_id=$1 AND handler='rows.add'",
    [patch.patchId]
  );
  expect(logs.rows.length).toBeGreaterThan(0);
  expect(logs.rows.every((row) => row.initiating_viewer_id === identity.user.id)).toBe(true);
  await instance.publish(
    "company",
    built.html,
    patch.patchId,
    { tier: 2, files: {}, handlers: built.handlers },
    { server: built.server }
  );
  const stale = await execute(add);
  expect(stale.status()).toBe(409);
  expect((await stale.json()).code).toBe("version_changed");
  await context.request.post(`${instance.origin}/api/logout`, { headers, data: {} });
  expect((await execute(add)).status()).toBe(401);
});
