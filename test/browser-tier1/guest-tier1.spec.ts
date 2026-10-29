import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { Frame } from "@playwright/test";
import type { FixtureWindow } from "./fixture-client.js";
import { manifest, type Published } from "./instance.js";
import { test, expect, open, prepare } from "./fixtures.js";

// A real SDK page deliberately displays only one row and one file's contents.
const readPage = (html: string) =>
  html.replace(
    "</body>",
    `<section><h2>Customer summary</h2><p id="summary">waiting</p><p id="file-data">waiting</p><button id="read-data">Read data</button></section><script>
const client = window.harness.client;
async function readData() {
  try {
    const rows = await client.tables.rows.list({});
    document.getElementById('summary').textContent = rows.rows.filter(row => row.label === 'Visible summary').map(row => row.label).join(', ');
    document.getElementById('file-data').textContent = new TextDecoder().decode(await client.files.assets.get('summary.txt'));
  } catch (error) { document.getElementById('summary').textContent = error.code || String(error); }
}
document.getElementById('read-data').onclick = readData;
void readData();
</script></body>`
  );
const principal = (frame: Frame) =>
  frame.evaluate(async () => {
    const me = await (window as unknown as FixtureWindow).harness.client.me();
    if (!me || !("guest" in me)) throw new Error("Expected the real guest identity");
    return {
      kind: "guest" as const,
      guestId: me.guest.id,
      companyId: me.company.id,
      patchId: me.patchId,
      versionId: me.versionId,
      grantId: me.grantId
    };
  });

