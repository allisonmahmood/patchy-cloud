import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import type { Json } from "../../packages/patchy/src/config.js";
import { test, expect } from "./fixtures.js";

// The same cases execute in a sandboxed Chromium page and a published workerd handler.
test.skip(({ browserName }) => browserName !== "chromium", "The SDK targets Chromium desktop.");
const packageRoot = fileURLToPath(new URL("../../packages/patchy", import.meta.url));
const probe = `import { CsvError, parse, records, stringify } from "patchy/csv";
function run(input) {
  try {
    if (input.method === "stringify") return { value: stringify(input.rows, input.options) };
    const text = (input.prefix ?? "") + input.text.repeat(input.repeat ?? 1) + (input.suffix ?? "");
    const value = input.method === "records" ? records(text) : parse(text);
    return { value: input.summary ? { rows: value.length, width: value[0]?.length, characters: value[0]?.[0]?.length } : value };
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
    name: "LF, escaped quotes, commas, and whitespace remain exact",
    input: { method: "parse", text: 'name,notes\n" Ada ","say ""hello"", friend"\n' },
    expected: {
      value: [
        ["name", "notes"],
        [" Ada ", 'say "hello", friend']
      ]
    }
  },
  {
    name: "quoted multiline fields preserve CRLF and LF including blank physical lines",
    input: { method: "parse", text: 'name,notes\r\nAda,"first\r\n\r\nthird\nlast"\nBob,done\r\n' },
    expected: {
      value: [
        ["name", "notes"],
        ["Ada", "first\r\n\r\nthird\nlast"],
        ["Bob", "done"]
      ]
    }
  },
  {
    name: "only empty physical lines disappear from parsed rows",
    input: { method: "parse", text: '\n\r\n \n""\n,\n\n' },
    expected: { value: [[" "], [""], ["", ""]] }
  },
  {
    name: "record headers skip blank lines but retain whitespace and quoted empty values",
    input: { method: "records", text: '\nname\r\n\r\n \r\n""\r\nAda\r\n' },
    expected: {
      value: {
        headers: ["name"],
        records: [{ name: " " }, { name: "" }, { name: "Ada" }],
        errors: []
      }
    }
  },
  {
    name: "wrong-width records report physical starts after multiline and blank rows without padding",
    input: {
      method: "records",
      text: '\uFEFFname,note\r\nAda,"one\r\ntwo"\r\n\r\nshort\r\nextra,a,b\r\n,\r\nBob,ok\r\n'
    },
    expected: {
      value: {
        headers: ["name", "note"],
        records: [
          { name: "Ada", note: "one\r\ntwo" },
          { name: "", note: "" },
          { name: "Bob", note: "ok" }
        ],
        errors: [
          { line: 5, expected: 2, actual: 1 },
          { line: 6, expected: 2, actual: 3 }
        ]
      }
    }
  },
  {
    name: "duplicate decoded headers fail rather than getting renamed",
    input: { method: "records", text: '\nname,"name"\nAda,Bob' },
    expected: { error: { code: "duplicate_header", line: 2 } }
  },
  ...(["parse", "records"] as const).map((method) => ({
    name: `${method} fails an unterminated field on its physical opening line`,
    input: { method, text: 'name,notes\n"first\nsecond","not\nclosed' },
    expected: { error: { code: "unterminated_quote", line: 3 } }
  })),
  {
    name: "a later BOM is cell text, not an encoding marker",
    input: { method: "parse", text: "\uFEFFname\n\uFEFFAda" },
    expected: { value: [["name"], ["\uFEFFAda"]] }
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
    name: "formula protection can be disabled without disabling CSV quoting",
    input: {
      method: "stringify",
      rows: [["=1", "+2", "-3", "@x", "\tcmd", "\rcmd", -4]],
      options: { formulaProtection: false }
    },
    expected: { value: '=1,+2,-3,@x,\tcmd,"\rcmd",-4' }
  },
  {
    name: "export escapes quotes and commas, writes CRLF, and retains empty one-cell rows",
    input: { method: "stringify", rows: [['say "hi", friend', "line\nnext"], [""]] },
    expected: { value: '"say ""hi"", friend","line\nnext"\r\n""' }
  },
  {
    name: "the exact character bound is accepted",
    input: { method: "parse", text: "x", repeat: 10_000_000, summary: true },
    expected: { value: { rows: 1, width: 1, characters: 10_000_000 } }
  },
  {
    name: "input beyond the character bound is refused",
    input: { method: "parse", text: "x", repeat: 10_000_001 },
    expected: { error: { code: "limit_exceeded", limitId: "csv.characters", value: 10_000_000 } }
  },
  {
    name: "one wide row accepts the exact cell bound",
    input: { method: "parse", text: ",", repeat: 999_999, summary: true },
    expected: { value: { rows: 1, width: 1_000_000, characters: 0 } }
  },
  {
    name: "one wide row is stopped at the cell bound",
    input: { method: "parse", text: ",", repeat: 1_000_000 },
    expected: { error: { code: "limit_exceeded", limitId: "csv.cells", value: 1_000_000, line: 1 } }
  },
  {
    name: "cell limits count headers and rejected record rows",
    input: { method: "records", prefix: "name\n", text: "a,b\n", repeat: 500_000 },
    expected: {
      error: { code: "limit_exceeded", limitId: "csv.cells", value: 1_000_000, line: 500_001 }
    }
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
        const result = await frame.evaluate(
          ({ graph, input }) => {
            // The fixture above installs this page-local probe before signaling readiness.
            const csvWindow = window as unknown as {
              csvProbe(graph: "page" | "server", input: Json): Promise<Json> | Json;
            };
            return csvWindow.csvProbe(graph, input);
          },
          { graph, input: scenario.input }
        );
        expect(result).toEqual(scenario.expected);
      });
    }
  }
});
