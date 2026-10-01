import assert from "node:assert/strict";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";

// Invoked by packed-cli-e2e.mjs --tier2, which owns release packing, the offline
// host, Postgres, Chromium and signal-safe cleanup. No workspace SDK imports.
export async function runTier2Flow({
  cliPath,
  cliEnv,
  publicBaseUrl,
  tempRoot,
  browser,
  authTesting,
  run,
  runCli,
  installedCliBinPath,
  startDev,
  stopDev
}) {
  const options = {
    env: {
      ...cliEnv,
      pnpm_config_store_dir: path.join(tempRoot, "tier2 pnpm store"),
      pnpm_config_cache_dir: path.join(tempRoot, "tier2 pnpm metadata")
    },
    timeoutMs: 120_000
  };
  const init = async (name, tier) => {
    const dir = path.join(tempRoot, name);
    const result = JSON.parse(
      (
        await runCli(
          cliPath,
          ["init", dir, "--tier", String(tier), "--purpose", "Packed tier 2 acceptance", "--json"],
          { ...options, cwd: tempRoot }
        )
      ).stdout
    );
    assert.equal(result.tier, tier);
    assert.equal(result.installed, true);
    const cli = installedCliBinPath(dir);
    return {
      dir,
      cli,
      options: { ...options, cwd: dir },
      command: async (...args) =>
        JSON.parse((await runCli(cli, [...args, "--json"], { ...options, cwd: dir })).stdout)
    };
  };
  const write = (repo, file, source) => writeFile(path.join(repo.dir, file), source);
  const context = async (claims) => {
    const value = await browser.newContext();
    value.setDefaultTimeout(20_000);
    value.setDefaultNavigationTimeout(20_000);
    await value.route("**/*", (route) => {
      const hostname = new URL(route.request().url()).hostname;
      return hostname === "127.0.0.1" || hostname === "localhost"
        ? route.continue()
        : route.abort("blockedbyclient");
    });
    if (claims) {
      const jwt = authTesting.signSession({
        azp: publicBaseUrl,
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...claims
      });
      await value.addCookies(
        authTesting
          .signedInCookies(jwt)
          .split("; ")
          .map((cookie) => {
            const at = cookie.indexOf("=");
            return {
              name: cookie.slice(0, at),
              value: cookie.slice(at + 1),
              url: publicBaseUrl,
              sameSite: "Lax"
            };
          })
      );
    }
    return value;
  };
  const open = async (page, url) => {
    assert.equal((await page.goto(url)).status(), 200);
    await expect(page.frameLocator("#patch").locator("#status")).toHaveText("ready");
    const frame = page.frames().find((frame) => frame.url().includes("/~content/"));
    assert.ok(frame, "the real shell must load its sandboxed content frame");
    return frame;
  };
  const download = async (page, filename, contents) => {
    const card = page.locator(".shell-corner");
    await expect(card.getByText(filename, { exact: true })).toBeVisible();
    const received = page.waitForEvent("download");
    await card.getByRole("button", { name: "Download", exact: true }).click();
    const file = await received;
    assert.equal(file.suggestedFilename(), filename);
    const saved = path.join(tempRoot, `downloaded-${filename}`);
    await file.saveAs(saved);
    assert.equal(await readFile(saved, "utf8"), contents);
  };

  // The tier 1 init warms the store first: pnpm 11 then locks the tier 2 repo's patchy tarball
  // without an integrity, which its second install (the workerd pin) must survive (#459).
  console.log("[packed-tier2-e2e] init --tier 2 on a warm store and typecheck its starter");
  const source = await init("tier2-shared-source", 1);
  const repo = await init("tier2-acceptance", 2);
  await run("pnpm", ["typecheck"], repo.options);

  console.log("[packed-tier2-e2e] publish a shared table and store through the packed CLI");
  await write(
    source,
    "patchy.config.ts",
    `import { defineConfig, table, files, t } from "patchy/config";
export default defineConfig({ name: "tier2-shared-source", tier: 1,
  tables: { notes: table("Shared acceptance notes", { title: t.text() }, { shared: true }) },
  files: { assets: files("Shared acceptance files", { shared: true }) }, uses: {} });
`
  );
  await write(
    source,
    "src/App.tsx",
    `import { patchy } from "../patchy/_generated/client.js";
Object.assign(window, { probe: { patchy } });
export function App() { return <output id="status">ready</output>; }
`
  );
  await source.command("refresh");
  const sourcePublished = await source.command("publish");
  const ownerContext = await context({});
  const colleagueContext = await context({
    sub: "user_packed_other",
    sid: "sess_packed_other",
    email: "packed-other@patchy.local",
    name: "Other Publisher"
  });
  const owner = await ownerContext.newPage();
  const colleague = await colleagueContext.newPage();
  const sourceFrame = await open(owner, sourcePublished.address);
  await sourceFrame.evaluate(async () => {
    await window.probe.patchy.tables.notes.insert({ title: "Hosted shared note" });
    await window.probe.patchy.files.assets.put(
      "reference.txt",
      new TextEncoder().encode("Hosted shared file"),
      { contentType: "text/plain" }
    );
  });

  await write(
    repo,
    "patchy.config.ts",
    `import { defineConfig, table, files, t } from "patchy/config";
export default defineConfig({ name: "tier2-acceptance", tier: 2,
  tables: { notes: table("Assigned acceptance notes", { title: t.text(), owner: t.member() }) },
  files: { assets: files("Uploaded acceptance files") }, uses: { members: { kind: "members" } } });
`
  );
  await repo.command(
    "add",
    "shared-table",
    `${sourcePublished.patchId}/notes`,
    "--as",
    "reference"
  );
  await repo.command("add", "shared-store", `${sourcePublished.patchId}/assets`, "--as", "library");
  await write(repo, "server/notes.ts", handlers);
  await write(repo, "src/App.tsx", app);
  await repo.command("refresh");
  // Generated fixture headers name the local table. Invented rows never come from hosted data.
  const fixture = await readFile(path.join(repo.dir, "fixtures/shared-reference.sql"), "utf8");
  const localTable = fixture.match(/^-- Local table: (.+)$/m)?.[1];
  assert.ok(localTable, "generation must name the fixture's local table");
  await write(
    repo,
    "fixtures/shared-reference.sql",
    `${fixture}\nINSERT INTO ${localTable} (id, title) VALUES ('local-reference', 'Local shared note');\n`
  );
  await write(repo, "fixtures/shared-library/reference.txt", "Local shared file");
  await run("pnpm", ["typecheck"], repo.options);

  console.log("[packed-tier2-e2e] execute all kinds and subscriptions through both dev mounts");
  const dev = await startDev(repo.cli, repo.options);
  assert.equal(dev.healthy, true);
  assert.notEqual(new URL(dev.url).origin, new URL(dev.colleagueUrl).origin);
  const localOwner = await context();
  const localColleague = await context();
  const localPage = await localOwner.newPage();
  const localReaderPage = await localColleague.newPage();
  const localWriter = await open(localPage, dev.url);
  const localReader = await open(localReaderPage, dev.colleagueUrl);
  const localIdentities = await Promise.all(
    [localWriter, localReader].map((frame) =>
      frame.evaluate(() => window.probe.patchy.server.notes.directory({}))
    )
  );
  assert.notEqual(localIdentities[0].viewer, localIdentities[1].viewer);
  assert.deepEqual(
    localIdentities[0].members.map((member) => member.id).sort(),
    localIdentities.map((identity) => identity.viewer).sort()
  );
  await localWriter.evaluate(() =>
    window.probe.patchy.server.notes.create({ title: "Local write" })
  );
  await expect(localReader.locator("#titles")).toHaveText('["Local write"]');
  assert.deepEqual(await localReader.evaluate(() => window.probe.patchy.server.notes.shared({})), [
    "Local shared note"
  ]);
  assert.equal(
    await localReader.evaluate(() => window.probe.patchy.server.notes.readShared({})),
    "Local shared file"
  );
  await localWriter.evaluate(() => window.probe.upload("Local upload"));
  await download(localPage, "upload.txt", "Local upload");
  await localOwner.close();
  await localColleague.close();
  await stopDev();

  console.log("[packed-tier2-e2e] publish both artifacts and sync independent signed-in viewers");
  const published = await repo.command("publish");
  assert.equal(published.tier, 2);
  assert.deepEqual(
    published.handlers
      .map((handler) => handler.kind)
      .filter((kind, index, kinds) => kinds.indexOf(kind) === index)
      .sort(),
    ["action", "mutation", "query"]
  );
  for (const artifact of [published.artifacts.html, published.artifacts.server]) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(artifact.bytes > 0);
  }
  const writer = await open(owner, published.address);
  const reader = await open(colleague, published.address);
  await expect(writer.locator("#titles")).toHaveText("[]");
  const identity = await writer.evaluate(() => window.probe.patchy.server.notes.directory({}));
  const readerIdentity = await reader.evaluate(() =>
    window.probe.patchy.server.notes.directory({})
  );
  assert.notEqual(identity.viewer, readerIdentity.viewer);
  assert.ok(identity.members.some((member) => member.id === readerIdentity.viewer));
  const created = await writer.evaluate(() =>
    window.probe.patchy.server.notes.create({ title: "Hosted write" })
  );
  assert.equal(created.owner, identity.viewer);
  await expect(reader.locator("#titles")).toHaveText('["Hosted write"]');
  assert.deepEqual(await reader.evaluate(() => window.probe.patchy.server.notes.shared({})), [
    "Hosted shared note"
  ]);
  assert.equal(
    await reader.evaluate(() => window.probe.patchy.server.notes.readShared({})),
    "Hosted shared file"
  );
  await reader.evaluate(async () => {
    const handle = await window.probe.patchy.server.notes.sharedHandle({});
    await window.probe.patchy.files.download(handle, "reference.txt");
  });
  await download(colleague, "reference.txt", "Hosted shared file");

  console.log("[packed-tier2-e2e] drop a committed reply, then retry the same mutation");
  let dropped;
  const requests = [];
  const loseReply = async (route) => {
    const body = route.request().postDataJSON();
    if (
      body.op !== "server.call" ||
      body.args.handler !== "notes.create" ||
      body.args.args.title !== "Lost reply"
    )
      return route.fallback();
    requests.push(body.args);
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    if (!dropped) {
      dropped = result.value;
      await route.abort("failed");
    } else await route.fulfill({ response });
  };
  await ownerContext.route("**/api/runtime/call", loseReply);
  assert.equal(
    await writer.evaluate(async () => {
      try {
        await window.probe.patchy.server.notes.create({ title: "Lost reply" });
        return "unexpected_success";
      } catch (error) {
        if (!window.probe.isPatchyError(error, "unknown_outcome") || !error.retry) throw error;
        window.probe.retry = error.retry;
        return error.code;
      }
    }),
    "unknown_outcome"
  );
  await expect(reader.locator("#titles")).toHaveText('["Hosted write","Lost reply"]');
  const retried = await writer.evaluate(() => window.probe.retry());
  assert.deepEqual(retried, dropped);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].mutationKey, requests[1].mutationKey);
  assert.equal(typeof requests[0].mutationKey, "string");
  assert.deepEqual(await writer.evaluate(() => window.probe.patchy.server.notes.list({})), [
    created,
    retried
  ]);
  await ownerContext.unroute("**/api/runtime/call", loseReply);

  console.log("[packed-tier2-e2e] adopt staged bytes and import/export CSV through the SDK");
  await writer.evaluate(() => window.probe.upload("Hosted upload"));
  await download(owner, "upload.txt", "Hosted upload");
  await writer.evaluate(() => window.probe.importCsv('title\r\n"CSV, note"\r\n'));
  await expect(reader.locator("#titles")).toHaveText('["Hosted write","Lost reply","CSV, note"]');
  // Generated downloads resolve only after the viewer approves the shell card.
  await Promise.all([
    reader.evaluate(() => window.probe.exportCsv()),
    download(colleague, "notes.csv", 'title\r\nHosted write\r\nLost reply\r\n"CSV, note"')
  ]);

  console.log("[packed-tier2-e2e] change tier 2 to 1 and back through refresh and publish");
  const config = await readFile(path.join(repo.dir, "patchy.config.ts"), "utf8");
  await rm(path.join(repo.dir, "server"), { recursive: true });
  await write(repo, "patchy.config.ts", config.replace("tier: 2", "tier: 1"));
  await write(repo, "src/App.tsx", tier1App);
  await repo.command("refresh");
  await run("pnpm", ["typecheck"], repo.options);
  const lower = await repo.command("publish");
  assert.equal(lower.tier, 1);
  const lowerFrame = await open(owner, lower.address);
  await expect(lowerFrame.locator("#titles")).toHaveText(
    '["Hosted write","Lost reply","CSV, note"]'
  );
  assert.equal(
    await lowerFrame.evaluate(async () => {
      try {
        await window.probe.patchy.tables.notes.insert({
          title: "Invalid member write",
          owner: "usr_packed_non_member"
        });
        return "unexpected_success";
      } catch (error) {
        return error.code;
      }
    }),
    "invalid_row"
  );
  await lowerFrame.evaluate(async () => {
    const me = await window.probe.patchy.me();
    await window.probe.patchy.tables.notes.insert({ title: "Tier one write", owner: me.user.id });
  });
  await expect(reader.locator("#titles")).toHaveText(
    '["Hosted write","Lost reply","CSV, note","Tier one write"]'
  );
  await write(repo, "patchy.config.ts", config);
  await mkdir(path.join(repo.dir, "server"));
  await write(repo, "server/notes.ts", handlers);
  await write(repo, "src/App.tsx", app);
  await repo.command("refresh");
  await run("pnpm", ["typecheck"], repo.options);
  const higher = await repo.command("publish");
  assert.equal(higher.tier, 2);
  await expect(owner.locator(".shell-bottom")).toContainText("Reload to keep saving");
  assert.equal(
    await lowerFrame.evaluate(async () => {
      try {
        await window.probe.patchy.tables.notes.list();
        return "unexpected_success";
      } catch (error) {
        return error.code;
      }
    }),
    "server_required"
  );
  const restored = await open(owner, higher.address);
  await expect(restored.locator("#titles")).toHaveText(
    '["Hosted write","Lost reply","CSV, note","Tier one write"]'
  );
  await restored.evaluate(() =>
    window.probe.patchy.server.notes.create({ title: "Back on tier two" })
  );
  await expect(reader.locator("#titles")).toHaveText(
    '["Hosted write","Lost reply","CSV, note","Tier one write","Back on tier two"]'
  );
  await ownerContext.close();
  await colleagueContext.close();
  console.log(
    "[packed-tier2-e2e] PASS: packed init, both dev mounts, publish, two-viewer sync, keyed retry, sharing, files, members, CSV and tier changes"
  );
}

