import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Frame } from "@playwright/test";
import type { FixtureWindow } from "./fixture-client.js";
import { test, expect, prepare, open, installSessionRefreshBoundary } from "./fixtures.js";
import { manifest, type Instance, type Published } from "./instance.js";
import { recipient, recipientSession } from "./external-recipient.js";

test.use({ serverEnvironment: { PATCHY_DEV_EXTERNAL_SHARING: "true" } });

async function grant(instance: Instance, patch: Published, id: string, owner = "usr_dev") {
  await instance.platform.query(
    "INSERT INTO patch_grants (id,patch_id,email,subject,created_by) VALUES ($1,$2,$3,$4,$5)",
    [id, patch.patchId, recipient.email, recipient.sub, owner]
  );
}

async function partnerPatch(instance: Instance) {
  await instance.platform.query(
    "INSERT INTO companies (id,handle,name) VALUES ('cmp_partner','partner','Partner Company')"
  );
  await instance.platform.query(
    "UPDATE users SET company_id='cmp_partner',role='admin' WHERE id='usr_colleague'"
  );
  const token = "local-partner-test-token";
  await instance.platform.query(
    "INSERT INTO machine_tokens (id,user_id,name,token_hash,expires_at,last_used_at) VALUES ('mt_partner','usr_colleague','Partner test',$1,now()+interval '1 day',now())",
    [createHash("sha256").update(token).digest("hex")]
  );
  const release = await (await fetch(`${instance.origin}/api/release`)).json();
  const response = await fetch(`${instance.origin}/api/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      publishKey: crypto.randomUUID(),
      scope: "company",
      metadata: {},
      manifest: { ...manifest, release: release.release, manifestVersion: release.manifestVersion },
      html: instance.html.replaceAll("Tier one acceptance", "Partner live tool")
    })
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Published;
}

const insert = (frame: Frame, label: string) =>
  frame.evaluate(
    (label) => (window as unknown as FixtureWindow).harness.client.tables.rows!.insert({ label }),
    label
  );
const subscribe = (frame: Frame) =>
  frame.evaluate(() => (window as unknown as FixtureWindow).harness.subscribeRows());
const put = (frame: Frame, value: string) =>
  frame.evaluate(
    (value) =>
      (window as unknown as FixtureWindow).harness.client.files.assets!.put(
        "shared.txt",
        new TextEncoder().encode(value),
        { contentType: "text/plain" }
      ),
    value
  );
const get = (frame: Frame) =>
  frame.evaluate(async () =>
    new TextDecoder().decode(
      await (window as unknown as FixtureWindow).harness.client.files.assets!.get("shared.txt")
    )
  );

test("one recipient uses live patches from two companies without connecting their access", async ({
  browser,
  page: owner,
  instance
}, testInfo) => {
  const a = await instance.publish(
    "company",
    instance.html.replaceAll("Tier one acceptance", "Company A live tool")
  );
  const unrelated = await instance.publish();
  const b = await partnerPatch(instance);
  await grant(instance, a, "share_live_a");
  await grant(instance, b, "share_live_b", "usr_colleague");
  const external = await browser.newContext();
  const partner = await browser.newContext();
  try {
    await prepare(external, instance);
    await recipientSession(external, instance);
    await installSessionRefreshBoundary(external, () => recipientSession(external, instance));
    await prepare(partner, instance);
    await instance.session(partner, "colleague");
    const pageA = await external.newPage();
    const pageB = await external.newPage();
    const partnerPage = await partner.newPage();
    await pageA.goto(`${instance.origin}/`);
    await expect(pageA.getByText("Can use this patch", { exact: true })).toHaveCount(2);
    await pageA.screenshot({
      path: testInfo.outputPath("recipient-home-two-companies.png"),
      fullPage: true
    });
    const ownerFrame = await open(owner, a);
    const recipientA = await open(pageA, a, "/items/3");
    await expect(recipientA.locator("#route")).toHaveText("/items/3");
    await expect(recipientA.locator("#identity")).toHaveText(`recipient:${recipient.sub}`);
    const recipientB = await open(pageB, b);
    const partnerFrame = await open(partnerPage, b);
    await subscribe(ownerFrame);
    await subscribe(recipientA);
    await subscribe(recipientB);
    await insert(recipientA, "Recipient changed A");
    await expect(ownerFrame.locator("#subscription-rows")).toHaveText('["Recipient changed A"]');
    await insert(ownerFrame, "Owner changed A");
    await expect
      .poll(async () =>
        JSON.parse(await recipientA.locator("#subscription-rows").innerText()).sort()
      )
      .toEqual(["Owner changed A", "Recipient changed A"]);
    await insert(partnerFrame, "Company B data");
    await expect(recipientB.locator("#subscription-rows")).toHaveText('["Company B data"]');
    await put(recipientA, "Recipient file in A");
    expect(await get(ownerFrame)).toBe("Recipient file in A");
    await put(ownerFrame, "Owner updated the same file");
    expect(await get(recipientA)).toBe("Owner updated the same file");
    await pageA.screenshot({ path: testInfo.outputPath("live-recipient-a.png"), fullPage: true });

    // Each company can manage its own grants only. Bob never connects their clouds.
    expect((await owner.request.get(b.address)).status()).toBe(404);
    expect((await partner.request.get(a.address)).status()).toBe(404);
    await owner.goto(`${instance.origin}/shared`);
    await expect(owner.locator('form[action="/~shared/revoke/share_live_a"]')).toHaveCount(1);
    await expect(owner.locator('form[action="/~shared/revoke/share_live_b"]')).toHaveCount(0);
    expect(
      (
        await partner.request.post(`${instance.origin}/~shared/revoke/share_live_a`, {
          headers: { origin: instance.origin }
        })
      ).status()
    ).toBe(403);
    expect((await external.request.get(unrelated.address)).status()).toBe(404);
    expect(
      (
        await external.request.get(
          `${instance.origin}/~content/${unrelated.patchId}/${unrelated.versionId}`
        )
      ).status()
    ).toBe(404);
    for (const path of ["/company", "/patches", "/machines", "/join"])
      expect((await external.request.get(`${instance.origin}${path}`)).status(), path).toBe(403);
    expect(
      (await external.request.post(`${instance.origin}/api/publish`, { data: {} })).status()
    ).toBe(401);
    const call = (patch: Published, op: string, args: object) =>
      external.request.post(`${instance.origin}/api/runtime/call`, {
        headers: {
          origin: instance.origin,
          "x-patchy-wire": String(instance.wire),
          "x-patchy-principal": JSON.stringify({ userId: `recipient:${recipient.sub}` })
        },
        data: {
          patchId: patch.patchId,
          versionId: patch.versionId,
          principal: { userId: `recipient:${recipient.sub}` },
          wire: instance.wire,
          op,
          args
        }
      });
    expect((await call(unrelated, "tables.list", { table: "rows" })).status()).toBe(403);
    // No declared directory or company connection, even inside the granted patch.
    expect(await (await call(a, "members.list", {})).json()).toMatchObject({
      ok: false,
      code: "access_denied"
    });
    expect(
      await (
        await call(a, "postgres.list", {
          connection: "private",
          relation: { schema: "public", name: "customers" }
        })
      ).json()
    ).toMatchObject({ ok: false, code: "connection_not_declared" });

    // An existing company member receives B without losing membership or publishing rights in A.
    await instance.platform.query(
      "INSERT INTO patch_grants (id,patch_id,email,subject,created_by) VALUES ('share_member_b',$1,'dev@patchy.local','user_dev','usr_colleague')",
      [b.patchId]
    );
    const memberPage = await owner.context().newPage();
    const memberFrame = await open(memberPage, b);
    await expect(memberFrame.locator("#identity")).toHaveText("recipient:user_dev");
    expect((await owner.request.get(`${instance.origin}/company`)).status()).toBe(200);
    expect(
      (await instance.platform.query("SELECT company_id FROM users WHERE id='usr_dev'")).rows
    ).toEqual([{ company_id: "cmp_dev" }]);
    await memberPage.close();

    // Publishing changes the same patch, retains its state and leaves its old live document working.
    const updated = await instance.publish(
      "company",
      instance.html.replaceAll("Tier one acceptance", "Company A updated tool"),
      a.patchId
    );
    const rawOld = await external.request.get(
      `${instance.origin}/~content/${a.patchId}/${a.versionId}`
    );
    expect(rawOld.status()).toBe(200);
    expect(await rawOld.text()).toContain("Company A live tool");
    expect(rawOld.headers()["content-security-policy"]).toContain("sandbox");
    await insert(recipientA, "Old document still live");
    const current = await open(pageA, updated);
    await expect(current.getByRole("heading", { name: "Company A updated tool" })).toBeVisible();
    await subscribe(current);
    await expect(current.locator("#subscription-rows")).toContainText("Old document still live");
    await owner.locator('form[action="/~shared/revoke/share_live_a"] button').click();
    await expect(pageA).toHaveURL(/\/(?:~shared\/ended|~shell\/notice\/access_denied\?)/);
    await expect(pageA.locator("iframe")).toHaveCount(0);
    expect(
      (
        await call(updated, "tables.insert", {
          table: "rows",
          row: { label: "Denied after revoke" }
        })
      ).status()
    ).toBe(403);
    await insert(recipientB, "B still works after A revokes");
    await expect(recipientB.locator("#subscription-rows")).toContainText(
      "B still works after A revokes"
    );
    await pageB.screenshot({
      path: testInfo.outputPath("live-recipient-b-after-a-revoked.png"),
      fullPage: true
    });
    await pageA.goto(`${instance.origin}/`);
    await expect(pageA.getByText("Company A updated tool", { exact: true })).toHaveCount(0);
    await expect(pageA.getByText("Partner live tool", { exact: true })).toBeVisible();
    expect(
      (
        await instance.platform.query("SELECT id FROM users WHERE clerk_user_id=$1", [
          recipient.sub
        ])
      ).rows
    ).toEqual([]);
  } finally {
    await external.close();
    await partner.close();
  }
});

test("a recipient uses server handlers and declared shared dependencies without access to their source patch", async ({
  browser,
  page: owner,
  instance
}, testInfo) => {
  const source = await instance.publish("company", undefined, undefined, {
    tables: { rows: { ...manifest.tables.rows, shared: true } },
    files: { assets: { ...manifest.files.assets, shared: true } }
  });
  const sourceFrame = await open(owner, source);
  await insert(sourceFrame, "Shared reference data");
  await put(sourceFrame, "Shared reference file");
  const handlers = {
    "rows.list": { kind: "query", args: {}, result: { kind: "array", element: { kind: "text" } } },
    "rows.shared": {
      kind: "query",
      args: {},
      result: { kind: "array", element: { kind: "text" } }
    },
    "rows.add": { kind: "mutation", args: { label: { kind: "text" } }, result: { kind: "json" } },
    "files.exchange": {
      kind: "action",
      args: { content: { kind: "text" } },
      result: { kind: "text" }
    }
  } as const;
  const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
  const server = await build({
    stdin: {
      contents: `import { query, mutation, action, createGuest, t } from "patchy/server";
const list = query({args:{},result:t.array(t.text()),handler:async ctx => (await ctx.tables.rows.list({})).rows.map(row=>row.label)});
const shared = query({args:{},result:t.array(t.text()),handler:async ctx => (await ctx.shared.source.list({})).rows.map(row=>row.label)});
const add = mutation({args:{label:t.text()},result:t.json(),handler:(ctx,args)=>ctx.tables.rows.insert(args)});
const exchange = action({args:{content:t.text()},result:t.text(),handler:async (ctx,args)=>{
  await ctx.files.assets.put("shared.txt",new TextEncoder().encode(args.content),{contentType:"text/plain"});
  return new TextDecoder().decode(await ctx.shared.library.get("shared.txt"));
}});
export default createGuest({rows:{list,shared,add},files:{exchange}},["library"]);`,
      resolveDir: packageRoot,
      sourcefile: "external-live-server.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    conditions: ["development"]
  });
  const client = await build({
    stdin: {
      contents: `import {createServerClient} from "patchy/client";
import {render,useQuery,useState} from "patchy/preact";
const client=createServerClient();
function Rows({id,query}){const snapshot=useQuery(query,{});return <section id={id}><p>{snapshot.status}</p><pre>{JSON.stringify(snapshot.data??[])}</pre><output class="error">{snapshot.error?.code}: {snapshot.error?.message}</output></section>}
function App(){const[label,setLabel]=useState("");const[saved,setSaved]=useState("");const[file,setFile]=useState("");return <main>
<h1>Shared live workspace</h1><label>Label<input value={label} onChange={e=>setLabel(e.currentTarget.value)}/></label>
<button onClick={async()=>{await client.server.rows.add({label});setSaved(label)}}>Save</button><output id="saved">{saved}</output>
<button onClick={async()=>{try{setFile(await client.server.files.exchange({content:"Recipient action file"}))}catch(error){setFile(error.code??error.message)}}}>Use shared file</button><output id="file">{file}</output>
<Rows id="owned" query={client.server.rows.list}/><Rows id="shared" query={client.server.rows.shared}/></main>}
render(<App/>,document.getElementById("app"));`,
      resolveDir: packageRoot,
      sourcefile: "external-live-page.tsx",
      loader: "tsx"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "patchy/preact",
    define: { "import.meta.env.DEV": "false" }
  });
  const patch = await instance.publish(
    "company",
    `<!doctype html><html><head><title>Shared live workspace</title></head><body><div id="app"></div><script>${client.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`,
    undefined,
    {
      tier: 2,
      handlers,
      uses: {
        source: {
          kind: "sharedTable",
          patchId: source.patchId,
          table: "rows",
          id: `${source.patchId}/rows`,
          revision: 1
        },
        library: {
          kind: "sharedStore",
          patchId: source.patchId,
          store: "assets",
          id: `${source.patchId}/assets`,
          revision: 1
        }
      }
    },
    { server: server.outputFiles[0]!.text }
  );
  await grant(instance, patch, "share_live_server");
  const external = await browser.newContext();
  try {
    await prepare(external, instance);
    await recipientSession(external, instance);
    await installSessionRefreshBoundary(external, () => recipientSession(external, instance));
    const page = await external.newPage();
    expect((await page.goto(patch.address))?.status()).toBe(200);
    const frame = page.frameLocator("#patch");
    await expect
      .poll(async () => {
        const status = await frame.locator("#owned p").innerText();
        return status === "error" ? await frame.locator("#owned .error").innerText() : status;
      })
      .toBe("ready");
    await expect(frame.locator("#shared pre")).toHaveText('["Shared reference data"]');
    await frame.getByLabel("Label", { exact: true }).fill("Recipient server mutation");
    await frame.getByRole("button", { name: "Save", exact: true }).click();
    await expect(frame.locator("#saved")).toHaveText("Recipient server mutation");
    await expect(frame.locator("#owned pre")).toHaveText('["Recipient server mutation"]');
    await owner.goto(patch.address);
    await expect(owner.frameLocator("#patch").locator("#owned pre")).toHaveText(
      '["Recipient server mutation"]'
    );
    await frame.getByRole("button", { name: "Use shared file", exact: true }).click();
    await expect(frame.locator("#file")).toHaveText("Shared reference file");
    expect((await external.request.get(source.address)).status()).toBe(404);
    expect(
      (
        await external.request.get(
          `${instance.origin}/~content/${source.patchId}/${source.versionId}`
        )
      ).status()
    ).toBe(404);
    await page.screenshot({
      path: testInfo.outputPath("recipient-server-handler-and-dependencies.png"),
      fullPage: true
    });
    const revoke = await owner.request.post(`${instance.origin}/~shared/revoke/share_live_server`, {
      headers: { origin: instance.origin },
      maxRedirects: 0
    });
    expect(revoke.status()).toBe(303);
    await expect(page).toHaveURL(/\/(?:~shared\/ended|~shell\/notice\/access_denied\?)/);
    expect((await external.request.get(patch.address)).status()).toBe(404);
    expect(
      (
        await instance.platform.query("SELECT id FROM users WHERE clerk_user_id=$1", [
          recipient.sub
        ])
      ).rows
    ).toEqual([]);
  } finally {
    await external.close();
  }
});
