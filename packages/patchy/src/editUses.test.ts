import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import { editUses, UsesEditRefused, type UsesChange } from "./editUses.js";

const addition = {
  kind: "add",
  alias: "salesDb",
  declaration: { kind: "postgres", handle: "sales-db" }
} satisfies UsesChange;
const entry = '"salesDb": {"kind":"postgres","handle":"sales-db"}';
const valid = (source: string) => parse(source, { sourceType: "module", plugins: ["typescript"] });

it.each([
  "export default { uses: {} };",
  "const config = { uses: {} }; export default config;",
  "export const config = { uses: {} }; export default config;",
  'import { defineConfig } from "patchy/config"; export default defineConfig({ uses: {} });',
  'import { defineConfig as make } from "patchy/config"; export default make({ uses: {} });',
  'import { "defineConfig" as make } from "patchy/config"; export default make({ uses: {} });',
  "const config = (({ uses: (({} as const) satisfies object) }) as const); export default (config satisfies object);",
  String.raw`export default { "u\u0073es": {} };`
])("adds to supported config syntax: %s", (source) => {
  const edited = editUses(source, addition);
  expect(edited).toContain(entry);
  expect(() => valid(edited)).not.toThrow();
  expect(() => editUses(edited, { kind: "remove", alias: "salesDb" })).not.toThrow();
});

it.each([
  "function mark(value: typeof Helper) { return value; }\n@mark\nclass Helper {}\n",
  "class Helper { @mark method() {} }\n",
  "class Helper { method(@mark value: string) {} }\n",
  "@mark export class Helper {}\n",
  "export @mark class Helper {}\n",
  "class Helper { @mark accessor value = 1; }\n",
  "export @mark class Helper { constructor(@mark value: string) {} @mark accessor value = 1; }\n"
])("preserves standard and legacy decorated helpers: %s", (helper) => {
  const edited = editUses(helper + "export default { uses: {} };", addition);
  expect(edited.startsWith(helper)).toBe(true);
  expect(edited).toContain(entry);
  const removed = editUses(edited, { kind: "remove", alias: "salesDb" });
  expect(removed.startsWith(helper)).toBe(true);
  expect(removed).not.toContain(entry);
});

it.each([
  "export default {};",
  "export default { /* object comment */ };",
  "export default { tier: 1 // tier comment\n};",
  "export default { uses: {} };",
  "export default { uses: { /* empty comment */ } };",
  'export default { uses: { existing: postgres("x") } };',
  'export default { uses: { existing: postgres("x"), } };',
  'export default { uses: { existing: postgres("x") // existing comment\n} };',
  'export default { uses: { existing: postgres("x"), // existing comment\n} };',
  'export default { uses: { existing: postgres("x") /* , misleading comma */ } };'
])("inserts a declaration without losing comments or separators: %s", (source) => {
  const edited = editUses(source, addition);
  expect(edited).toContain(entry);
  for (const comment of source.match(/\/\*.*?\*\/|\/\/[^\n]*/g) ?? [])
    expect(edited).toContain(comment);
  if (source.includes('postgres("x")')) expect(edited).toContain('postgres("x")');
  expect(() => valid(edited)).not.toThrow();
});

it.each([
  ["target: pick(), other: keep()", " other: keep()"],
  ["before: keep(), target: pick(), after: keep()", "before: keep(),  after: keep()"],
  ["other: keep(), target: pick()", "other: keep() "],
  ["other: keep(), target: pick(),", "other: keep(), "],
  ["target: pick()", ""],
  ["target: pick(),", ""],
  [
    "/* before */ target: pick() /* after */, other: keep()",
    "/* before */  /* after */ other: keep()"
  ],
  [
    "other: keep(), /* before */ target: pick() // after\n",
    "other: keep() /* before */  // after\n"
  ],
  ['target: pick(",", /[,]/, `,${foo}`), other: keep()', " other: keep()"],
  [String.raw`"t\u0061rget": pick(), other: keep()`, " other: keep()"]
])("removes only the target and its separator: %s", (properties, remaining) => {
  const edited = editUses(`export default { uses: {${properties}} };`, {
    kind: "remove",
    alias: "target"
  });
  expect(edited).toBe(`export default { uses: {${remaining}} };`);
  expect(() => valid(edited)).not.toThrow();
});

