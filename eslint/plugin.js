/**
 * The repo's own ESLint rules: the Effect conventions a linter can hold.
 * Each rule's header says what it holds and why; `rules.test.ts` proves each
 * one fails on what it exists to catch.
 */
import namespaceServiceImports from "./rules/namespace-service-imports.js";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.js";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.js";

export default {
  meta: { name: "patchy" },
  rules: {
    "namespace-service-imports": namespaceServiceImports,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests
  }
};
