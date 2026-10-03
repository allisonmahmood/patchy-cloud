// @effect-diagnostics nodeBuiltinImport:off -- Exercise Vite's filesystem graph and build watcher, and deep-compare its repeated results.
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
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

// Rename complete saves into place, rather than testing a truncate followed by a write.
const save = (file: string, source: string) => {
  writeFileSync(`${file}.tmp`, source);
  renameSync(`${file}.tmp`, file);
};

it("keeps type-only module forms outside the runtime page graph", async () => {
  const root = page(`import type { Missing } from "lodash";
import { type Other } from "lodash";
import type Legacy = require("lodash");
export type { Missing } from "lodash";
export { type Other } from "lodash";
import type { Handler } from "./server/leads.js";
export type { Handler } from "./server/leads.js";
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

it.each(["page", "server"] as const)(
  "builds and executes patchy/csv on the %s graph",
  async (graph) => {
    const root = page(`import { parse, stringify } from "patchy/csv";
globalThis.csvResult = parse(stringify([["=1", -42], ["a,b", "line\\nnext"]]));
`);
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [pageImports(root, () => {}, { graph })],
      build: {
        write: false,
        lib: { entry: path.join(root, "main.ts"), formats: ["iife"], name: "CsvExample" }
      }
    });
    const output = Array.isArray(result) ? result[0]! : result;
    if (!("output" in output)) throw new Error("Expected a completed CSV graph build.");
    const chunk = output.output.find((file) => file.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("The CSV graph emitted no JavaScript.");
    expect(JSON.parse(runInNewContext(`${chunk.code}\nJSON.stringify(csvResult)`))).toEqual([
      ["'=1", "-42"],
      ["a,b", "line\nnext"]
    ]);
  }
);

it.each([
  'import { handler } from "./server/leads.ts"; console.log(handler);',
  'export { handler } from "./server/leads.ts";',
  'void import("./server/leads.ts");'
])("refuses a page runtime import of server code: %s", async (source) => {
  const root = page(source);
  mkdirSync(path.join(root, "server"));
  writeFileSync(path.join(root, "server/leads.ts"), "export const handler = 1;");
  let refusal: LocalError | undefined;
  await expect(
    build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        pageImports(root, (error) => {
          refusal = error;
        })
      ],
      build: { write: false }
    })
  ).rejects.toThrow();
  expect(refusal).toMatchObject({ code: "import_refused" });
});

it.each([
  ['import "patchy/preact";', "import_refused"],
  ['import "node:fs";', "import_refused"],
  ['if (false) void import("./never.ts");', "invalid_manifest"],
  ['const source = "./never.ts"; void import(source);', "invalid_manifest"]
])("checks server graph imports before tree shaking: %s", async (source, code) => {
  const root = page(source);
  let refusal: LocalError | undefined;
  await expect(
    build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        pageImports(
          root,
          (error) => {
            refusal = error;
          },
          { graph: "server" }
        )
      ],
      build: { write: false }
    })
  ).rejects.toThrow();
  expect(refusal).toMatchObject({ code });
});

it.each(["./shim", "patchy/csv"])(
  "refuses server dependencies hidden by alias %s",
  async (source) => {
    const root = page(`import { value } from ${JSON.stringify(source)}; console.log(value);`);
    const dependency = path.join(root, "node_modules/foreign/index.js");
    mkdirSync(path.dirname(dependency));
    writeFileSync(dependency, "export const value = 42;");
    let refusal: LocalError | undefined;
    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        resolve: { alias: { [source]: dependency } },
        plugins: [
          pageImports(
            root,
            (error) => {
              refusal = error;
            },
            { graph: "server" }
          )
        ],
        build: { write: false }
      })
    ).rejects.toThrow();
    expect(refusal).toMatchObject({ code: "import_refused" });
  }
);

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
  let previous: Result | undefined;
  // A save can cause several Vite rebuilds. Return each distinct result, not one
  // queue entry per save; a new error or unexpected CSS still fails the test.
  // Deep equality compares two LocalError refusals by their code and message.
  const next = () =>
    vi.waitFor(
      () => {
        for (let result = completed.shift(); result; result = completed.shift()) {
          if (isDeepStrictEqual(result, previous)) continue;
          previous = result;
          return result;
        }
        throw new Error("Waiting for a new Vite build result.");
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
    save(nested, '@import "lodash/style.css";');
    const refused = await next();
    expect(refused).toMatchObject({
      error: { code: "import_refused", message: expect.stringContaining("nested.css") }
    });
    if (!("error" in refused)) throw new Error("Expected the nested stylesheet to be refused.");
    expect(refused.error.message).toContain('"lodash/style.css"');
    save(nested, '@import "./style.css"; body { color: blue; }');
    expect(await next()).toEqual({ css: expect.stringMatching(/color:\s*blue/) });
    expect(refusal).toBeUndefined();
  } finally {
    await watcher.close();
  }
}, 20_000);

// Each module form that names a package is refused at its authored importer, before an alias
// or Vite's resolver can hide it. The CLI build suite keeps the rows that prove the wiring.
it.each([
  { source: 'require("lodash");', aliased: true },
  { source: 'void import.defer("lodash");', aliased: true },
  { source: 'import value = require("lodash"); console.log(value);', aliased: true },
  { source: 'void import("lodash");' },
  { source: 'export { default } from "lodash";' },
  { source: 'import "vite/modulepreload-polyfill";', packageName: "vite" },
  { source: 'import "lodash";', entry: "src/node_modules/company/refused.ts" },
  { source: 'import "../node_modules/lodash/index.js";' },
  { source: 'import "/node_modules/lodash/index.js";' },
  { source: 'import "./style.css";', importer: "src/style.css" }
])(
  "refuses an off-SDK page import naming its importer: $source",
  async ({
    source,
    aliased,
    packageName = "lodash",
    entry = "src/refused.ts",
    importer = entry
  }) => {
    const root = page("");
    writeFileSync(
      path.join(root, "index.html"),
      `<!doctype html><html><body><script type="module" src="/${entry}"></script></body></html>`
    );
    mkdirSync(path.dirname(path.join(root, entry)), { recursive: true });
    writeFileSync(path.join(root, entry), source);
    writeFileSync(path.join(root, "src/local.ts"), "export default 1;");
    writeFileSync(path.join(root, "src/style.css"), '@import "lodash/style.css";');
    const dependency = path.join(root, "node_modules/lodash");
    mkdirSync(dependency);
    writeFileSync(path.join(dependency, "package.json"), '{"name":"lodash","version":"1.0.0"}');
    writeFileSync(path.join(dependency, "index.js"), 'document.body.textContent="Dependency";');
    writeFileSync(path.join(dependency, "style.css"), "body { color: red; }");
    let refusal: LocalError | undefined;
    await expect(
      build({
        root,
        configFile: false,
        logLevel: "silent",
        ...(aliased ? { resolve: { alias: { lodash: path.join(root, "src/local.ts") } } } : {}),
        plugins: [
          pageImports(root, (error) => {
            refusal = error;
          })
        ],
        build: { write: false }
      })
    ).rejects.toThrow();
    expect(refusal).toMatchObject({ code: "import_refused" });
    expect(refusal?.message).toContain(`Package "${packageName}"`);
    expect(refusal?.message).toContain(` in ${importer} `);
  }
);
