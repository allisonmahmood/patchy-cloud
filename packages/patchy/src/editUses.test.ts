import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import { editUses, isUsesEditRefused, type UsesChange } from "./editUses.js";

const add = (alias: string): UsesChange => ({
  kind: "add",
  alias,
  declaration: { kind: "postgres", handle: "sales-db" }
});
const remove = (alias: string): UsesChange => ({ kind: "remove", alias });
const config = (uses: string) =>
  `import { defineConfig, members } from "patchy/config";\n\n` +
  `// Builder notes stay put.\n` +
  `export default defineConfig({\n  name: "notes",\n  tier: 1,\n  ${uses}\n});\n`;
const declaration = '"sales": { kind: "postgres", handle: "sales-db" }';

const layouts: ReadonlyArray<readonly [string, string, string]> = [
  ["an empty object", "uses: {}", `uses: { ${declaration} }`],
  [
    "a one-line object",
    "uses: { people: members() }",
    `uses: { people: members(), ${declaration} }`
  ],
  [
    "a one-line object with a trailing comma",
    "uses: { people: members(), }",
    `uses: { people: members(), ${declaration}, }`
  ],
  [
    "a multi-line object, keeping its comments and layout",
    "uses: {\n    // Everyone.\n    people: members(), // Kept.\n  }",
    `uses: {\n    // Everyone.\n    people: members(), // Kept.\n    ${declaration},\n  }`
  ],
  [
    "a multi-line object whose last comma follows a comment",
    "uses: {\n    people: members() /* Kept. */,\n  }",
    `uses: {\n    people: members() /* Kept. */,\n    ${declaration},\n  }`
  ],
  [
    "a multi-line object without a trailing comma",
    "uses: {\n    people: members() /* Kept. */\n  }",
    `uses: {\n    people: members(), /* Kept. */\n    ${declaration}\n  }`
  ],
  [
    "a multi-line object whose last entry's comment runs onto another line",
    "uses: {\n    people: members() /* Kept,\n       twice. */\n  }",
    `uses: {\n    people: members(), /* Kept,\n       twice. */\n    ${declaration}\n  }`
  ],
  [
    "a multi-line object whose last entry trails several comments",
    "uses: {\n    people: members(), /* First. */ // Second.\n  }",
    `uses: {\n    people: members(), /* First. */ // Second.\n    ${declaration},\n  }`
  ],
  [
    "a multi-line object whose last entry trails several block comments, without a comma",
    "uses: {\n    people: members() /* First. */ /* Second. */\n  }",
    `uses: {\n    people: members(), /* First. */ /* Second. */\n    ${declaration}\n  }`
  ],
  [
    "an empty object with an inline comment",
    "uses: { /* Nothing yet. */ }",
    `uses: { /* Nothing yet. */ ${declaration} }`
  ],
  [
    "an empty object that holds only comments",
    "uses: {\n    // Nothing yet.\n  }",
    `uses: {\n    // Nothing yet.\n    ${declaration}\n  }`
  ]
];

it.each(layouts)("adds a declaration to %s", (_, before, after) => {
  expect(editUses(config(before), add("sales"))).toBe(config(after));
});

it.each(
  layouts.flatMap(([name, before]) => [
    [`${name}, LF`, config(before)],
    [`${name}, CRLF`, config(before).replaceAll("\n", "\r\n")]
  ])
)("removes what it added to %s, byte for byte", (_, source) => {
  expect(editUses(editUses(source, add("sales")), remove("sales"))).toBe(source);
});

it("adds uses to a config without one, in the config's layout and line endings", () => {
  const source = config("files: {}").replaceAll("\n", "\r\n");
  expect(editUses(source, add("sales"))).toBe(
    config(`files: {},\n  uses: { ${declaration} }`).replaceAll("\n", "\r\n")
  );
});

it.each([
  [
    "the first of several",
    `uses: { sales: { kind: "postgres", handle: "sales-db" }, people: members() }`,
    "uses: { people: members() }"
  ],
  [
    "the last of several",
    `uses: {\n    people: members(),\n    sales: { kind: "postgres", handle: "sales-db" },\n  }`,
    "uses: {\n    people: members(),\n  }"
  ],
  ["the only one", `uses: { sales: { kind: "postgres", handle: "sales-db" } }`, "uses: {}"],
  [
    "one above an entry with its own comment, leaving the comment",
    `uses: {\n    sales: { kind: "postgres", handle: "sales-db" },\n    // Keep member access: the approval screen reads it.\n    people: members()\n  }`,
    "uses: {\n    // Keep member access: the approval screen reads it.\n    people: members()\n  }"
  ],
  [
    "the last, whose comment runs onto another line, leaving the previous one's comment",
    `uses: {\n    people: members(), // Keep this note.\n    sales: { kind: "postgres", handle: "sales-db" } /* removed entry\n       ending note */\n  }`,
    "uses: {\n    people: members() // Keep this note.\n  }"
  ],
  [
    "the last of a one-line object, leaving a comment between entries",
    `uses: { people: members(), /* Keep this note. */ sales: { kind: "postgres", handle: "sales-db" } }`,
    "uses: { people: members() /* Keep this note. */ }"
  ]
])("removes %s with one separator", (_, before, after) => {
  expect(editUses(config(before), remove("sales"))).toBe(config(after));
  const crlf = (text: string) => text.replaceAll("\n", "\r\n");
  expect(editUses(crlf(config(before)), remove("sales"))).toBe(crlf(config(after)));
});

