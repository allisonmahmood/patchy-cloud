import * as Schema from "effect/Schema";
import ts from "typescript";
import type { Declaration } from "./config.js";

export type UsesChange =
  | { readonly kind: "add"; readonly alias: string; readonly declaration: Declaration }
  | { readonly kind: "remove"; readonly alias: string };

export class UsesEditRefused extends Schema.TaggedError<UsesEditRefused>()("UsesEditRefused", {
  line: Schema.Int,
  reason: Schema.String,
  sourceLine: Schema.String,
  instruction: Schema.String
}) {
  override get message() {
    return `Cannot edit patchy.config.ts:${this.line}: ${this.reason}\n${this.sourceLine}\n${this.instruction}`;
  }
}

export const isUsesEditRefused = Schema.is(UsesEditRefused);

/** Edit only the literal uses object; leave imports and the rest of the user's config untouched. */
export function editUses(source: string, change: UsesChange): string {
  const file = ts.createSourceFile(
    "patchy.config.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const refuse = (node: ts.Node, reason: string): never => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    const exact = source.split(/\r?\n/)[line] ?? "";
    const instruction =
      change.kind === "add"
        ? `Add this line to uses, then run patchy refresh:\n${JSON.stringify(change.alias)}: ${JSON.stringify(change.declaration)},`
        : `Remove the ${JSON.stringify(change.alias)} declaration from uses, then run patchy refresh.`;
    throw new UsesEditRefused({ line: line + 1, reason, sourceLine: exact, instruction });
  };
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      node = node.expression;
    }
    return node;
  };
  const name = (node: ts.PropertyName): string | undefined =>
    ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
  const exported = file.statements.find(ts.isExportAssignment);
  if (!exported || exported.isExportEquals)
    return refuse(file, "expected a default config export.");
  let expression = unwrap(exported.expression);
  if (ts.isIdentifier(expression)) {
    const identifier = expression.text;
    const declarations = file.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .filter(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === identifier
      );
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (!declaration?.initializer)
      return refuse(expression, "the default config is not a local literal.");
    expression = unwrap(declaration.initializer);
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    const builders = file.statements.filter(ts.isImportDeclaration).flatMap((statement) => {
      if (
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "patchy/config"
      )
        return [];
      const bindings = statement.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements
            .filter((binding) => (binding.propertyName ?? binding.name).text === "defineConfig")
            .map((binding) => binding.name.text)
        : [];
    });
    if (
      !ts.isIdentifier(callee) ||
      !builders.includes(callee.text) ||
      expression.arguments.length !== 1
    ) {
      refuse(expression, "expected defineConfig with one object literal.");
    }
    expression = unwrap(expression.arguments[0]!);
  }
  if (!ts.isObjectLiteralExpression(expression))
    return refuse(expression, "the config is not an object literal.");
  const config = expression;
  for (const property of config.properties) {
    if (ts.isSpreadAssignment(property) || (property.name && name(property.name) === undefined)) {
      refuse(property, "a spread or computed property can replace uses.");
    }
  }
  const candidates = config.properties.filter(
    (property) => property.name && name(property.name) === "uses"
  );
  if (candidates.length > 1) refuse(candidates[1]!, "uses is declared more than once.");
  const property = candidates[0];
  if (property && !ts.isPropertyAssignment(property))
    return refuse(property, "uses must be an object-literal property.");
  const value = property ? unwrap(property.initializer) : undefined;
  if (value && !ts.isObjectLiteralExpression(value))
    return refuse(value, "uses is not an object literal.");
  const uses = value;
  for (const entry of uses?.properties ?? []) {
    if (!ts.isPropertyAssignment(entry) || name(entry.name) === undefined) {
      refuse(entry, "uses contains a spread, computed property, method or shorthand.");
    }
  }
  const matches =
    uses?.properties.filter((entry) => entry.name && name(entry.name) === change.alias) ?? [];
  if (change.kind === "add" && matches.length)
    refuse(matches[0]!, `alias ${JSON.stringify(change.alias)} already exists.`);
  if (change.kind === "remove" && matches.length !== 1)
    refuse(uses ?? config, `alias ${JSON.stringify(change.alias)} is absent or ambiguous.`);
  const factory = ts.factory;
  const entries = [...(uses?.properties ?? [])].filter(
    (entry) => change.kind !== "remove" || entry !== matches[0]
  );
  if (change.kind === "add") {
    // Literal declarations need no second managed edit to the user's imports.
    const declaration = factory.createObjectLiteralExpression(
      Object.entries(change.declaration).map(([key, value]) =>
        factory.createPropertyAssignment(key, factory.createStringLiteral(value))
      )
    );
    entries.push(
      factory.createPropertyAssignment(factory.createStringLiteral(change.alias), declaration)
    );
  }
  const printer = ts.createPrinter({
    newLine: source.includes("\r\n")
      ? ts.NewLineKind.CarriageReturnLineFeed
      : ts.NewLineKind.LineFeed
  });
  const updated = uses
    ? factory.updateObjectLiteralExpression(uses, entries)
    : factory.createObjectLiteralExpression(entries, true);
  if (uses) {
    return (
      source.slice(0, uses.getStart(file)) +
      printer.printNode(ts.EmitHint.Expression, updated, file) +
      source.slice(uses.end)
    );
  }
  const insertion = factory.createPropertyAssignment("uses", updated);
  const last = config.properties.at(-1);
  const offset = last?.end ?? config.getStart(file) + 1;
  const separator = last && !config.properties.hasTrailingComma ? "," : "";
  const gap = source.slice(offset, config.end - 1);
  return (
    source.slice(0, offset) +
    separator +
    gap +
    "\n" +
    printer.printNode(ts.EmitHint.Unspecified, insertion, file) +
    "\n" +
    source.slice(config.end - 1)
  );
}
