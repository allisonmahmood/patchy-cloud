/**
 * The repo's own ESLint rules: the Effect conventions a linter can hold.
 * Each rule's header says what it holds and why; `rules.test.ts` proves each
 * one fails on what it exists to catch.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import namespaceServiceImports from "./rules/namespace-service-imports.js";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.js";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.js";

// `pnpm lint --cache` keys on the plugin's name and version, not its code, so
// the version fingerprints the rule sources: editing a rule relints every file.
const rules = new URL("./rules/", import.meta.url);
const sources = readdirSync(rules)
  .filter((file) => file.endsWith(".js"))
  .sort()
  .map((file) => readFileSync(new URL(file, rules), "utf8"));
const version = createHash("sha256").update(sources.join("\n")).digest("hex").slice(0, 12);

export default {
  meta: { name: "patchy", version },
  rules: {
    "namespace-service-imports": namespaceServiceImports,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests
  }
};
