import { assert, it } from "@effect/vitest";
import * as ts from "typescript";
import * as Schema from "effect/Schema";
import { generate } from "./Generate.js";
import type { Snapshot } from "./Snapshot.js";
import * as PatchyClient from "../../../patchy/src/client.js";
import { t } from "../../../patchy/src/config.js";
import { expect } from "vitest";

const text = {
  schema: "pg_catalog",
  name: "text",
  sql: "text",
  baseSchema: "pg_catalog",
  baseName: "text",
  kind: "base" as const
};
const id = { ...text, name: "int8", baseName: "int8", sql: "int8" };
const snapshot: typeof Snapshot.Type = {
  version: 1,
  enums: [{ schema: "public", name: "status", labels: ["open"] }],
  exclusions: [],
  relations: [
    {
      schema: "public",
      name: "accounts",
      kind: "table",
      columns: [
        { name: "id", type: id, nullable: false },
        { name: "name", type: text, nullable: false },
        {
          name: "status",
          type: {
            schema: "public",
            name: "status",
            sql: "status",
            baseSchema: "public",
            baseName: "status",
            kind: "enum"
          },
          nullable: false
        }
      ],
      primaryKey: { name: "pk", columns: ["id"] },
      foreignKeys: []
    },
    {
      schema: "sales",
      name: "daily totals",
      kind: "view",
      columns: [{ name: "name", type: text, nullable: true }],
      primaryKey: null,
      foreignKeys: []
    }
  ]
};
const declaration = {
  kind: "postgres" as const,
  handle: "warehouse",
  id: "connection",
  revision: 3
};

it("compiles projected keys, keyless views, query shapes and discriminated known errors", () => {
  const generated = generate(declaration, snapshot);
  const patchy = new URL("../../../patchy/dist/", import.meta.url).pathname;
  const files: Readonly<Record<string, string>> = {
    "/generated.ts": generated.client,
    "/consumer.ts": `import { createClient, type ListError } from "./generated.js";
import { isPatchyError } from "patchy/client";
import { t } from "patchy/config";
const db = createClient("sales", async () => ({ ok: true, rows: [], cursor: null }));
async function use(nullableFlag: boolean) {
  const page = await db.accounts.list({ eq: { id: "9" }, range: { column: "id", gt: "1" }, orderBy: { column: "name", direction: "asc" }, select: ["name"] });
  const name: string = page.rows[0]!.name;
  // @ts-expect-error projection omitted id
  page.rows[0]!.id;
  // @ts-expect-error selected column does not exist
  db.accounts.list({ select: ["missing"] });
  // @ts-expect-error native bigint takes a string
  db.accounts.list({ eq: { id: 9 } });
  // @ts-expect-error wrong range value for column
  db.accounts.list({ range: { column: "id", gt: 4 } });
  const row = await db.accounts.get({ id: "9" });
  const key: string | undefined = row?.id;
  const addedLabel: NonNullable<typeof row>["status"] = "added_after_discovery";
  // @ts-expect-error a keyless view does not expose get
  db.sales["daily totals"].get({ name: "x" });
  const view = await db.sales["daily totals"].list();
  const nullable: string | null = view.rows[0]!.name;
  const query = await db.query("SELECT 1 AS n", [], { n: { kind: "integer" }, at: { kind: "timestamp", optional: true } });
  const number: number = query.rows[0]!.n;
  const at: string | null = query.rows[0]!.at;
  const dynamic = await db.query("SELECT NULL::integer AS n", [], { n: { kind: "integer", optional: nullableFlag } });
  const dynamicValue: number | null = dynamic.rows[0]!.n;
  // @ts-expect-error a runtime optional flag may permit null
  const requiredValue: number = dynamic.rows[0]!.n;
  // @ts-expect-error references are not an escape-hatch kind
  db.query("SELECT 1", [], { n: { kind: "ref" } });
  // @ts-expect-error defaults are not accepted by query shape
  db.query("SELECT 1", [], { n: { kind: "integer", default: 1 } });
  const built = await db.query("SELECT 1 AS n", [], { n: t.integer(), title: t.text().optional() });
  const builtNumber: number = built.rows[0]!.n;
  const builtTitle: string | null = built.rows[0]!.title;
  // @ts-expect-error defaulted builders are not query shapes
  db.query("SELECT 1", [], { n: t.integer().default(1) });
  // @ts-expect-error ref builders are not query shapes
  db.query("SELECT 1", [], { n: t.ref("notes") });
  try { await db.accounts.list(); } catch (error: unknown) {
    if (isPatchyError(error, "invalid_query")) {
      const sqlstate: string = error.details.sqlstate;
      const position: string | undefined = error.details.position;
    }
    if (isPatchyError(error, "shape_mismatch")) {
      if (error.details.reason === "source_schema_changed") {
        const schema: string = error.details.relation.schema;
        const relation: string = error.details.relation.name;
        // @ts-expect-error a relation schema failure does not identify one column
        error.details.column;
      } else {
        const column: string = error.details.column;
        const reason: "missing" | "duplicate" | "type" | "null" | "value" | "row_width" = error.details.reason;
        // @ts-expect-error an ordinary shape failure carries column rather than relation
        error.details.relation;
      }
    }
    if (isPatchyError(error, "relation_unknown")) {
      const schema: string = error.details.relation.schema;
      const relation: string = error.details.relation.name;
    }
    if (isPatchyError(error, "offset_exhausted")) {
      const maximum: 10000 = error.details.maxOffset;
    }
    if (isPatchyError(error, "too_large")) {
      const maximum: 1000 | undefined = error.details.maxRows;
    }
  }
}
function inspect(error: ListError) {
  if (error.code === "invalid_query") { const sqlstate: string = error.details.sqlstate; }
  if (error.code === "shape_mismatch") {
    if (error.details.reason === "source_schema_changed") {
      const relation: string = error.details.relation.name;
    } else {
      const column: string = error.details.column;
    }
  }
}
`
  };
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: {
      "patchy/client": [`${patchy}client.d.ts`],
      "patchy/config": [`${patchy}config.d.ts`]
    },
    resolveJsonModule: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
    skipLibCheck: true
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (file) => Object.hasOwn(files, file) || fileExists(file);
  host.readFile = (file) => files[file] ?? readFile(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    Object.hasOwn(files, file)
      ? ts.createSourceFile(file, files[file]!, languageVersion, true)
      : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram(
    Object.keys(files).filter((file) => file.endsWith(".ts")),
    options,
    host
  );
  assert.deepStrictEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    []
  );
});

