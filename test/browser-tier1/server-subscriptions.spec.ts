import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import type { Manifest } from "../../packages/api/src/index.js";
import type { QueryCallable } from "../../packages/patchy/src/queryRegistry.js";
import { test, expect, prepare } from "./fixtures.js";
import { manifest, type Instance, type Published } from "./instance.js";

// These tests publish real server artifacts and run them on the supervised workerd executor.
test.skip(({ browserName }) => browserName !== "chromium", "Tier 2 targets Chromium desktop.");
const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
const query = {
  kind: "query",
  args: {},
  result: { kind: "array", element: { kind: "text" } }
} as const;

async function artifacts(shared: boolean, removed = false) {
  const handlers: NonNullable<Manifest["handlers"]> = {
    "rows.list": query,
    "rows.size": { kind: "query", args: { payload: { kind: "text" } }, result: { kind: "number" } },
    ...(!removed ? { "rows.obsolete": query } : {}),
    ...(shared ? { "rows.shared": query } : {}),
    "rows.add": { kind: "mutation", args: { label: { kind: "text" } }, result: { kind: "json" } }
  };
  const server = await build({
    stdin: {
      contents: `import { query, mutation, createGuest, t } from "patchy/server";
const list = query({ args: {}, result: t.array(t.text()), handler: async ctx =>
  (await ctx.tables.rows.list({ order: "asc" })).rows.map(row => row.label) });
const shared = query({ args: {}, result: t.array(t.text()), handler: async ctx =>
  (await ctx.shared.source.list({ order: "asc" })).rows.map(row => row.label) });
const obsolete = query({ args: {}, result: t.array(t.text()), handler: async ctx => {
  const labels = (await ctx.tables.rows.list({ order: "asc" })).rows.map(row => row.label);
  if (labels.includes("Break only obsolete")) throw new Error("Invalid query result");
  return labels;
} });
const size = query({ args: { payload: t.text() }, result: t.number(), handler: (_ctx, args) => args.payload.length });
const add = mutation({ args: { label: t.text() }, result: t.json(), handler: (ctx, args) =>
  ctx.tables.rows.insert(args) });
export default createGuest({ rows: { list, size, add, ${removed ? "" : "obsolete,"} ${shared ? "shared," : ""} } });`,
      resolveDir: packageRoot,
      sourcefile: "subscription-server.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    conditions: ["development"]
  });
  const page = await build({
    stdin: {
      contents: `import { createServerClient } from "patchy/client";
import { render, useQuery, useState } from "patchy/preact";
const client = createServerClient();
function Result({ name, handler }) {
  const snapshot = useQuery(handler, {});
  return <section id={name}><output class="status">{snapshot.status}</output>
    <output class="data">{JSON.stringify(snapshot.data ?? [])}</output>
    {snapshot.error && <p role="alert">{snapshot.error.code}</p>}</section>;
}
function App() {
  const [label, setLabel] = useState("");
  const [saved, setSaved] = useState("");
  return <main><h1>Server subscriptions</h1>
    <label>Label<input value={label} onChange={event => setLabel(event.currentTarget.value)}/></label>
    <button onClick={async () => { try { await client.server.rows.add({label}); setSaved(label); } catch(error) { setSaved(error.code); } }}>Save</button>
    <output id="saved">{saved}</output>
    <Result name="owned" handler={client.server.rows.list}/>
    <Result name="obsolete" handler={client.server.rows.obsolete}/>
    ${shared ? '<Result name="shared" handler={client.server.rows.shared}/>' : ""}
  </main>;
}
render(<App/>, document.getElementById("app"));
Object.assign(window, { sizedQuery: client.server.rows.size });`,
      resolveDir: packageRoot,
      sourcefile: "subscription-page.tsx",
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
  return {
    handlers,
    server: server.outputFiles[0]!.text,
    html: `<!doctype html><html><head><title>Server subscriptions</title></head><body><div id="app"></div><script>${page.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`
  };
}

async function publish(instance: Instance, source?: Published, patchId?: string, removed = false) {
  const built = await artifacts(source !== undefined, removed);
  return instance.publish(
    "company",
    built.html,
    patchId,
    {
      tier: 2,
      files: {},
      handlers: built.handlers,
      ...(source
        ? {
            uses: {
              source: {
                kind: "sharedTable",
                patchId: source.patchId,
                table: "rows",
                id: `${source.patchId}/rows`,
                revision: 1
              }
            }
          }
        : {})
    },
    { server: built.server }
  );
}

async function open(page: Page, patch: Published): Promise<Frame> {
  expect((await page.goto(patch.address))?.status()).toBe(200);
  await expect(page.frameLocator("#patch").locator("#owned .status")).toHaveText("ready");
  const frame = page.frames().find((candidate) => candidate.url().includes("/~content/"));
  if (!frame) throw new Error("The published content frame did not load");
  return frame;
}

async function save(frame: Frame, label: string) {
  await frame.getByLabel("Label").fill(label);
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  await expect(frame.locator("#saved")).toHaveText(label);
}

test("two viewers stay in sync and a removed handler ends only its new-version subscription", async ({
  page,
  browser,
  instance
}) => {
  const patch = await publish(instance);
  const writer = await open(page, patch);
  const colleague = await browser.newContext();
  try {
    await prepare(colleague, instance);
    await instance.session(colleague, "colleague");
    const readerPage = await colleague.newPage();
    const reader = await open(readerPage, patch);
    await save(writer, "Colleague sees the commit");
    await expect(reader.locator("#owned .data")).toHaveText('["Colleague sees the commit"]');
    await expect(reader.locator("#obsolete .data")).toHaveText('["Colleague sees the commit"]');

    instance.pauseStreams(true);
    await save(writer, "Saved during disconnect");
    instance.pauseStreams(false);
    await expect(reader.locator("#owned .data")).toHaveText(
      '["Colleague sees the commit","Saved during disconnect"]'
    );

    const next = await publish(instance, undefined, patch.patchId, true);
    // A publish never changes the handler code of an already loaded document.
    await expect(reader.locator("#obsolete .status")).toHaveText("ready");
    const fresh = await open(readerPage, next);
    await expect(fresh.locator("#obsolete .status")).toHaveText("error");
    await expect(fresh.locator("#owned .status")).toHaveText("ready");
    await save(writer, "Other subscriptions still run");
    await expect(fresh.locator("#owned .data")).toContainText("Other subscriptions still run");
    await expect(writer.locator("#obsolete .data")).toContainText("Other subscriptions still run");
    await save(writer, "Break only obsolete");
    await expect(writer.locator("#obsolete [role=alert]")).toHaveText("handler_failed");
    await expect(writer.locator("#obsolete .data")).toHaveText(
      '["Colleague sees the commit","Saved during disconnect","Other subscriptions still run"]'
    );
    await expect(fresh.locator("#owned .data")).toContainText("Break only obsolete");

    await readerPage.clock.install();
    await readerPage.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await readerPage.clock.fastForward(30_000);
    await expect.poll(() => instance.streamConnections.size).toBe(1);
    await save(writer, "Saved while hidden");
    await expect(fresh.locator("#owned .data")).not.toContainText("Saved while hidden");
    await readerPage.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(fresh.locator("#owned .data")).toContainText("Saved while hidden");
  } finally {
    instance.pauseStreams(false);
    await colleague.close();
  }
});

test("unsharing preserves the last value and reshare wakes both existing and initially refused queries", async ({
  page,
  browser,
  instance
}) => {
  const sourceArtifacts = await artifacts(false);
  const sourceTables = (shared: boolean) => ({ rows: { ...manifest.tables.rows, shared } });
  const source = await instance.publish(
    "company",
    sourceArtifacts.html,
    undefined,
    {
      tier: 2,
      files: {},
      handlers: sourceArtifacts.handlers,
      tables: sourceTables(true)
    },
    { server: sourceArtifacts.server }
  );
  const sourcePage = await page.context().newPage();
  const initiallyRefused = await browser.newContext();
  try {
    const writer = await open(sourcePage, source);
    await save(writer, "Shared before refusal");
    const consumer = await publish(instance, source);
    const reader = await open(page, consumer);
    await expect(reader.locator("#shared .data")).toHaveText('["Shared before refusal"]');
    await instance.publish(
      "company",
      sourceArtifacts.html,
      source.patchId,
      {
        tier: 2,
        files: {},
        handlers: sourceArtifacts.handlers,
        tables: sourceTables(false)
      },
      { server: sourceArtifacts.server, force: true }
    );
    await expect(reader.locator("#shared [role=alert]")).toHaveText("access_denied");
    await expect(reader.locator("#shared .data")).toHaveText('["Shared before refusal"]');
    await expect(reader.locator("#owned .status")).toHaveText("ready");

    await prepare(initiallyRefused, instance);
    await instance.session(initiallyRefused, "colleague");
    const firstRunPage = await initiallyRefused.newPage();
    const firstRun = await open(firstRunPage, consumer);
    await expect(firstRun.locator("#shared [role=alert]")).toHaveText("access_denied");
    await expect(firstRun.locator("#shared .data")).toHaveText("[]");

    await instance.publish(
      "company",
      sourceArtifacts.html,
      source.patchId,
      {
        tier: 2,
        files: {},
        handlers: sourceArtifacts.handlers,
        tables: sourceTables(true)
      },
      { server: sourceArtifacts.server }
    );
    for (const frame of [reader, firstRun]) {
      await expect(frame.locator("#shared .status")).toHaveText("ready");
      await expect(frame.locator("#shared .data")).toHaveText('["Shared before refusal"]');
      await expect(frame.locator("#shared [role=alert]")).toHaveCount(0);
    }
  } finally {
    await initiallyRefused.close();
    await sourcePage.close();
  }
});

test("server subscriptions use the handler argument budget rather than the direct-operation budget", async ({
  page,
  instance
}) => {
  const frame = await open(page, await publish(instance));
  const subscribe = (bytes: number) =>
    frame.evaluate((size) => {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      // The bundled fixture installs this callable on its sandboxed window.
      const host = window as unknown as {
        sizedQuery: QueryCallable<{ payload: string }, number>;
      };
      const stop = host.sizedQuery.subscribe({ payload: "x".repeat(size) }, (snapshot) => {
        if (snapshot.loading) return;
        stop();
        resolve({
          status: snapshot.status,
          data: snapshot.data ?? null,
          code: snapshot.error && "code" in snapshot.error ? snapshot.error.code : null
        });
      });
      return promise;
    }, bytes);
  expect(await subscribe(512 * 1024)).toEqual({ status: "ready", data: 512 * 1024, code: null });
  expect(await subscribe(1024 * 1024)).toEqual({ status: "error", data: null, code: "too_large" });
});