it.each([
  [add("people"), "uses: { people: members() }", 7, 'alias "people" already exists.'],
  [remove("sales"), "uses: { people: members() }", 7, 'alias "sales" is absent or ambiguous.'],
  [add("sales"), "uses: { ...shared }", 7, "uses contains a spread"],
  [add("sales"), "uses: shared", 7, "uses is not an object literal."],
  [add("sales"), "uses: {", 8, "the config is not valid TypeScript."]
])("refuses %j on %s at the line it names", (change, uses, line, reason) => {
  const source = config(uses);
  let refusal: unknown;
  try {
    editUses(source, change);
  } catch (error) {
    refusal = error;
  }
  if (!isUsesEditRefused(refusal)) throw new Error("Expected a refusal.");
  expect(refusal.line).toBe(line);
  expect(refusal.reason).toContain(reason);
  expect(refusal.sourceLine).toBe(source.split("\n")[line - 1]);
});

it("follows a default export through a local, a satisfies and defineConfig's alias", () => {
  const source =
    `import { defineConfig as define } from "patchy/config";\n` +
    `const config = define({ name: "notes", tier: 1, uses: {} }) satisfies object;\n` +
    `export default config;\n`;
  expect(editUses(source, add("sales"))).toBe(
    source.replace("uses: {}", `uses: { ${declaration} }`)
  );
});

// Each fixture comment names the entry it belongs to; removing an entry may take only its own.
const entry = (alias: string) => `${alias}: { kind: "postgres", handle: "${alias}-db" }`;
const commented = [
  `uses: { ${entry("a")}, /* a b */ ${entry("b")}, /* b c */ ${entry("c")} }`,
  `uses: { /* a */ ${entry("a")}, ${entry("b")} /* b */ }`,
  `uses: {\n    ${entry("a")}, // a\n    ${entry("b")}, // b\n    ${entry("c")} // c\n  }`,
  `uses: {\n    // a\n    ${entry("a")},\n    // b\n    ${entry("b")},\n  }`,
  `uses: {\n    ${entry("a")} /* a\n       a */,\n    ${entry("b")} /* b\n       b */\n  }`,
  `uses: {\n    ${entry("a")}, ${entry("b")}, // b\n    ${entry("c")}\n  }`,
  `uses: {\n    ${entry("a")}, /* a */ // a\n    ${entry("b")} /* b */ /* b\n       b */\n  }`,
  `uses: { ${entry("a")} /* a */ /* a */ }`,
  `uses: {\n    ${entry("a")}\n    /* after a */\n  }`
];
const comments = (source: string) =>
  (parse(source, { sourceType: "module", plugins: ["typescript"] }).comments ?? []).map(
    (comment) => comment.value
  );
/** Each comment with the entry it follows, so an edit that moves one shows. */
const followed = (source: string) =>
  (parse(source, { sourceType: "module", plugins: ["typescript"] }).comments ?? []).map(
    (comment) =>
      `${comment.value} after ${[...source.slice(0, comment.start!).matchAll(/"?(\w+)"?: \{/g)].at(-1)?.[1]}`
  );

it.each(commented.flatMap((layout) => [config(layout), config(layout).replaceAll("\n", "\r\n")]))(
  "adding leaves comments with their entries, and removing any entry keeps the others' comments and undoes an add: %j",
  (source) => {
    expect(followed(editUses(source, add("sales")))).toEqual(followed(source));
    for (const alias of ["a", "b", "c"].filter((name) => source.includes(`${name}: {`))) {
      const removed = editUses(source, remove(alias));
      const lost = comments(source).filter((comment) => !comments(removed).includes(comment));
      expect(lost.filter((comment) => !comment.split(/\s+/).includes(alias))).toEqual([]);
      expect(editUses(editUses(removed, add("sales")), remove("sales"))).toBe(removed);
    }
  }
);
