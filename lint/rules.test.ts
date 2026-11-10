/**
 * Each rule against the shape it exists to catch and the shape it must let
 * through, on Oxlint's own parser and plugin runtime. Sources are JavaScript:
 * the rules read ESTree, so TypeScript syntax adds nothing here.
 */
import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import namespaceServiceImports from "./rules/namespace-service-imports.js";
import noHandDrawnComponents from "./rules/no-hand-drawn-components.js";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.js";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.js";
import noPageStyles from "./rules/no-page-styles.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { sourceType: "module" } });

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

tester.run("no-hand-drawn-components", noHandDrawnComponents, {
  valid: [
    // Core's helpers draw them; a page lays them out.
    'const html = `<div class="btn-group">${button("Save", { kind: "primary" })}</div>`;',
    // A hidden input is protocol, not a field.
    'const html = `<input type="hidden" name="back" value="${back}">`;',
    // The text parts of a field, and a group of them, aren't controls.
    'const html = `<div class="fieldset"><h3 class="field-label">People</h3></div>`;',
    // A script that swaps in a field's error leaves the control to core.
    'const script = `Object.assign(document.createElement("p"), { className: "field-error" })`;',
    'el.className = "row-main";',
    'const html = `<input type=\'hidden\' name="t"><input name="a" type=hidden>`;'
  ],
  invalid: [
    {
      code: 'const html = `<button class="btn btn-quiet" type="submit">Sign out</button>`;',
      errors: [{ messageId: "button" }]
    },
    {
      code: 'const html = `<a class="btn${primary ? " btn-primary" : ""}" href="/x">Open</a>`;',
      errors: [{ messageId: "button" }]
    },
    {
      code: "const html = '<span class=\"badge badge-danger\">Failed</span>';",
      errors: [{ messageId: "badge" }]
    },
    {
      code: 'const html = `<div class="note note-refused" role="alert">${text}</div>`;',
      errors: [{ messageId: "notice" }]
    },
    {
      code: 'const html = `<input class="field" name="q"><input type="${kind}" name="r">`;',
      errors: [{ messageId: "field" }]
    },
    { code: 'const html = `<select name="role"></select>`;', errors: [{ messageId: "field" }] },
    {
      // A page's script, held in a literal, drawing in the DOM.
      code: 'const script = `const b = document.createElement("button"); b.className = "btn";`;',
      errors: [{ messageId: "button" }]
    },
    {
      code: 'el.className = "btn btn-primary"; el.classList.add("badge"); document.createElement("textarea");',
      errors: [{ messageId: "button" }, { messageId: "badge" }, { messageId: "field" }]
    },
    {
      // A hidden-looking attribute that isn't the input's type, or a type that isn't hidden.
      code: 'const html = `<input data-type="hidden" name="password"><input type="hidden-extra" name="n">`;',
      errors: [{ messageId: "field" }]
    },
    {
      // Text inside another attribute is not the input's type.
      code: 'const html = `<input title="Use type=hidden for a token" name="password">`;',
      errors: [{ messageId: "field" }]
    },
    {
      code: 'el.className = `btn ${kind}`; el.setAttribute("class", "badge"); const html = `<span class=notice>x</span>`;',
      errors: [{ messageId: "button" }, { messageId: "badge" }, { messageId: "notice" }]
    },
    {
      code: 'const script = `el.setAttribute("class", "btn");`;',
      errors: [{ messageId: "button" }]
    }
  ]
});

tester.run("no-page-styles", noPageStyles, {
  valid: [
    'const html = `<div class="stack">${body}</div>`;',
    // A script's variable is not an attribute.
    "const script = `const style = 1;`;",
    'const html = `<a href="/styles">Styles</a>`;'
  ],
  invalid: [
    {
      code: "const html = `<style>.x { color: red }</style>`;",
      errors: [{ messageId: "element" }]
    },
    {
      code: 'const html = `<div class="x" style="margin: 0">${body}</div>`;',
      errors: [{ messageId: "attribute" }]
    },
    {
      code: 'const script = `el.style.display = "none";`;',
      errors: [{ messageId: "script" }]
    },
    { code: 'el.style.setProperty("--x", "1px");', errors: [{ messageId: "script" }] },
    { code: 'el.setAttribute("style", "color: red");', errors: [{ messageId: "script" }] },
    {
      code: 'const script = `el.setAttribute("style", "color: red");`;',
      errors: [{ messageId: "script" }]
    }
  ]
});
