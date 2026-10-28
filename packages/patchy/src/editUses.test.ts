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

it.each([
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
    "a multi-line object without a trailing comma",
    "uses: {\n    people: members() /* Kept. */\n  }",
    `uses: {\n    people: members(), /* Kept. */\n    ${declaration}\n  }`
  ]
])("adds a declaration to %s", (_, before, after) => {
  expect(editUses(config(before), add("sales"))).toBe(config(after));
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
  ["the only one", `uses: { sales: { kind: "postgres", handle: "sales-db" } }`, "uses: {}"]
])("removes %s with one separator", (_, before, after) => {
  expect(editUses(config(before), remove("sales"))).toBe(config(after));
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