const handlers = `import { query, mutation, action, t } from "../patchy/_generated/server.js";
export const list = query({ args: {}, result: t.array(t.row("notes")), handler: async ctx => (await ctx.tables.notes.list({ order: "asc" })).rows });
export const create = mutation({ args: { title: t.text() }, result: t.row("notes"), handler: (ctx, args) => ctx.tables.notes.insert({ title: args.title, owner: ctx.viewer.user.id }) });
export const directory = query({ args: {}, result: t.object({ viewer: t.text(), members: t.array(t.object({ id: t.text() })) }), handler: async ctx => ({ viewer: ctx.viewer.user.id, members: (await ctx.members.list()).rows.map(member => ({ id: member.id })) }) });
export const shared = query({ args: {}, result: t.array(t.text()), handler: async ctx => (await ctx.shared.reference.list()).rows.map(row => row.title) });
export const readShared = action({ args: {}, result: t.text(), handler: async ctx => new TextDecoder().decode(await ctx.shared.library.get("reference.txt")) });
export const sharedHandle = query({ args: {}, result: t.fileHandle(), handler: async ctx => { const file = await ctx.shared.library.stat("reference.txt"); if (!file) throw new Error("Missing reference"); return file.handle; } });
export const adopt = action({ args: { upload: t.upload() }, result: t.boolean(), handler: async (ctx, args) => { await ctx.files.assets.put("upload.txt", args.upload); return true; } });
export const handle = query({ args: {}, result: t.fileHandle(), handler: async ctx => { const file = await ctx.files.assets.stat("upload.txt"); if (!file) throw new Error("Missing upload"); return file.handle; } });
`;

