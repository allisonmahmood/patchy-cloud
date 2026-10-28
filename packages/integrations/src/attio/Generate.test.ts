import { assert, it } from "@effect/vitest";
import * as PatchyClient from "../../../patchy/src/client.js";
import * as ts from "typescript";
import { snapshot } from "../test/attioReads.js";
import { generate } from "./Generate.js";

const declaration = { kind: "attio" as const, handle: "crm", id: "connection", revision: 2 };

/** TypeScript's verdict on `files` against the built `patchy/client`. */
const diagnostics = (files: Readonly<Record<string, string>>) => {
  const patchy = new URL("../../../patchy/dist/", import.meta.url).pathname;
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: { "patchy/client": [`${patchy}client.d.ts`] },
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
  const program = ts.createProgram(Object.keys(files), options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
};

it("types each object's values and filters by the type table, and refuses the rest", () => {
  const generated = generate(declaration, snapshot);
  assert.deepStrictEqual(
    diagnostics({
      "/generated.ts": generated.client,
      "/consumer.ts": `import { createClient, type Records, type ReadError } from "./generated.js";
import { isPatchyError } from "patchy/client";
const crm = createClient("crm", async () => ({ ok: true, rows: [], cursor: null }));
async function use(owner: string) {
  const page = await crm.objects.deals.list({
    eq: { stage: "Lead", owner, segment: ["SMB", "Strategic"], tags: null, associated_company: owner },
    contains: { name: "acme" },
    range: { attribute: "value", gte: 1000 },
    orderBy: { attribute: "value", direction: "desc" },
    limit: 500
  });
  const deal = page.rows[0]!;
  const stage: string | null = deal.values.stage;
  const value: { readonly amount: number; readonly currency: string | null } | null = deal.values.value;
  const company: { readonly object: "companies"; readonly id: string } | null = deal.values.associated_company;
  const people: readonly { readonly object: "people"; readonly id: string }[] = deal.values.associated_people;
  const hot: boolean = deal.values.is_hot;
  const next: string | null = page.cursor;
  const one: Records["deals"] | null = await crm.objects.deals.get(deal.id);
  const many = await crm.objects.companies.getMany(people.map((person) => person.id));
  const domains: readonly string[] | undefined = many[0]?.values.domains;
  const entries = await crm.lists.pipeline.list({ parent: deal.id, eq: { stage: "Demo" }, orderBy: { attribute: "entered_on" } });
  const parent: "deals" = entries.rows[0]!.parent.object;
  await crm.lists.accounts.list({ parent: { object: "people", id: deal.id } });
  const members = await crm.members.list();
  const active: boolean = members[0]!.active;
  const name: { readonly first: string | null } | null = (await crm.objects.people.get("x"))!.values.name;
  void [stage, value, company, hot, next, one, domains, parent, active, name];
  // @ts-expect-error a checkbox is never empty
  crm.objects.deals.list({ eq: { is_hot: null } });
  // @ts-expect-error nor is a location
  crm.objects.deals.list({ eq: { hq_location: null } });
  // @ts-expect-error text doesn't range
  crm.objects.deals.list({ range: { attribute: "name", gte: "a" } });
  // @ts-expect-error numbers don't contain
  crm.objects.deals.list({ contains: { amount: "5" } });
  // @ts-expect-error a multiselect select doesn't sort
  crm.objects.deals.list({ orderBy: { attribute: "tags" } });
  // @ts-expect-error references don't sort
  crm.objects.deals.list({ orderBy: { attribute: "associated_company" } });
  // @ts-expect-error a reference with several targets needs its object
  crm.objects.deals.list({ eq: { counterparty: owner } });
  // @ts-expect-error an interaction has no eq
  crm.objects.people.list({ eq: { last_interaction: "2026-01-01T00:00:00Z" } });
  // @ts-expect-error no such attribute
  crm.objects.deals.list({ eq: { nope: 1 } });
  // @ts-expect-error no such object
  crm.objects.invoices.list();
  // @ts-expect-error a list with several parents needs the parent's object
  crm.lists.accounts.list({ parent: deal.id });
  // @ts-expect-error nothing writes
  crm.objects.deals.update;
  try {
    await crm.objects.deals.list();
  } catch (error: unknown) {
    if (isPatchyError(error, "shape_mismatch", "attio")) {
      const reason: string = error.details.reason;
      const renamedTo: string | undefined = error.details.renamedTo;
      void [reason, renamedTo];
    }
    if (isPatchyError(error, "invalid_request", "attio")) {
      const attribute: string | undefined = error.details.attribute;
      void attribute;
    }
  }
}
function inspect(error: ReadError) {
  if (error.code === "invalid_query") {
    const reason: string = error.details.reason;
    void reason;
  }
}
void [use, inspect];
`
    }),
    []
  );
});

it("keeps any slug as a key and reads through the host's operations", async () => {
  const odd = {
    ...snapshot,
    objects: [{ ...snapshot.objects[0]!, slug: "__proto__" }, ...snapshot.objects.slice(1)],
    lists: [{ ...snapshot.lists[0]!, slug: "my-list" }]
  };
  const generated = generate(declaration, odd);
  assert.deepStrictEqual(
    diagnostics({
      "/generated.ts": generated.client,
      "/consumer.ts": `import { createClient } from "./generated.js";
const crm = createClient("crm", async () => ({ ok: true, rows: [] }));
void crm.objects["__proto__"].list();
void crm.lists["my-list"].get("x");
`
    }),
    []
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
    ) => {
      objects: Record<
        string,
        { list(o?: object): Promise<unknown>; get(id: string): Promise<unknown> }
      >;
      lists: Record<string, { get(id: string): Promise<unknown> }>;
      members: { list(): Promise<unknown> };
    };
  };
  const seen: unknown[] = [];
  const client = exports.createClient("crm", async (op, args) => {
    seen.push([op, args]);
    return { ok: true, rows: [], cursor: null };
  });
  assert.deepStrictEqual(await client.objects["__proto__"]!.list({ limit: 5, cursor: undefined }), {
    rows: [],
    cursor: null
  });
  assert.isNull(await client.lists["my-list"]!.get("e1"));
  assert.deepStrictEqual(await client.members.list(), []);
  assert.deepStrictEqual(seen, [
    ["attio.listRecords", { limit: 5, object: "__proto__", connection: "crm" }],
    ["attio.getEntry", { list: "my-list", id: "e1", connection: "crm" }],
    ["attio.listMembers", { connection: "crm" }]
  ]);
  // A refusal the host sent reaches the patch as a typed error.
  const refusing = exports.createClient("crm", async () => ({
    ok: false,
    source: "patchy",
    code: "shape_mismatch",
    error: "Attio's attribute amount on object deals is gone.",
    details: { object: "deals", attribute: "amount", reason: "missing" }
  }));
  const error = await refusing.objects.deals!.list().catch((caught: unknown) => caught);
  assert.isTrue(PatchyClient.isPatchyError(error, "shape_mismatch", "attio"));
});

it("names the operations, values and limits in the context", () => {
  const { context } = generate(declaration, snapshot);
  assert.include(context, "## Operations");
  assert.include(context, "`objects.<slug>.list({ eq, contains, range, orderBy, limit, cursor })`");
  assert.include(context, "`members.list()`");
  assert.include(context, "Read only.");
});
