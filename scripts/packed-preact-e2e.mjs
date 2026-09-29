import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, ".local"), { recursive: true });
const work = await mkdtemp(path.join(root, ".local/packed-preact-"));
const consumer = path.join(work, "consumer");
const run = (command, args, cwd = consumer, env = {}) =>
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "true", ...env }
  });
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const metadata = JSON.parse(
  await readFile(path.join(root, "packages/patchy/artifacts/release.json"), "utf8")
);
const archiveName = `patchy-${metadata.release}-${metadata.digest}.tgz`;
const bytes = await readFile(path.join(root, "packages/patchy/artifacts", archiveName));
assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, metadata.integrity);
assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.digest);
const archives = new Map([[`/sdk/${archiveName}`, bytes]]);
const server = createServer((request, response) => {
  const archive = archives.get(request.url);
  if (!archive) return response.writeHead(404).end();
  response.writeHead(200, { "content-type": "application/octet-stream" });
  response.end(archive);
});
let vite;
let preview;
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await mkdir(consumer);
  const pkg = {
    name: "packed-preact-acceptance",
    private: true,
    type: "module",
    devDependencies: {
      patchy: `${base}/sdk/${archiveName}`,
      ...Object.fromEntries(
        Object.entries(metadata.toolchain).map(([name, entry]) => [name, entry.testedAgainst])
      )
    }
  };
  await writeFile(path.join(consumer, "package.json"), json(pkg));
  await writeFile(path.join(consumer, "pnpm-workspace.yaml"), 'packages:\n  - "."\n');
  // Child installs need the tarball server's event loop; unlike compilation they cannot be synchronous.
  const install = () =>
    new Promise((resolve, reject) => {
      const child = spawn("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], {
        cwd: consumer,
        stdio: "inherit",
        env: { ...process.env, CI: "true" }
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`pnpm install exited ${code}`))
      );
    });
  await install();

  const copies = new Map(
    ["preact", "@preact/signals", "@preact/signals-core"].map((name) => [name, new Set()])
  );
  const visited = new Set();
  async function inventory(directory) {
    const physical = await realpath(directory);
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "package.json") {
        const manifest = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
        copies.get(manifest.name)?.add(physical);
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (entry.name !== ".bin") await inventory(path.join(directory, entry.name));
      }
    }
  }
  await inventory(path.join(consumer, "node_modules"));
  for (const [name, locations] of copies)
    assert.equal(locations.size, 1, `${name}: ${[...locations]}`);
  console.log("[packed-preact] exactly one copy of each UI runtime");

  await writeFile(
    path.join(consumer, "tsconfig.json"),
    json({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        jsxImportSource: "patchy/preact",
        strict: true,
        noEmit: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        types: ["vite/client"]
      },
      include: ["main.tsx"]
    })
  );
  await writeFile(
    path.join(consumer, "vite.config.ts"),
    `import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({ plugins: [viteSingleFile()], oxc: { jsx: { importSource: "patchy/preact" } }, build: { modulePreload: false }, server: { host: "127.0.0.1" } });\n`
  );
  await writeFile(
    path.join(consumer, "index.html"),
    '<!doctype html><html lang="en"><head><title>Packed Preact acceptance</title></head><body><main id="app"></main><script type="module" src="/main.tsx"></script></body></html>'
  );
  await writeFile(
    path.join(consumer, "main.tsx"),
    `import { Component, Fragment, PureComponent, forwardRef, memo, render, signal, useQuery, useState } from "patchy/preact";
import { createServerClient, PatchyError } from "patchy/client";
import type { QueryFrame, Transport } from "patchy/client";
import type { Handler } from "patchy/server";
import { jsxDEV } from "patchy/preact/jsx-dev-runtime";
const count = signal(0);
let revision = 0;
let subscriptions = 0;
const listeners = new Set<(frame: QueryFrame) => void>();
const emit = (frame: QueryFrame) => { for (const listener of listeners) listener(frame); };
// The packaging seam supplies stream frames. Hosted acceptance exercises real workerd and SSE.
const transport: Transport = {
  call: async () => { throw new Error("This fixture renders only from subscriptions"); },
  route: { get: async () => "/", set: async () => null, subscribe: () => () => {} },
  ready: async () => {}, serverTime: () => 0, waitForServerTime: async () => 0,
  handlerKind: () => "query", close: () => listeners.clear(),
  queries: { subscribe(request, listener) {
    if (request.handler !== "server.call" || request.args.handler !== "counter.read")
      throw new Error("Expected a server query subscription");
    subscriptions++;
    listeners.add(listener);
    listener({status: "ready", revision: String(revision), data: count.value});
    return () => { listeners.delete(listener); };
  } }
};
const client = createServerClient<{counter: {read: Handler<"query", Record<string, never>, number>}}>({transport});
class Counter extends PureComponent<{ hook: number; query: number | undefined }> {
  render() { return <output id="class">class {this.props.hook} / {count.value} / {this.props.query}</output>; }
}
const Label = memo(forwardRef<HTMLSpanElement, { hook: number; query: number | undefined }>((props, ref) => <span ref={ref} id="memo">memo {props.hook} / {count.value} / {props.query}</span>));
function LateQuery() {
  const query = useQuery(client.server.counter.read, {});
  return <output id="late-query">{query.status} / {query.data}</output>;
}
function App() {
  const [hook, setHook] = useState(0);
  const [text, setText] = useState("");
  const [late, setLate] = useState(false);
  const query = useQuery(client.server.counter.read, {});
  return <section><h1>Bundled Preact</h1>
    <button onClick={() => { count.value++; setHook(value => value + 1); emit({status:"ready",revision:String(++revision),data:count.value}); }}>Increment</button>
    <p id="hook">hook {hook}</p><p id="signal">signal {count}</p>
    <p id="query">query {query.data} / {query.status}</p>
    <Counter hook={hook} query={query.data}/><Label hook={hook} query={query.data}/>
    <label>Compat input <input value={text} onChange={event => setText(event.currentTarget.value)}/></label><p id="change">{text}</p>
    <button onClick={() => emit({status:"error",error:new PatchyError("access_denied","Source unshared",{}),permanent:false})}>Refuse source</button>
    <button onClick={() => emit({status:"up-to-date",revision:String(revision)})}>Reshare source</button>
    <button onClick={() => emit({status:"error",error:new PatchyError("handler_failed","Handler removed",{}),permanent:true})}>End query</button>
    <button onClick={() => setLate(value => !value)}>Toggle late subscriber</button>
    {late && <LateQuery/>}
  </section>;
}
render(<App/>, document.querySelector("#app")!);
const probe = jsxDEV("span", { children: "JSX development entry" });
render(probe, document.body.appendChild(document.createElement("aside")));
Object.assign(window, { sdkIdentity: { Component, Fragment }, subscriptionCount: () => subscriptions });\n`
  );
  run("pnpm", ["exec", "tsc", "--noEmit"]);
  console.log("[packed-preact] JSX types resolve without a direct Preact dependency");
  const require = createRequire(path.join(consumer, "package.json"));
  // Resolve the freshly installed builder toolchain, not this repository's copy.
  const tools = await import(pathToFileURL(require.resolve("vite")).href);
  vite = await tools.createServer({ root: consumer, server: { port: 0 } });
  await vite.listen();
  const devUrl = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  async function exercise(url, development) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.debugAttachments = [];
      window.__PREACT_DEVTOOLS__ = {
        attachPreact: (version, options, identity) =>
          window.debugAttachments.push({ version, options, identity })
      };
    });
    await page.goto(url);
    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("#hook")).toHaveText("hook 1");
    await expect(page.locator("#signal")).toHaveText("signal 1");
    await expect(page.locator("#query")).toHaveText("query 1 / ready");
    await expect(page.locator("#class")).toHaveText("class 1 / 1 / 1");
    await expect(page.locator("#memo")).toHaveText("memo 1 / 1 / 1");
    await page.getByLabel("Compat input").fill("compat change");
    await expect(page.locator("#change")).toHaveText("compat change");
    await page.getByRole("button", { name: "Refuse source", exact: true }).click();
    await expect(page.locator("#query")).toHaveText("query 1 / error");
    await page.getByRole("button", { name: "Reshare source", exact: true }).click();
    await expect(page.locator("#query")).toHaveText("query 1 / ready");
    await page.getByRole("button", { name: "End query", exact: true }).click();
    await expect(page.locator("#query")).toHaveText("query 1 / error");
    await page.getByRole("button", { name: "Toggle late subscriber" }).click();
    await expect(page.locator("#late-query")).toHaveText("error / 1");
    assert.equal(await page.evaluate(() => window.subscriptionCount()), 1);
    assert.deepEqual(errors, []);
    const debug = await page.evaluate(() => ({
      count: window.debugAttachments.length,
      same: window.debugAttachments.every(
        ({ identity }) =>
          identity.Component === window.sdkIdentity.Component &&
          identity.Fragment === window.sdkIdentity.Fragment
      )
    }));
    assert.equal(debug.count, development ? 1 : 0);
    assert.equal(debug.same, true);
    if (development) {
      const optimized = JSON.parse(
        await readFile(path.join(consumer, "node_modules/.vite/deps/_metadata.json"), "utf8")
      );
      assert.ok(
        optimized.optimized["patchy/preact"],
        "Vite dependency optimization must stay enabled"
      );
    }
    await page.close();
  }
  await exercise(devUrl, true);
  console.log(
    "[packed-preact] optimized dev: signals, hooks, compat, useQuery and SDK debugging share one runtime"
  );
  // Vite's in-process dev server sets NODE_ENV; publish builds in a separate production process.
  run("pnpm", ["exec", "vite", "build"], consumer, { NODE_ENV: "production" });
  assert.deepEqual(await readdir(path.join(consumer, "dist")), ["index.html"]);
  preview = await tools.preview({ root: consumer, preview: { host: "127.0.0.1", port: 0 } });
  await exercise(preview.resolvedUrls.local[0], false);
  console.log(
    "[packed-preact] single-file published artifact runs with no development instrumentation"
  );

  const repack = path.join(work, "repack");
  await mkdir(repack);
  run("tar", ["-xzf", path.join(root, "packages/patchy/artifacts", archiveName), "-C", repack]);
  const readme = path.join(repack, "package/README.md");
  const changedReadme = `${await readFile(readme, "utf8")}\nSame-version content-digest acceptance.\n`;
  await writeFile(readme, changedReadme);
  run(
    process.execPath,
    [
      path.join(root, "node_modules/npm/bin/npm-cli.js"),
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      repack
    ],
    path.join(repack, "package")
  );
  const replacement = await readFile(path.join(repack, `patchy-${metadata.release}.tgz`));
  const digest = createHash("sha256").update(replacement).digest("hex");
  assert.notEqual(digest, metadata.digest);
  const replacementPath = `/sdk/patchy-${metadata.release}-${digest}.tgz`;
  archives.set(replacementPath, replacement);
  pkg.devDependencies.patchy = `${base}${replacementPath}`;
  await writeFile(path.join(consumer, "package.json"), json(pkg));
  await install();
  assert.equal(
    await readFile(path.join(consumer, "node_modules/patchy/README.md"), "utf8"),
    changedReadme
  );
  console.log("[packed-preact] same-version digest URL installs the new bytes");
} finally {
  await browser?.close();
  await vite?.close();
  await new Promise((resolve) => (preview ? preview.httpServer.close(resolve) : resolve()));
  await new Promise((resolve) => server.close(resolve));
  await rm(work, { recursive: true, force: true });
}
