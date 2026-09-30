import { expect, it } from "vitest";
import { CsvError, parse, records, stringify } from "./csv.js";

it("accepts exactly the character bound and refuses one more before parsing", () => {
  const text = "x".repeat(10_000_000);
  expect(parse(text)).toEqual([[text]]);
  expect(() => parse(text + '"')).toThrowError(
    expect.objectContaining({
      name: "CsvError",
      code: "limit_exceeded",
      limitId: "csv.characters",
      value: 10_000_000
    })
  );
});

it("counts cells across rows and stops before a later unterminated field", () => {
  const text = "a,b\n".repeat(500_000);
  const rows = parse(text);
  expect(rows).toHaveLength(500_000);
  expect(rows[499_999]).toEqual(["a", "b"]);
  expect(() => parse(text + 'c\n"unterminated')).toThrowError(
    expect.objectContaining({
      code: "limit_exceeded",
      limitId: "csv.cells",
      value: 1_000_000,
      line: 500_001
    })
  );
});

it("bounds one wide row as well as accumulated rows", () => {
  const text = ",".repeat(999_999);
  expect(parse(text)[0]).toHaveLength(1_000_000);
  expect(() => parse(text + ",")).toThrowError(
    expect.objectContaining({ code: "limit_exceeded", limitId: "csv.cells", line: 1 })
  );
  expect(() => parse(",".repeat(9_999_999))).toThrowError(
    expect.objectContaining({ code: "limit_exceeded", limitId: "csv.cells", line: 1 })
  );
});

it("counts headers and rejected record cells toward the same input bound", () => {
  const text = "name\n" + "a,b\n".repeat(500_000);
  expect(() => records(text)).toThrowError(
    expect.objectContaining({ code: "limit_exceeded", limitId: "csv.cells", line: 500_001 })
  );
});

it("does not count commas or doubled quotes within a quoted cell as more cells", () => {
  const commas = ",".repeat(1_000_000);
  expect(parse(`"${commas}""quoted"`)).toEqual([[`${commas}"quoted`]]);
});

it("reports the opening quote's physical line after an earlier multiline field", () => {
  for (const read of [parse, records]) {
    expect(() => read('name,notes\n"first\nsecond","not\nclosed')).toThrowError(
      expect.objectContaining({ code: "unterminated_quote", line: 3 })
    );
  }
});

it("keeps prototype-looking headers as ordinary own string values", () => {
  const result = records("__proto__,constructor,toString\nproto,ctor,string");
  expect(result.records).toEqual([
    { ["__proto__"]: "proto", constructor: "ctor", toString: "string" }
  ]);
  expect(Object.getPrototypeOf(result.records[0])).toBe(Object.prototype);
});

it("protects formulas even when a text cell contains line breaks", () => {
  const rows = [["=first\nsecond", "\rfirst\nsecond", -42]] as const;
  expect(parse(stringify(rows))).toEqual([["'=first\nsecond", "'\rfirst\nsecond", "-42"]]);
  expect(parse(stringify(rows, { formulaProtection: false }))).toEqual([
    ["=first\nsecond", "\rfirst\nsecond", "-42"]
  ]);
});

it("returns no partial records when a fatal quoted field follows valid records", () => {
  try {
    records('name\nAda\n"unfinished');
    throw new Error("Expected a CSV failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(CsvError);
    expect(error).toMatchObject({ code: "unterminated_quote", line: 3 });
  }
});
