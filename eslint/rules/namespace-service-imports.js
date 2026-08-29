/**
 * Service modules are imported as namespaces, so a call site reads
 * `Tokens.layer` and `Tokens.Tokens` rather than an alias that has lost its
 * module: no named imports from the `effect` barrel (`import * as Effect from
 * "effect/Effect"` instead), and no `make` or `layer` picked out of a module
 * by name. The review spec in `.agents/skills/effect-service-conventions`
 * says the same; this is the part a linter can hold.
 */

const SERVICE_MEMBERS = new Set(["make", "layer"]);

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Import Effect modules from their subpaths and service modules as namespaces."
    },
    schema: [],
    messages: {
      effectBarrel:
        'Import Effect modules from their subpaths as namespaces: `import * as {{name}} from "effect/{{name}}"`.',
      serviceMember:
        "Import the module as a namespace and use `Module.{{name}}`; a service's `{{name}}` is not picked out by name."
    }
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier") continue;
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : String(specifier.imported.value);
          if (source === "effect") {
            context.report({
              node: specifier,
              messageId: "effectBarrel",
              data: { name: imported }
            });
          } else if (SERVICE_MEMBERS.has(imported)) {
            context.report({
              node: specifier,
              messageId: "serviceMember",
              data: { name: imported }
            });
          }
        }
      }
    };
  }
};