it("preserves arbitrary names without prototype mutation and narrows transport refusals", async () => {
  const malicious = "__proto__";
  const generated = generate(
    { ...declaration, description: '<script>alert("x")</script>\n# forged' },
    {
      ...snapshot,
      relations: [
        { ...snapshot.relations[0]!, name: malicious },
        { ...snapshot.relations[0]!, name: 'x"\n</script>/*' }
      ]
    }
  );
  const javascript = ts.transpileModule(generated.client, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const exports = new Function("exports", "require", `${javascript}\nreturn exports;`)(
    {},
    (name: string) => {
      assert.strictEqual(name, "patchy/client");
      return PatchyClient;
    }
  ) as {
    createClient: (
      connection: string,
      call: (op: string, args: unknown) => Promise<unknown>
    ) => Record<
      string,
      {
        get: (key: unknown) => Promise<unknown>;
        list: () => Promise<unknown>;
      }
    > & { query(sql: string, params: readonly unknown[], shape: unknown): Promise<unknown> };
  };
  const seen: unknown[] = [];
  const client = exports.createClient("alias", async (op: string, args: unknown) => {
    seen.push([op, args]);
    return { ok: true, rows: [{ id: "7", name: "Kept" }], cursor: null };
  });
  assert.isTrue(Object.hasOwn(client, malicious));
  assert.strictEqual(Object.getPrototypeOf(client), Object.prototype);
  assert.deepStrictEqual(await client[malicious].get({ id: "7" }), { id: "7", name: "Kept" });
  assert.deepStrictEqual(seen, [
    [
      "postgres.get",
      { connection: "alias", relation: { schema: "public", name: malicious }, key: { id: "7" } }
    ]
  ]);
  await client.query("SELECT 1 AS n", [], { n: t.integer(), title: t.text().optional() });
  assert.deepStrictEqual(seen[1], [
    "postgres.query",
    {
      connection: "alias",
      sql: "SELECT 1 AS n",
      params: [],
      shape: { n: { kind: "integer", optional: false }, title: { kind: "text", optional: true } }
    }
  ]);
  await expect(client.query("SELECT 1", [], { n: t.integer().default(1) })).rejects.toMatchObject({
    code: "invalid_request"
  });
  await expect(client.query("SELECT 1", [], { n: t.ref("notes") })).rejects.toMatchObject({
    code: "invalid_request"
  });
  await expect(
    client.query("SELECT 1", [], { n: { kind: "integer", default: 1 } })
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    client.query("SELECT 1", [], { n: { kind: "integer", extra: true } })
  ).rejects.toMatchObject({ code: "invalid_request" });
  const failing = exports.createClient("alias", async () => ({
    ok: false,
    code: "invalid_query",
    error: "column missing",
    details: { sqlstate: "42703", message: "column missing", position: "8" }
  }));
  try {
    await failing[malicious].list();
    assert.fail("expected refusal");
  } catch (error) {
    assert.isTrue(PatchyClient.isPatchyError(error, "invalid_query"));
    assert.instanceOf(error, PatchyClient.PatchyError);
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({ details: Schema.Struct({ sqlstate: Schema.String }) })
    )(error);
    assert.strictEqual(parsed.details.sqlstate, "42703");
  }
  assert.notInclude(generated.context, "<script>");
  assert.notInclude(generated.context, "\n# forged");
  assert.isTrue(
    generated.fixture.split("\n").every((line) => line === "" || line.startsWith("--"))
  );
});
