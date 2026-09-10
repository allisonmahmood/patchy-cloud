import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  acceptedSourceTypes,
  nativeType,
  normalizeTimestamp,
  quoteIdentifier,
  quoteLiteral,
  surface,
  typeMapping
} from "./Mapping.js";
import { Snapshot } from "./Snapshot.js";
import type { ColumnType } from "./Snapshot.js";

const type = (baseName: string): typeof ColumnType.Type => ({
  schema: "pg_catalog",
  name: baseName,
  sql: baseName,
  baseSchema: "pg_catalog",
  baseName,
  kind: "base"
});

it("retains integer and decimal precision and refuses nonfinite or out-of-range values", () => {
  assert.isTrue(typeMapping(type("int8"))!.is("9223372036854775807"));
  assert.isFalse(typeMapping(type("int8"))!.is("9223372036854775808"));
  assert.isFalse(typeMapping(type("int8"))!.is(9007199254740992));
  assert.isTrue(typeMapping(type("numeric"))!.is("12345678901234567890.123456789"));
  assert.isFalse(typeMapping(type("numeric"))!.is("NaN"));
  assert.isFalse(typeMapping(type("float8"))!.is(Infinity));
  assert.isFalse(typeMapping(type("float8"))!.is(NaN));
  assert.isFalse(typeMapping(type("int2"))!.is(32768));
  assert.isFalse(typeMapping(type("int4"))!.is(1.5));
});

it("normalizes UTC across dates without truncating fractional microseconds", () => {
  assert.strictEqual(
    normalizeTimestamp("2024-03-01 00:00:00.123456+02", true),
    "2024-02-29T22:00:00.123456Z"
  );
  assert.strictEqual(
    normalizeTimestamp("2024-02-29 20:00:00.000001", false),
    "2024-02-29T20:00:00.000001"
  );
  assert.strictEqual(normalizeTimestamp("2023-02-29 00:00:00", false), undefined);
  assert.strictEqual(normalizeTimestamp("2024-01-01 00:00:00.1234567Z", true), undefined);
  assert.isTrue(typeMapping(type("timestamptz"))!.is("2024-02-29T22:00:00.123456Z"));
  assert.isFalse(typeMapping(type("timestamp"))!.is("2024-02-29T22:00:00.123456Z"));
  assert.isFalse(typeMapping(type("date"))!.is("infinity"));
});

it("names whole unrepresentable relations and collisions identically on repeated surface selection", () => {
  const relation = {
    schema: "public",
    name: "accounts",
    kind: "table" as const,
    columns: [{ name: "id", type: type("int8"), nullable: false }],
    primaryKey: { name: "pk", columns: ["id"] },
    foreignKeys: []
  };
  const snapshot = {
    version: 1 as const,
    enums: [],
    exclusions: [],
    relations: [
      relation,
      { ...relation, name: "query" },
      { ...relation, name: "sales" },
      { ...relation, schema: "sales", name: "orders" },
      {
        ...relation,
        name: "exotic",
        columns: [{ name: "point", type: type("point"), nullable: true }]
      },
      {
        ...relation,
        name: "no_key",
        columns: [{ name: "id", type: type("jsonb"), nullable: false }]
      }
    ]
  };
  const selected = surface(snapshot);
  assert.deepStrictEqual(
    selected.relations.map((item) => `${item.schema}.${item.name}`),
    ["public.accounts", "sales.orders", "public.no_key"]
  );
  assert.isNull(selected.relations[2]!.primaryKey);
  assert.deepStrictEqual(
    selected.exclusions
      .filter((item) => item.column === undefined)
      .map((item) => [item.relation, item.reason]),
    [
      ["query", "reserved_name"],
      ["sales", "reserved_name"],
      ["exotic", "unsupported_type"]
    ]
  );
  assert.deepStrictEqual(surface(selected), selected);
  assert.isTrue(Schema.is(Snapshot)(selected));
});

it("preserves supported columns and usable keys beside named column exclusions", () => {
  const relation = {
    schema: "public",
    name: "places",
    kind: "table" as const,
    columns: [
      { name: "id", type: type("int4"), nullable: false },
      { name: "location", type: type("point"), nullable: true }
    ],
    primaryKey: { name: "pk", columns: ["id"] },
    foreignKeys: []
  };
  const selected = surface({ version: 1, relations: [relation], enums: [], exclusions: [] });
  assert.deepStrictEqual(selected.relations, [{ ...relation, columns: [relation.columns[0]] }]);
  assert.deepStrictEqual(selected.exclusions, [
    { schema: "public", relation: "places", column: "location", reason: "unsupported_type" }
  ]);
  assert.deepStrictEqual(surface(selected), selected);
  const unsupportedKey = surface({
    version: 1,
    relations: [{ ...relation, primaryKey: { name: "pk", columns: ["location"] } }],
    enums: [],
    exclusions: []
  });
  assert.isNull(unsupportedKey.relations[0]!.primaryKey);
});

it("quotes names and resolves domain-native types without executing catalog SQL", () => {
  const malicious = 'x"; DROP TABLE accounts; --';
  assert.strictEqual(quoteIdentifier(malicious), '"x""; DROP TABLE accounts; --"');
  assert.strictEqual(quoteLiteral("a'\\b"), "E'a''\\\\b'");
  const domain = {
    ...type("numeric"),
    schema: "sales",
    name: "amount",
    sql: 'numeric); DROP TABLE "accounts"; --'
  };
  const snapshot = { version: 1 as const, enums: [], exclusions: [], relations: [] };
  assert.strictEqual(nativeType(domain, snapshot), '"pg_catalog"."numeric"');
  assert.strictEqual(nativeType({ ...type("_point"), kind: "array" }, snapshot), undefined);
  assert.strictEqual(
    nativeType({ ...type("_int8"), kind: "array" }, snapshot),
    '"pg_catalog"."int8"[]'
  );
});

it("accepts only the source identity and fixture-native spelling for arrays of domains", () => {
  const snapshot = { version: 1 as const, enums: [], exclusions: [], relations: [] };
  const domainArray: typeof ColumnType.Type = {
    schema: "public",
    name: "_positive",
    sql: "positive[]",
    baseSchema: "public",
    baseName: "_positive",
    kind: "array",
    element: { baseSchema: "pg_catalog", baseName: "int4", kind: "base" }
  };
  assert.deepStrictEqual(acceptedSourceTypes(domainArray, snapshot), [
    '"public"."_positive"',
    '"pg_catalog"."int4"[]'
  ]);
  assert.deepStrictEqual(
    acceptedSourceTypes(
      { ...domainArray, name: "positive_array", sql: "positive_array" },
      snapshot
    ),
    ['"public"."positive_array"', '"pg_catalog"."int4"[]']
  );
  assert.deepStrictEqual(acceptedSourceTypes(type("int4"), snapshot), ['"pg_catalog"."int4"']);
});