it("preserves BOM, Unicode, CRLF, helper expressions and bytes outside uses", () => {
  const before =
    '\uFEFF// 😀 original\r\nimport { defineConfig as make, postgres } from "patchy/config";\r\nexport default make({\r\n  uses: ';
  const object = '{\r\n    other: postgres("line, \\"quoted\\""), // keep 😀\r\n  }';
  const after = " satisfies object,\r\n  tier: 1,\r\n});\r\n// end\r\n";
  const edited = editUses(before + object + after, addition);
  expect(edited.startsWith(before)).toBe(true);
  expect(edited.endsWith(after)).toBe(true);
  expect(edited).toContain('other: postgres("line, \\"quoted\\""), // keep 😀');
  expect(edited.replaceAll("\r\n", "")).not.toContain("\n");
  expect(() => valid(edited)).not.toThrow();
});

it.each([
  ["export const config = {};", "expected a default config export"],
  ["export default function config() {};", "expected a default config export"],
  ["import config from './config'; export default config;", "not a local literal"],
  ["export default make({ uses: {} });", "expected defineConfig"],
  [
    'import { defineConfig } from "patchy/config"; export default defineConfig({}, {});',
    "expected defineConfig"
  ],
  [
    'import { defineConfig } from "patchy/config"; export default defineConfig(...configs);',
    "expected defineConfig"
  ],
  ["export default { ...rest, uses: {} };", "spread or computed"],
  ["export default { ['uses']: {} };", "spread or computed"],
  ["export default { 1: null, uses: {} };", "spread or computed"],
  ["export default { uses: {}, uses: {} };", "more than once"],
  ["export default { uses };", "object-literal property"],
  ["export default { get uses() { return {}; } };", "object-literal property"],
  ["export default { uses: existing };", "not an object literal"],
  ["export default { uses: { ...existing } };", "spread, computed property, method or shorthand"],
  [
    "export default { uses: { ['other']: existing } };",
    "spread, computed property, method or shorthand"
  ],
  ["export default { uses: { other() {} } };", "spread, computed property, method or shorthand"],
  ["export default { uses: { other } };", "spread, computed property, method or shorthand"],
  [String.raw`export default { uses: { "s\u0061lesDb": {} } };`, "already exists"]
])("refuses unsafe config syntax: %s", (source, reason) => {
  expect(() => editUses(source, addition)).toThrow(UsesEditRefused);
  expect(() => editUses(source, addition)).toThrow(reason);
});

it.each(["export default {};", 'export default { uses: { target: {}, "target": {} } };'])(
  "refuses absent or ambiguous removals: %s",
  (source) => {
    expect(() => editUses(source, { kind: "remove", alias: "target" })).toThrow(
      "absent or ambiguous"
    );
  }
);

it("uses actual property keys rather than inherited object members", () => {
  const source =
    'export default { uses: { constructor: postgres("x"), toString: postgres("y") } };';
  const edited = editUses(source, { kind: "remove", alias: "constructor" });
  expect(edited).toBe('export default { uses: {  toString: postgres("y") } };');
  expect(editUses("export default { uses: {} };", { ...addition, alias: "constructor" })).toContain(
    '"constructor":'
  );
});

it("reports the exact refusal line and a copy-ready instruction after CRLF and Unicode", () => {
  const source =
    "\uFEFF// 😀\r\nexport default { uses: {\r\n  ...existing // author comment\r\n} };";
  try {
    editUses(source, addition);
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(UsesEditRefused);
    expect(error).toMatchObject({
      line: 3,
      sourceLine: "  ...existing // author comment",
      instruction: `Add this line to uses, then run patchy refresh:\n${entry},`
    });
  }
});

it.each([
  "export default { uses: {}",
  "export default { uses: { broken: , } };",
  "export default { uses: {} }; export default {};",
  "const value = 1; const value = 2; export default { uses: {} };",
  "class Helper { method(@mark value: string) {} } const value = 1; const value = 2; export default { uses: {} };"
])("refuses malformed source instead of editing a recovered AST: %s", (source) => {
  expect(() => editUses(source, addition)).toThrow(UsesEditRefused);
  expect(() => editUses(source, addition)).toThrow(
    /invalid TypeScript syntax|more than one default export/
  );
});
