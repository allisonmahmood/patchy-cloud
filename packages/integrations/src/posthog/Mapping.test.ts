import { assert, it } from "@effect/vitest";
import * as Mapping from "./Mapping.js";

it("parses types, ignoring labels, precisions, timezones and tuple field names", () => {
  assert.deepStrictEqual(Mapping.parse("Nullable(DateTime64(6, 'Europe/Berlin'))"), {
    name: "Nullable",
    args: [{ name: "DateTime64", args: [] }]
  });
  assert.deepStrictEqual(Mapping.parse("Tuple(day Date, `views count` UInt64)"), {
    name: "Tuple",
    args: [
      { name: "Date", args: [] },
      { name: "UInt64", args: [] }
    ]
  });
  assert.deepStrictEqual(Mapping.parse("Enum8('Decimal' = 1, 'it''s' = -2)"), {
    name: "Enum8",
    args: []
  });
  for (const broken of ["", "Array(", "Tuple(String,)", "Map(String, UInt8))", "'String'"])
    assert.isUndefined(Mapping.parse(broken), broken);
});

it("maps composites by the types inside them, not the words in their names", () => {
  const json = (type: string) => Mapping.compatible("json", Mapping.parse(type));
  assert.isTrue(json("Enum8('Decimal' = 1)"));
  assert.isTrue(json("Tuple(UInt64, Float64)"));
  assert.isTrue(json("Map(String, Array(Nullable(UInt64)))"));
  for (const refused of [
    "Array(AggregateFunction(uniq, String))",
    "Tuple(price Decimal(18, 2), name String)",
    "Map(String, Int128)",
    "Variant(UInt64, String)",
    "Dynamic"
  ])
    assert.isFalse(json(refused), refused);
  assert.isTrue(Mapping.compatible("text", Mapping.parse("Enum8('Decimal' = 1)")));
});

it("checks 64-bit integers where the type puts them, and nowhere else", () => {
  const value = (type: string, raw: unknown) => Mapping.value("json", Mapping.parse(type)!, raw);
  assert.deepStrictEqual(value("Tuple(UInt64, Float64)", [1, 1e20]), [1, 1e20]);
  assert.isUndefined(value("Tuple(UInt64, Float64)", [2 ** 53, 1]));
  assert.isUndefined(value("Map(String, Array(Nullable(Int64)))", { a: [1, null, 2 ** 60] }));
  assert.deepStrictEqual(value("Nested(id UInt64, score Float64)", [[1, 1e300]]), [[1, 1e300]]);
  assert.isUndefined(value("Nested(id UInt64, score Float64)", [{ id: 2 ** 54, score: 1 }]));
});