const app = `import { useQuery } from "patchy/preact";
import { parse, stringify } from "patchy/csv";
import { patchy, isPatchyError } from "../patchy/_generated/client.js";
Object.assign(window, { probe: { patchy, isPatchyError,
  async upload(text: string) {
    const upload = await patchy.files.stage(new TextEncoder().encode(text), { contentType: "text/plain" });
    await patchy.server.notes.adopt({ upload });
    await patchy.files.download(await patchy.server.notes.handle({}), "upload.txt");
  },
  async importCsv(text: string) {
    const [header, ...rows] = parse(text);
    if (header?.length !== 1 || header[0] !== "title") throw new Error("Expected title column");
    for (const row of rows) { if (row.length !== 1) throw new Error("Expected one field"); await patchy.server.notes.create({ title: row[0]! }); }
  },
  async exportCsv() {
    const rows = await patchy.server.notes.list({});
    await patchy.download("notes.csv", new Blob([stringify([["title"], ...rows.map(row => [row.title])])], { type: "text/csv" }));
  }
} });
export function App() {
  const snapshot = useQuery(patchy.server.notes.list, {});
  return <main><h1>Packed tier 2 acceptance</h1><output id="status">{snapshot.status}</output><output id="titles">{JSON.stringify(snapshot.data?.map(row => row.title) ?? [])}</output>{snapshot.error && <p role="alert">{snapshot.error.message}</p>}</main>;
}
`;

const tier1App = `import { useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
Object.assign(window, { probe: { patchy } });
export function App() {
  const snapshot = useQuery(patchy.tables.notes.list, { order: "asc" });
  return <main><output id="status">{snapshot.status}</output><output id="titles">{JSON.stringify(snapshot.data?.rows.map(row => row.title) ?? [])}</output></main>;
}
`;
