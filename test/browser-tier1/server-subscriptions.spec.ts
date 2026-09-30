import { build } from "esbuild";
import { readFile } from "node:fs/promises";
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
    "rows.add": { kind: "mutation", args: { label: { kind: "text" } }, result: { kind: "json" } },
    "files.select": {
      kind: "query",
      args: { name: { kind: "text" } },
      result: { kind: "fileHandle" }
    },
    "files.put": {
      kind: "action",
      args: { name: { kind: "text" }, content: { kind: "text" } },
      result: { kind: "boolean" }
    }
  };
  const server = await build({
    stdin: {
      contents: `import { query, mutation, action, createGuest, t } from "patchy/server";
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
const select = query({ args: { name: t.text() }, result: t.fileHandle(), handler: async (ctx, args) => {
  const metadata = await ctx.files.assets.stat(args.name);
  if (!metadata) throw new Error("File missing");
  return metadata.handle;
} });
const put = action({ args: { name: t.text(), content: t.text() }, result: t.boolean(), handler: async (ctx, args) => {
  await ctx.files.assets.put(args.name, new TextEncoder().encode(args.content), { contentType: "image/svg+xml" });
  return true;
} });
export default createGuest({ rows: { list, size, add, ${removed ? "" : "obsolete,"} ${shared ? "shared," : ""} }, files: { select, put } });`,
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
import { render, useFileUrl, useQuery, useState } from "patchy/preact";
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
const filesRoot = document.createElement("div");
document.body.append(filesRoot);
function Image({ handle, index }) {
  const { url, error } = useFileUrl(handle);
  return <section data-file={index}>{url && <img src={url} alt={"Selected file " + index}/>}
    {error && <p role="alert">{error.code}</p>}</section>;
}
Object.assign(window, {
  sizedQuery: client.server.rows.size,
  fileProbe: {
    client,
    show(handle, count = 1) {
      render(<>{Array.from({length: count}, (_, index) => <Image key={index} index={index} handle={handle}/>)}</>, filesRoot);
    },
    clear() { render(null, filesRoot); }
  }
});`,
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

interface FileProbeWindow extends Window {
  fileProbe: {
    client: {
      server: {
        files: {
          select(args: { name: string }): Promise<string>;
          put(args: { name: string; content: string }): Promise<boolean>;
        };
      };
      files: {
        url(handle: string): Promise<string>;
        download(handle: string, filename?: string): Promise<null>;
      };
      close(): void;
    };
    show(handle: string, count?: number): void;
    clear(): void;
  };
}

test("authorised handles display blob images, reauthorise and queue trusted shell downloads", async ({
  page,
  browser,
  instance
}) => {
  const built = await artifacts(false);
  const patch = await instance.publish(
    "company",
    built.html,
    undefined,
    {
      tier: 2,
      files: manifest.files,
      handlers: built.handlers
    },
    { server: built.server }
  );
  const frame = await open(page, patch);
  const filename = "résumé & report.svg";
  const name = `logos/${filename}`;
  const content =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path fill="red" d="M0 0h1v1H0z"/></svg>';
  const handle = await frame.evaluate(
    async ({ name, content }) => {
      const { client, show } = (window as unknown as FileProbeWindow).fileProbe;
      await client.server.files.put({ name, content });
      const handle = await client.server.files.select({ name });
      show(handle, 2);
      return handle;
    },
    { name, content }
  );
  expect(handle).toHaveLength(57);
  await expect(frame.getByRole("img")).toHaveCount(2);
  for (const image of await frame.getByRole("img").all())
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(1);
  const firstUrl = await frame.getByRole("img").first().getAttribute("src");
  expect(firstUrl).toMatch(/^blob:/);
  const count = instance.runtimeRequests.filter((request) =>
    request.path.includes("/file-handles/")
  ).length;
  const urls = await frame.evaluate(async (handle) => {
    const { client } = (window as unknown as FileProbeWindow).fileProbe;
    return Promise.all([client.files.url(handle), client.files.url(handle)]);
  }, handle);
  expect(new Set(urls).size).toBe(2);
  expect(
    instance.runtimeRequests.filter((request) => request.path.includes("/file-handles/")).length
  ).toBe(count + 2);
  await frame.evaluate(() => (window as unknown as FileProbeWindow).fileProbe.clear());
  await expect(frame.getByRole("img")).toHaveCount(0);
  const loads = (url: string) =>
    frame.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
        return true;
      } catch {
        return false;
      }
    }, url);
  await expect.poll(() => loads(firstUrl!)).toBe(false);
  expect(await loads(urls[0]!)).toBe(true);

  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const cards = page.locator(".shell-corner");
  for (const filename of ["", "../report.svg", "folder//report.svg", "x".repeat(513)]) {
    expect(
      await frame.evaluate(
        async ({ handle, filename }) => {
          try {
            await (window as unknown as FileProbeWindow).fileProbe.client.files.download(
              handle,
              filename
            );
            return "unexpected_success";
          } catch (error) {
            return error instanceof Error && "code" in error ? error.code : "unexpected_error";
          }
        },
        { handle, filename }
      )
    ).toBe("invalid_request");
  }
  await expect(cards).toBeHidden();
  await frame.evaluate(
    (handle) => (window as unknown as FileProbeWindow).fileProbe.client.files.download(handle),
    handle
  );
  await expect(cards.getByText(filename, { exact: true })).toBeVisible();
  await expect(
    cards.getByText(`${Buffer.byteLength(content)} bytes`, { exact: true })
  ).toBeVisible();
  const defaultDownloadEvent = page.waitForEvent("download");
  await cards.getByRole("button", { name: "Download", exact: true }).click();
  const defaultDownload = await defaultDownloadEvent;
  expect(defaultDownload.suggestedFilename()).toBe(filename);
  expect(await readFile((await defaultDownload.path())!, "utf8")).toBe(content);
  await expect(cards).toBeHidden();
  await frame.evaluate(async (handle) => {
    const { client } = (window as unknown as FileProbeWindow).fileProbe;
    for (let index = 0; index < 5; index++)
      await client.files.download(handle, `Report ${index}.svg`);
  }, handle);
  await expect(cards.locator(".note:visible")).toHaveCount(3);
  await expect(cards.getByText("2 more files", { exact: true })).toBeVisible();
  await cards
    .getByRole("button", { name: "Download", exact: true })
    .first()
    .evaluate((button: HTMLButtonElement) => button.click());
  expect(downloads).toEqual([filename]);
  await expect(cards.locator(".note:visible")).toHaveCount(3);
  const downloadEvent = page.waitForEvent("download");
  await cards.getByRole("button", { name: "Download", exact: true }).first().click();
  const downloaded = await downloadEvent;
  expect(downloaded.suggestedFilename()).toBe("Report 4.svg");
  expect(await readFile((await downloaded.path())!, "utf8")).toBe(content);
  await expect(page.locator("#patch")).toBeFocused();
  await cards.getByRole("button", { name: "Not now", exact: true }).first().click();
  await expect(cards.getByText("Report 3.svg", { exact: true })).toHaveCount(0);
  await expect(page.locator("#patch")).toBeFocused();
  await page.setViewportSize({ width: 400, height: 800 });
  const bounds = await cards.boundingBox();
  expect(bounds?.x).toBe(0);
  expect(bounds?.width).toBe(400);
  // A genuine keyboard activation is trusted just like a pointer click.
  await cards.getByRole("button", { name: "Download", exact: true }).first().focus();
  const keyboardDownload = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await keyboardDownload).suggestedFilename()).toBe("Report 2.svg");

  await frame.evaluate(
    async ({ name, content }) => {
      const { client } = (window as unknown as FileProbeWindow).fileProbe;
      await client.server.files.put({ name, content });
    },
    { name, content: content.replace("red", "blue") }
  );
  const replacement = await frame.evaluate(async (name) => {
    const { client, show } = (window as unknown as FileProbeWindow).fileProbe;
    const handle = await client.server.files.select({ name });
    show(handle);
    return handle;
  }, name);
  expect(replacement).not.toBe(handle);
  await expect(frame.getByRole("img")).toHaveCount(1);
  await frame.evaluate(
    (handle) => (window as unknown as FileProbeWindow).fileProbe.show(handle),
    handle
  );
  await expect(frame.getByRole("alert")).toHaveText("not_found");
  await expect(frame.getByRole("img")).toHaveCount(0);
  expect(
    await frame.evaluate(async (handle) => {
      try {
        await (window as unknown as FileProbeWindow).fileProbe.client.files.url(handle);
        return "unexpected_success";
      } catch (error) {
        return error instanceof Error && "code" in error ? error.code : "unexpected_error";
      }
    }, handle)
  ).toBe("not_found");

  const colleague = await browser.newContext();
  try {
    await prepare(colleague, instance);
    await instance.session(colleague, "colleague");
    const other = await open(await colleague.newPage(), patch);
    expect(
      await other.evaluate(async (handle) => {
        try {
          await (window as unknown as FileProbeWindow).fileProbe.client.files.url(handle);
          return "unexpected_success";
        } catch (error) {
          return error instanceof Error && "code" in error ? error.code : "unexpected_error";
        }
      }, replacement)
    ).toBe("access_denied");
  } finally {
    await colleague.close();
  }
  await frame.evaluate(() => (window as unknown as FileProbeWindow).fileProbe.client.close());
  expect(await loads(urls[0]!)).toBe(false);
  expect(await loads(urls[1]!)).toBe(false);
  await page.reload();
  await expect(page.locator(".shell-corner")).toBeHidden();
});