test("tier 1 Share opens all owned data through the broker and refuses crafted writes and unrelated resources", async ({
  page,
  browser,
  instance
}, testInfo) => {
  await instance.platform.query(
    "INSERT INTO companies (id, handle, name) VALUES ('cmp_guest_home', 'guest-home', 'Guest home')"
  );
  await instance.platform.query(
    "UPDATE users SET company_id = 'cmp_guest_home', role = 'admin' WHERE id = 'usr_colleague'"
  );
  const other = await instance.publish("company", undefined, undefined, {
    tables: { rows: { ...manifest.tables.rows, shared: true } },
    files: { assets: { ...manifest.files.assets, shared: true } }
  });
  const declarations = {
    uses: {
      members: { kind: "members" as const },
      source: {
        kind: "sharedTable" as const,
        patchId: other.patchId,
        table: "rows",
        id: `${other.patchId}/rows`,
        revision: 1
      },
      library: {
        kind: "sharedStore" as const,
        patchId: other.patchId,
        store: "assets",
        id: `${other.patchId}/assets`,
        revision: 1
      }
    }
  };
  const html = readPage(instance.html);
  const patch = await instance.publish("company", html, undefined, declarations);
  const owner = await open(page, patch);
  const hidden = await owner.evaluate(async () => {
    const client = (window as unknown as FixtureWindow).harness.client;
    await client.tables.rows!.insert({ label: "Visible summary" });
    const hidden = await client.tables.rows!.insert({ label: "Hidden customer raw row" });
    await client.files.assets!.put(
      "summary.txt",
      new TextEncoder().encode("Visible file contents"),
      { contentType: "text/plain" }
    );
    await client.files.assets!.put(
      "hidden/raw.txt",
      new TextEncoder().encode("Hidden raw file contents"),
      { contentType: "text/plain" }
    );
    return hidden;
  });
  const settings = `${instance.origin}/patches/${patch.name}/settings`;
  await page.goto(`${instance.origin}/patches/${patch.name}`);
  await page.getByRole("link", { name: "Share", exact: true }).click();
  await expect(page).toHaveURL(`${settings}#share`);
  await expect(page.getByRole("list", { name: "Declared guest data" })).toContainText(
    "Table: rows"
  );
  await expect(page.getByRole("list", { name: "Declared guest data" })).toContainText(
    "File store: assets"
  );
  await expect(
    page.getByText(/including raw rows and files this page does not display/)
  ).toBeVisible();
  await page.getByLabel("Existing Patchy account email").fill("colleague@patchy.local");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByText("Has access", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("tier1-share.png"), fullPage: true });
  const context = await browser.newContext();
  try {
    await prepare(context, instance);
    await instance.session(context, "colleague");
    const guest = await context.newPage();
    await guest.goto(instance.origin);
    await guest.getByRole("button", { name: "Later", exact: true }).click();
    const shares = guest.getByRole("region", { name: "Shared with you" });
    await expect(shares).toContainText("Patchy Dev");
    await shares.getByRole("link").click();
    await expect(guest).toHaveURL(patch.address);
    await expect(guest.frameLocator("#patch").locator("#summary")).toHaveText("Visible summary");
    const frame = guest.frames().find((frame) => frame.url().includes("/~content/"))!;
    await expect(frame.locator("#file-data")).toHaveText("Visible file contents");
    await expect(frame.locator("#summary")).not.toContainText("Hidden");
    await guest.screenshot({ path: testInfo.outputPath("tier1-guest-read.png"), fullPage: true });
    const authority = await principal(frame);
    expect(authority).toMatchObject({
      companyId: "cmp_dev",
      patchId: patch.patchId,
      versionId: patch.versionId
    });
    const headers = {
      origin: instance.origin,
      "sec-fetch-site": "same-origin",
      "x-patchy-wire": String(instance.wire),
      "x-patchy-principal": JSON.stringify(authority)
    };
    const call = async (op: string, args: unknown, target: Published = patch) => {
      const response = await context.request.post(`${instance.origin}/api/runtime/call`, {
        headers,
        data: {
          patchId: target.patchId,
          versionId: target.versionId,
          wire: instance.wire,
          principal: authority,
          op,
          args
        }
      });
      return { status: response.status(), body: await response.json() };
    };
    expect((await call("tables.get", { table: "rows", id: hidden.id })).body).toMatchObject({
      ok: true,
      value: { label: "Hidden customer raw row" }
    });
    expect((await call("tables.getMany", { table: "rows", ids: [hidden.id] })).body).toMatchObject({
      ok: true,
      value: [{ label: "Hidden customer raw row" }]
    });
    const bytesUrl = `${instance.origin}/api/runtime/files/${patch.patchId}/${patch.versionId}/assets/hidden/raw.txt`;
    const bytes = await context.request.get(bytesUrl, { headers });
    expect(bytes.status()).toBe(200);
    expect(await bytes.text()).toBe("Hidden raw file contents");
    const downloadEvent = guest.waitForEvent("download");
    await frame.evaluate(() =>
      (window as unknown as FixtureWindow).harness.client.files.assets!.download("hidden/raw.txt")
    );
    const download = await downloadEvent;
    expect(await readFile((await download.path())!, "utf8")).toBe("Hidden raw file contents");
    for (const [op, args] of [
      ["tables.insert", { table: "rows", row: { label: "Forbidden write" } }],
      ["tables.update", { table: "rows", id: hidden.id, patch: { label: "Forbidden update" } }],
      ["tables.delete", { table: "rows", id: hidden.id }],
      ["files.delete", { store: "assets", name: "hidden/raw.txt" }],
      ["shared.list", { alias: "source" }],
      ["shared.files.list", { alias: "library" }],
      ["members.list", {}],
      [
        "postgres.query",
        {
          connection: "warehouse",
          sql: "select 1 as value",
          params: [],
          shape: { value: { kind: "integer" } }
        }
      ],
      [
        "posthog.query",
        {
          connection: "analytics",
          name: "probe",
          query: "select 1 as value",
          shape: { value: { kind: "integer" } }
        }
      ],
      ["pidgeon.read", { connection: "mail", operation: "threads.list", input: {} }],
      ["attio.listRecords", { connection: "crm", object: "companies" }],
      ["files.stage", { contentType: "text/plain" }],
      ["server.call", { handler: "hidden.read", args: {} }]
    ] as const) {
      const reply = await call(op, args);
      expect(reply.status, op).toBe(403);
      expect(reply.body, op).toMatchObject({ ok: false, code: "access_denied" });
    }
    expect(await call("tables.list", { table: "undeclared" })).toMatchObject({
      status: 400,
      body: { ok: false, code: "table_not_declared" }
    });
    expect(await call("future.read", {})).toMatchObject({
      status: 403,
      body: { ok: false, code: "access_denied" }
    });
    expect((await call("tables.list", { table: "rows" }, other)).status).toBe(403);
    expect((await context.request.get(bytesUrl)).status()).toBeGreaterThanOrEqual(400);
    expect(
      (
        await context.request.put(bytesUrl, {
          headers: { ...headers, "content-type": "text/plain" },
          data: "Forbidden upload"
        })
      ).status()
    ).toBe(403);
    expect(
      (await context.request.get(bytesUrl.replace("/assets/", "/missing/"), { headers })).status()
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await context.request.get(
          `${instance.origin}/api/runtime/shared-files/${patch.patchId}/${patch.versionId}/library/hidden/raw.txt`,
          { headers }
        )
      ).status()
    ).toBe(403);
    expect((await guest.goto(other.address))?.status()).toBe(404);
    expect((await guest.goto(settings))?.status()).toBe(404);
    await page.goto(`${instance.origin}/company?show=guests`);
    const row = page.getByRole("row").filter({ hasText: "colleague@patchy.local" });
    await expect(row).toContainText("Has access");
    await row.getByRole("button", { name: "Deactivate", exact: true }).click();
    expect((await call("tables.list", { table: "rows" })).status).toBe(403);
    expect((await context.request.get(bytesUrl, { headers })).status()).toBe(403);
    expect((await guest.goto(patch.address))?.status()).toBe(404);
    await row.getByRole("button", { name: "Reactivate", exact: true }).click();
    const restored = await open(guest, patch);
    await expect(restored.locator("#summary")).toHaveText("Visible summary");
    await page.goto(settings);
    await page.getByRole("button", { name: /^Revoke access for / }).click();
    expect((await call("tables.list", { table: "rows" })).status).toBe(403);
    expect((await context.request.get(bytesUrl, { headers })).status()).toBe(403);
    expect((await guest.goto(patch.address))?.status()).toBe(404);
    // Reactivating an already active relationship cannot revive its revoked grant.
    await page.goto(`${instance.origin}/company?show=guests`);
    await row.getByRole("button", { name: "Deactivate", exact: true }).click();
    await row.getByRole("button", { name: "Reactivate", exact: true }).click();
    expect((await guest.goto(patch.address))?.status()).toBe(404);
    // Historical log attribution uses the guest identity after access ends.
    const logs = await instance.platform.query(
      "SELECT DISTINCT guest_id FROM runtime_calls WHERE patch_id = $1 AND guest_id IS NOT NULL",
      [patch.patchId]
    );
    expect(logs.rows).toEqual([{ guest_id: authority.guestId }]);
  } finally {
    await context.close();
  }
});

