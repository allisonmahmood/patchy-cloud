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

it.each([
  {
    name: "BOM and CRLF preserve numeric, boolean, and date-looking strings",
    actual: () => parse("﻿code,active,amount,date\r\n0007,true,1.50,2026-09-30\r\n"),
    expected: [
      ["code", "active", "amount", "date"],
      ["0007", "true", "1.50", "2026-09-30"]
    ]
  },
  {
    name: "LF, escaped quotes, commas, and whitespace remain exact",
    actual: () => parse('name,notes\n" Ada ","say ""hello"", friend"\n'),
    expected: [
      ["name", "notes"],
      [" Ada ", 'say "hello", friend']
    ]
  },
  {
    name: "quoted multiline fields preserve CRLF and LF including blank physical lines",
    actual: () => parse('name,notes\r\nAda,"first\r\n\r\nthird\nlast"\nBob,done\r\n'),
    expected: [
      ["name", "notes"],
      ["Ada", "first\r\n\r\nthird\nlast"],
      ["Bob", "done"]
    ]
  },
  {
    name: "only empty physical lines disappear from parsed rows",
    actual: () => parse('\n\r\n \n""\n,\n\n'),
    expected: [[" "], [""], ["", ""]]
  },
  {
    name: "a later BOM is cell text, not an encoding marker",
    actual: () => parse("﻿name\n﻿Ada"),
    expected: [["name"], ["﻿Ada"]]
  },
  {
    name: "record headers skip blank lines but retain whitespace and quoted empty values",
    actual: () => records('\nname\r\n\r\n \r\n""\r\nAda\r\n'),
    expected: {
      headers: ["name"],
      records: [{ name: " " }, { name: "" }, { name: "Ada" }],
      errors: []
    }
  },
  {
    name: "wrong-width records report physical starts after multiline and blank rows without padding",
    actual: () =>
      records('﻿name,note\r\nAda,"one\r\ntwo"\r\n\r\nshort\r\nextra,a,b\r\n,\r\nBob,ok\r\n'),
    expected: {
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
  },
  {
    name: "formula-leading text is protected while numbers remain numbers in the CSV",
    actual: () =>
      stringify([
        ["=SUM(A1)", "+1", "-2", "@x", "\tcmd", "\rcmd", -42, 3.5],
        ["=first\nsecond", "plain"]
      ]),
    expected:
      '"\'=SUM(A1)","\'+1","\'-2","\'@x","\'\tcmd","\'\rcmd",-42,3.5\r\n"\'=first\nsecond",plain'
  },
  {
    name: "formula protection can be disabled without disabling CSV quoting",
    actual: () =>
      stringify([["=1", "+2", "-3", "@x", "\tcmd", "\rcmd", -4]], { formulaProtection: false }),
    expected: '=1,+2,-3,@x,\tcmd,"\rcmd",-4'
  },
  {
    name: "export escapes quotes and commas, writes CRLF, and retains empty one-cell rows",
    actual: () => stringify([['say "hi", friend', "line\nnext"], [""]]),
    expected: '"say ""hi"", friend","line\nnext"\r\n""'
  }
])("$name", ({ actual, expected }) => {
  expect(actual()).toEqual(expected);
});

it.each([
  {
    name: "duplicate decoded headers fail rather than getting renamed",
    read: () => records('\nname,"name"\nAda,Bob'),
    error: { code: "duplicate_header", line: 2 }
  },
  ...[parse, records].flatMap((read) =>
    [
      { text: 'x,"a" \r\ny', line: 1, ending: "CRLF" },
      { text: '"a"\t\nnext', line: 1, ending: "LF" },
      { text: '"a"  ', line: 1, ending: "EOF" },
      { text: '"a" ,b', line: 1, ending: "comma" },
      { text: 'name\n"first\nsecond"\t', line: 2, ending: "multiline EOF" }
    ].map(({ text, line, ending }) => ({
      name: `${read === parse ? "parse" : "records"} rejects whitespace outside a closed quote before ${ending}`,
      read: () => read(text),
      error: { code: "invalid_quotes", line }
    }))
  )
])("$name", ({ read, error }) => {
  expect(read).toThrowError(expect.objectContaining({ name: "CsvError", ...error }));
});
