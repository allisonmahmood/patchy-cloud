// @effect-diagnostics nodeBuiltinImport:off -- Exercise Vite's filesystem graph and build watcher.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { build } from "vite";
import type { LocalError } from "./CliError.js";
import { pageImports } from "./pageImports.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const page = (source: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "patchy-page-imports-"));
  roots.push(root);
  mkdirSync(path.join(root, "node_modules"));
  symlinkSync(packageDir, path.join(root, "node_modules/patchy"), "dir");
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    path.join(root, "index.html"),
    '<!doctype html><html><body><script type="module" src="/main.ts"></script></body></html>'
  );
  writeFileSync(path.join(root, "main.ts"), source);
  return root;
};

it("keeps type-only module forms outside the runtime page graph", async () => {
  const root = page(`import type { Missing } from "lodash";
import { type Other } from "lodash";
import type Legacy = require("lodash");
export type { Missing } from "lodash";
export { type Other } from "lodash";
document.body.textContent = "Types stay outside the page graph";
`);
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [pageImports(root, () => {})],
    build: { write: false }
  });
  if (!("output" in result)) throw new Error("Expected a completed Vite build.");
  const script = result.output
    .filter((file) => file.type === "chunk")
    .map((file) => file.code)
    .join("\n");
  expect(script).toContain("Types stay outside the page graph");
  expect(script).not.toContain("lodash");
});

it("rechecks nested CSS edits, refuses the actual importer, and recovers through cycles", async () => {
  const root = page('import "./style.css";');
  const nested = path.join(root, "nested.css");
  writeFileSync(path.join(root, "style.css"), '@import "./nested.css";');
  writeFileSync(nested, '@import "./style.css"; body { color: red; }');
  mkdirSync(path.join(root, "node_modules/lodash"));
  writeFileSync(
    path.join(root, "node_modules/lodash/package.json"),
    '{"name":"lodash","version":"1.0.0"}'
  );
  writeFileSync(path.join(root, "node_modules/lodash/style.css"), "body { color: green; }");

  let refusal: LocalError | undefined;
  let builtCss = "";
  type Result = { css: string } | { error: Error };
  const completed: Result[] = [];
  const next = () =>
    vi.waitFor(
      () => {
        const result = completed.shift();
        if (!result) throw new Error("Waiting for a completed Vite build.");
        return result;
      },
      { timeout: 5_000 }
    );
  const watcher = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      pageImports(root, (error) => {
        refusal = error;
      }),
      {
        name: "observe-page-build",
        writeBundle(_options, bundle) {
          builtCss = Object.values(bundle)
            .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
            .map((file) => (file.type === "asset" ? String(file.source) : ""))
            .join("\n");
        }
      }
    ],
    build: { watch: {}, minify: false }
  });
  if (!("on" in watcher)) throw new Error("Expected a Vite build watcher.");
  watcher.on("event", (event) => {
    if (event.code === "ERROR") completed.push({ error: refusal ?? event.error });
    else if (event.code === "BUNDLE_END") completed.push({ css: builtCss });
  });
  try {
    expect(await next()).toEqual({ css: expect.stringMatching(/color:\s*red/) });
    writeFileSync(nested, '@import "lodash/style.css";');
    const refused = await next();
    expect(refused).toMatchObject({
      error: { code: "import_refused", message: expect.stringContaining("nested.css") }
    });
    if (!("error" in refused)) throw new Error("Expected the nested stylesheet to be refused.");
    expect(refused.error.message).toContain('"lodash/style.css"');
    writeFileSync(nested, '@import "./style.css"; body { color: blue; }');
    expect(await next()).toEqual({ css: expect.stringMatching(/color:\s*blue/) });
    expect(refusal).toBeUndefined();
  } finally {
    await watcher.close();
  }
}, 20_000);