test("tier 1 guests follow published and rolled-back contracts; off, historical, tier 2 and public transitions keep their boundaries", async ({
  page,
  browser,
  instance
}) => {
  await instance.platform.query(
    "INSERT INTO companies (id, handle, name) VALUES ('cmp_versions_home', 'versions-home', 'Versions home')"
  );
  await instance.platform.query(
    "UPDATE users SET company_id = 'cmp_versions_home', deactivated_at = now() WHERE id = 'usr_colleague'"
  );
  const patch = await instance.publish();
  const owner = await open(page, patch);
  await owner.evaluate(async () => {
    const client = (window as unknown as FixtureWindow).harness.client;
    await client.tables.rows!.insert({ label: "Version data" });
    await client.files.assets!.put("data.txt", new TextEncoder().encode("Version bytes"), {
      contentType: "text/plain"
    });
  });
  const settings = `${instance.origin}/patches/${patch.name}/settings`;
  const share = async () => {
    await page.goto(settings);
    await page.getByLabel("Existing Patchy account email").fill("colleague@patchy.local");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect(page.getByText("Has access", { exact: true })).toBeVisible();
  };
  await share();
  const context = await browser.newContext();
  try {
    await prepare(context, instance);
    await instance.session(context, "colleague");
    const guest = await context.newPage();
    expect((await guest.goto(instance.origin))?.status()).toBe(200);
    await expect(guest.getByRole("link", { name: "People", exact: true })).toHaveCount(0);
    await guest.getByRole("region", { name: "Shared with you" }).getByRole("link").click();
    let frame = await open(guest, patch);
    const authority = await principal(frame);
    const headers = {
      origin: instance.origin,
      "sec-fetch-site": "same-origin",
      "x-patchy-wire": String(instance.wire),
      "x-patchy-principal": JSON.stringify(authority)
    };
    const oldRead = () =>
      context.request.post(`${instance.origin}/api/runtime/call`, {
        headers,
        data: {
          patchId: patch.patchId,
          versionId: patch.versionId,
          principal: authority,
          wire: instance.wire,
          op: "tables.list",
          args: { table: "rows" }
        }
      });
    const added = {
      tables: {
        ...manifest.tables,
        added: {
          description: "Newly published raw data",
          columns: { label: { kind: "text" as const } },
          indexes: {}
        }
      },
      files: { ...manifest.files, addedFiles: { description: "Newly published files" } }
    };
    const newer = await instance.publish(
      "company",
      instance.html.replace("Tier one acceptance", "New guest version"),
      patch.patchId,
      added
    );
    // The existing stream moves the open tab to the current contract without reinviting.
    await expect(guest.locator("#patch")).toHaveAttribute("data-version-id", newer.versionId);
    expect((await oldRead()).status()).toBe(403);
    expect(
      (
        await context.request.get(
          `${instance.origin}/api/runtime/files/${patch.patchId}/${patch.versionId}/assets/data.txt`,
          { headers }
        )
      ).status()
    ).toBe(403);
    expect((await context.request.get(`${patch.address}/~v/1`)).status()).toBe(404);
    expect(
      (
        await context.request.get(`${instance.origin}/~content/${patch.patchId}/${patch.versionId}`)
      ).status()
    ).toBe(404);
    await page.goto(settings);
    await expect(page.getByRole("list", { name: "Declared guest data" })).toContainText(
      "Table: added"
    );
    await expect(page.getByRole("list", { name: "Declared guest data" })).toContainText(
      "File store: addedFiles"
    );
    frame = await open(guest, newer);
    const current = await principal(frame);
    const newHeaders = { ...headers, "x-patchy-principal": JSON.stringify(current) };
    for (const [op, args] of [
      ["tables.list", { table: "added" }],
      ["files.list", { store: "addedFiles" }]
    ] as const) {
      const response = await context.request.post(`${instance.origin}/api/runtime/call`, {
        headers: newHeaders,
        data: {
          patchId: patch.patchId,
          versionId: newer.versionId,
          principal: current,
          wire: instance.wire,
          op,
          args
        }
      });
      expect(response.status()).toBe(200);
    }
    await instance.lifecycle(patch.patchId, "rollback", 1);
    await expect(guest.locator("#patch")).toHaveAttribute("data-version-id", patch.versionId);
    await page.reload();
    await expect(page.getByRole("list", { name: "Declared guest data" })).not.toContainText(
      "Table: added"
    );
    // Let the guest's retirement navigation commit before restoring. Otherwise its
    // pending automatic reload can interrupt the explicit open below.
    const retired = guest.waitForEvent("framenavigated", (frame) => frame === guest.mainFrame());
    await instance.lifecycle(patch.patchId, "retire");
    await retired;
    await expect(guest.locator("#patch")).toHaveCount(0);
    expect((await context.request.get(patch.address)).status()).toBe(404);
    expect((await oldRead()).status()).toBe(403);
    await instance.lifecycle(patch.patchId, "restore");
    await open(guest, patch);
    // Unsupported tier 2 suspends the existing grant rather than ending or admitting it.
    const server = await build({
      stdin: {
        contents: 'import { createGuest } from "patchy/server"; export default createGuest({});',
        resolveDir: fileURLToPath(new URL("../../packages/patchy", import.meta.url))
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm"
    });
    const tier2 = await instance.publish(
      "company",
      undefined,
      patch.patchId,
      { tier: 2, handlers: {} },
      { server: server.outputFiles[0]!.text }
    );
    expect((await context.request.get(patch.address)).status()).toBe(404);
    expect((await oldRead()).status()).toBe(403);
    await page.reload();
    await expect(page.getByLabel("Existing Patchy account email")).toHaveCount(0);
    await expect(
      page.getByText("Grant kept · patch unavailable to guests", { exact: true })
    ).toBeVisible();
    await guest.goto(instance.origin);
    await expect(guest.getByRole("region", { name: "Shared with you" })).toHaveCount(0);
    const tier2Authority = { ...authority, versionId: tier2.versionId };
    const tier2Call = await context.request.post(`${instance.origin}/api/runtime/call`, {
      headers: { ...headers, "x-patchy-principal": JSON.stringify(tier2Authority) },
      data: {
        patchId: patch.patchId,
        versionId: tier2.versionId,
        principal: tier2Authority,
        wire: instance.wire,
        op: "server.call",
        args: { handler: "hidden.read", args: {} }
      }
    });
    expect(tier2Call.status()).toBe(403);
    expect(await tier2Call.json()).toMatchObject({ code: "access_denied" });
    expect(
      (
        await context.request.get(`${instance.origin}/~content/${patch.patchId}/${tier2.versionId}`)
      ).status()
    ).toBe(404);
    await page.goto(`${instance.origin}/company?show=guests`);
    await expect(page.getByRole("row").filter({ hasText: "colleague@patchy.local" })).toContainText(
      "Patch unavailable to guests"
    );
    await page.goto(settings);
    await instance.lifecycle(patch.patchId, "rollback", 1);
    await open(guest, patch);
    await page.reload();
    await page.getByRole("radio", { name: "Anyone on the internet" }).check();
    await page.getByRole("button", { name: "Save who can open it" }).click();
    await expect(page.getByText(/Named guest grants will end/)).toBeVisible();
    await page.getByRole("button", { name: /Make .* public/ }).click();
    await expect(page.getByRole("list", { name: "Declared guest data" })).toHaveCount(0);
    await open(guest, patch);
    expect((await oldRead()).status()).toBeGreaterThanOrEqual(400);
    const bytes = await context.request.get(
      `${instance.origin}/api/runtime/files/${patch.patchId}/${patch.versionId}/assets/data.txt`,
      { headers }
    );
    expect(bytes.status()).toBeGreaterThanOrEqual(400);
    await page.getByRole("radio", { name: "People at the company" }).check();
    await page.getByRole("button", { name: "Save who can open it" }).click();
    expect((await context.request.get(patch.address)).status()).toBe(404);
    await share();
    frame = await open(guest, patch);
    expect((await principal(frame)).grantId).not.toBe(authority.grantId);
    expect(
      await frame.evaluate(() =>
        (window as unknown as FixtureWindow).harness.client.tables.rows!.list({})
      )
    ).toMatchObject({ rows: [{ label: "Version data" }] });
  } finally {
    await context.close();
  }
});
