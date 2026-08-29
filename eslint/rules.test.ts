/**
 * Each rule against the shape it exists to catch and the shape it must let
 * through. Plain ESLint `RuleTester` on JavaScript sources: the rules read
 * ESTree, so TypeScript syntax adds nothing here.
 */
import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";
import namespaceServiceImports from "./rules/namespace-service-imports.js";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.js";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" }
});

tester.run("namespace-service-imports", namespaceServiceImports, {
  valid: [
    'import * as Effect from "effect/Effect";',
    'import * as Tokens from "./Tokens.js";',
    'import { PatchyApi, refuse } from "@patchy/api";',
    'import { migrations, Tokens } from "@patchy/auth";'
  ],
  invalid: [
    {
      code: 'import { Effect, Layer } from "effect";',
      errors: [{ messageId: "effectBarrel" }, { messageId: "effectBarrel" }]
    },
    {
      code: 'import { layer as tokens } from "./Tokens.js";',
      errors: [{ messageId: "serviceMember" }]
    },
    {
      code: 'import { make } from "@patchy/limits";',
      errors: [{ messageId: "serviceMember" }]
    }
  ]
});

tester.run("no-manual-effect-runtime-in-tests", noManualEffectRuntimeInTests, {
  valid: [
    { code: "Effect.runPromise(program);", filename: "src/start.ts" },
    { code: "it.effect(() => program);", filename: "src/Foo.test.ts" }
  ],
  invalid: [
    {
      code: "Effect.runSync(program);",
      filename: "src/Foo.test.ts",
      errors: [{ messageId: "manualRuntime" }]
    },
    {
      code: "const runtime = ManagedRuntime.make(layer);",
      filename: "src/Foo.spec.ts",
      errors: [{ messageId: "manualRuntime" }]
    }
  ]
});

tester.run("no-inline-schema-compile", noInlineSchemaCompile, {
  valid: [
    "const decode = Schema.decodeUnknownSync(Foo); const parse = (input) => decode(input);",
    "const decodeBody = (schema) => { const decode = Schema.decodeUnknownResult(schema); return decode; };",
    "const parse = (schema, input) => Schema.decodeUnknownSync(schema)(input);",
    {
      code: "const parse = (input) => Schema.decodeUnknownSync(Foo)(input);",
      filename: "src/Foo.test.ts"
    }
  ],
  invalid: [
    {
      code: "const parse = (input) => Schema.decodeUnknownSync(Foo)(input);",
      errors: [{ messageId: "hoist" }]
    },
    {
      code: "function parse(input) { return Schema.encodeSync(Wire.Foo)(input); }",
      errors: [{ messageId: "hoist" }]
    },
    {
      code: "const parse = (input) => Schema.decodeSync(Schema.Array(Foo))(input);",
      errors: [{ messageId: "hoist" }]
    }
  ]
});
