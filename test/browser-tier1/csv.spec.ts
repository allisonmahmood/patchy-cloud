import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Json } from "../../packages/patchy/src/config.js";
import { test, expect } from "./fixtures.js";

// packages/patchy/src/csv.test.ts owns the codec's cases. These prove the page and the
// published workerd handler bundle the same codec and carry its results and errors.
test.skip(({ browserName }) => browserName !== "chromium", "The SDK targets Chromium desktop.");
const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
const probe = `import { CsvError, parse, stringify } from "patchy/csv";
function run(input) {
  try {
    if (input.method === "stringify") return { value: stringify(input.rows, input.options) };
    return { value: parse(input.text.repeat(input.repeat ?? 1)) };
  } catch (error) {
    if (!(error instanceof CsvError)) throw error;
    return { error: { code: error.code, ...(error.line === undefined ? {} : { line: error.line }),
      ...(error.limitId === undefined ? {} : { limitId: error.limitId, value: error.value }) } };
  }
}`;
const cases: { name: string; input: Json; expected: Json }[] = [
  {
    name: "BOM and CRLF preserve numeric, boolean, and date-looking strings",
    input: {
      method: "parse",
      text: "\uFEFFcode,active,amount,date\r\n0007,true,1.50,2026-09-30\r\n"
    },
    expected: {
      value: [
        ["code", "active", "amount", "date"],
        ["0007", "true", "1.50", "2026-09-30"]
      ]
    }
  },
  {
    name: "formula-leading text is protected while numbers remain numbers in the CSV",
    input: {
      method: "stringify",
      rows: [
        ["=SUM(A1)", "+1", "-2", "@x", "\tcmd", "\rcmd", -42, 3.5],
        ["=first\nsecond", "plain"]
      ]
    },
    expected: {
      value:
        '"\'=SUM(A1)","\'+1","\'-2","\'@x","\'\tcmd","\'\rcmd",-42,3.5\r\n"\'=first\nsecond",plain'
    }
  },
  {
    name: "one wide row is stopped at the cell bound",
    input: { method: "parse", text: ",", repeat: 1_000_000 },
    expected: { error: { code: "limit_exceeded", limitId: "csv.cells", value: 1_000_000, line: 1 } }
  }
];

test("CSV import and export keep their contract on the page and server graphs", async ({
  page,
  instance
}) => {
  const server = await build({
    stdin: {
      contents: `${probe}\nimport { query, createGuest, t } from "patchy/server";
const inspect = query({ args: { input: t.json() }, result: t.json(), handler: (_ctx, args) => run(args.input) });
export default createGuest({ csv: { inspect } });`,
      resolveDir: packageRoot,
      sourcefile: "csv-server.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm"
  });
  const client = await build({
    stdin: {
      contents: `${probe}\nimport { createServerClient } from "patchy/client";
const client = createServerClient();
window.csvProbe = (graph, input) => graph === "page" ? run(input) : client.server.csv.inspect({ input });
document.getElementById("ready").textContent = "CSV ready";`,
      resolveDir: packageRoot,
      sourcefile: "csv-page.ts"
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife"
  });
  const html = `<!doctype html><html><head><title>CSV</title></head><body><p id="ready">Starting</p><script>${client.outputFiles[0]!.text.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const patch = await instance.publish(
    "company",
    html,
    undefined,
    {
      tier: 2,
      tables: {},
      files: {},
      handlers: {
        "csv.inspect": {
          kind: "query",
          args: { input: { kind: "json" } },
          result: { kind: "json" }
        }
      }
    },
    { server: server.outputFiles[0]!.text }
  );
  expect((await page.goto(patch.address))?.status()).toBe(200);
  await expect(page.frameLocator("#patch").locator("#ready")).toHaveText("CSV ready");
  const frame = page.frames().find((candidate) => candidate.url().includes("/~content/"));
  if (!frame) throw new Error("The CSV page did not load.");
  for (const graph of ["page", "server"] as const) {
    for (const scenario of cases) {
      await test.step(`${graph}: ${scenario.name}`, async () => {
        // Playwright's argument typing recurses without bound through `Json`; the probe takes any input.
        const request: { graph: "page" | "server"; input: unknown } = {
          graph,
          input: scenario.input
        };
        const result = await frame.evaluate(({ graph, input }) => {
          // The fixture above installs this page-local probe before signaling readiness.
          const csvWindow = window as unknown as {
            csvProbe(graph: "page" | "server", input: unknown): Promise<Json> | Json;
          };
          return csvWindow.csvProbe(graph, input);
        }, request);
        expect(result).toEqual(scenario.expected);
      });
    }
  }
});
