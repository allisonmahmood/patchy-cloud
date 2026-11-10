/**
 * The repo's own lint rules: the Effect conventions and the UI system's rules a
 * linter can hold. Oxlint loads them as a JS plugin (`.oxlintrc.json`). Each
 * rule's header says what it holds and why; `rules.test.ts` proves each one
 * fails on what it exists to catch.
 */
import namespaceServiceImports from "./rules/namespace-service-imports.js";
import noHandDrawnComponents from "./rules/no-hand-drawn-components.js";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.js";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.js";
import noPageStyles from "./rules/no-page-styles.js";

export default {
  meta: { name: "patchy" },
  rules: {
    "namespace-service-imports": namespaceServiceImports,
    "no-hand-drawn-components": noHandDrawnComponents,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-page-styles": noPageStyles
  }
};
