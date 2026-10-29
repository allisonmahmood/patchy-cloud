import { assert, it } from "@effect/vitest";
import type { attioTypes } from "@patchy/api/attio-types";
import type { AttioTypes } from "../../../patchy/src/attio.js";
import * as PatchyClient from "../../../patchy/src/client.js";
import { transformSync } from "esbuild";
import { typecheck } from "../../../../test/typescript.js";
import { snapshot } from "../test/attioReads.js";
import { generate } from "./Generate.js";

const declaration = { kind: "attio" as const, handle: "crm", id: "connection", revision: 2 };

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/**
 * The client's copy of the type table is the host's, so a patch's types refuse exactly what the
 * host refuses; a change to one alone fails the typecheck here.
 */
const sameTable: Equal<AttioTypes, typeof attioTypes> = true;
void sameTable;

it("types each object's values and filters by the type table, and refuses the rest", () => {
  const generated = generate(declaration, snapshot);
  assert.deepStrictEqual(
    typecheck({
      "generated.ts": generated.client,
      "consumer.ts": `import { createClient, type Records, type ReadError } from "./generated.js";
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

it("takes a bare id only where a reference has exactly one target", () => {
  const deals = snapshot.objects[0]!;
  const orphaned = {
    ...snapshot,
    objects: [
      {
        ...deals,
        attributes: [
          ...deals.attributes,
          {
            id: "att-orphan",
            slug: "orphan",
            title: "Orphan",
            type: "record-reference" as const,
            multiselect: false,
            targets: []
          }
        ]
      },
      ...snapshot.objects.slice(1)
    ]
  };
  assert.deepStrictEqual(
    typecheck({
      "generated.ts": generate(declaration, orphaned).client,
      "consumer.ts": `import { createClient } from "./generated.js";
const crm = createClient("crm", async () => ({ ok: true, rows: [], cursor: null }));
void crm.objects.deals.list({ eq: { associated_company: "00000000-0000-4000-8000-000000000001" } });
// @ts-expect-error every target was left out, so a bare id names none
void crm.objects.deals.list({ eq: { orphan: "00000000-0000-4000-8000-000000000001" } });
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
    typecheck({
      "generated.ts": generated.client,
      "consumer.ts": `import { createClient } from "./generated.js";
const crm = createClient("crm", async () => ({ ok: true, rows: [] }));
void crm.objects["__proto__"].list();
void crm.lists["my-list"].get("x");
`
    }),
    []
  );
  const javascript = transformSync(generated.client, {
    loader: "ts",
    format: "cjs",
    target: "es2022"
  }).code;
  const exports = new Function("module", "require", `${javascript}\nreturn module.exports;`)(
    { exports: {} },
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
