import { parse, tokTypes } from "@babel/parser";
import type { Expression, Node, ObjectExpression } from "@babel/types";
import * as Schema from "effect/Schema";
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

/** Edit literal declarations by source range, retaining the author's expressions and comments. */
export function editUses(source: string, change: UsesChange): string {
  const refuse = (position: number, reason: string): never => {
    const line = source.slice(0, position).split(/\r\n|[\n\r\u2028\u2029]/).length;
    const sourceLine = source.split(/\r\n|[\n\r\u2028\u2029]/)[line - 1] ?? "";
    const instruction =
      change.kind === "add"
        ? `Add this line to uses, then run patchy refresh:\n${JSON.stringify(change.alias)}: ${JSON.stringify(change.declaration)},`
        : `Remove the ${JSON.stringify(change.alias)} declaration from uses, then run patchy refresh.`;
    throw new UsesEditRefused({ line, reason, sourceLine, instruction });
  };
  const file = (() => {
    try {
      const parsed = parse(source, {
        sourceType: "module",
        plugins: ["typescript", "decorators", "decoratorAutoAccessors"],
        createParenthesizedExpressions: true,
        tokens: true,
        errorRecovery: true
      });
      // TypeScript also permits legacy parameter decorators. Babel retains their AST
      // in standard decorator mode, but reports this diagnostic. Reject all other errors.
      const syntaxError = parsed.errors?.find(
        (error) => error.reasonCode !== "UnsupportedParameterDecorator"
      );
      if (syntaxError) throw syntaxError;
      return parsed;
    } catch (cause) {
      if (cause instanceof SyntaxError) {
        const position = "pos" in cause && typeof cause.pos === "number" ? cause.pos : 0;
        return refuse(position, "the config contains invalid TypeScript syntax.");
      }
      throw cause;
    }
  })();
  const unwrap = (node: Expression): Expression => {
    while (
      node.type === "ParenthesizedExpression" ||
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression"
    ) {
      node = node.expression;
    }
    return node;
  };
  const name = (node: Node): string | undefined =>
    node.type === "Identifier" ? node.name : node.type === "StringLiteral" ? node.value : undefined;
  const exports = file.program.body.filter((node) => node.type === "ExportDefaultDeclaration");
  if (exports.length > 1)
    refuse(exports[1]!.start!, "the config contains more than one default export.");
  const exported = exports[0];
  if (!exported) return refuse(0, "expected a default config export.");
  // Babel includes declaration forms in this union; only expressions can be configs.
  const declaration = exported.declaration;
  if (
    declaration.type === "FunctionDeclaration" ||
    declaration.type === "ClassDeclaration" ||
    declaration.type === "TSDeclareFunction"
  )
    return refuse(declaration.start!, "expected a default config export.");
  let expression = unwrap(declaration);
  if (expression.type === "Identifier") {
    const identifier = expression.name;
    const declarations = file.program.body
      .map((statement) =>
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
      )
      .filter((statement) => statement?.type === "VariableDeclaration")
      .flatMap((statement) => statement.declarations)
      .filter((entry) => entry.id.type === "Identifier" && entry.id.name === identifier);
    const local = declarations.length === 1 ? declarations[0] : undefined;
    if (!local?.init)
      return refuse(expression.start!, "the default config is not a local literal.");
    expression = unwrap(local.init);
  }
  if (expression.type === "CallExpression") {
    const builders = file.program.body
      .filter((statement) => statement.type === "ImportDeclaration")
      .filter((statement) => statement.source.value === "patchy/config")
      .flatMap((statement) => statement.specifiers)
      .filter(
        (binding) => binding.type === "ImportSpecifier" && name(binding.imported) === "defineConfig"
      )
      .map((binding) => binding.local.name);
    if (
      expression.callee.type !== "Identifier" ||
      !builders.includes(expression.callee.name) ||
      expression.arguments.length !== 1 ||
      expression.arguments[0]!.type === "SpreadElement" ||
      expression.arguments[0]!.type === "ArgumentPlaceholder"
    )
      return refuse(expression.start!, "expected defineConfig with one object literal.");
    expression = unwrap(expression.arguments[0]!);
  }
  if (expression.type !== "ObjectExpression")
    return refuse(expression.start!, "the config is not an object literal.");
  const config = expression;
  for (const property of config.properties) {
    if (property.type === "SpreadElement" || property.computed || name(property.key) === undefined)
      refuse(property.start!, "a spread or computed property can replace uses.");
  }
  const candidates = config.properties.filter(
    (property) => property.type !== "SpreadElement" && name(property.key) === "uses"
  );
  if (candidates.length > 1) refuse(candidates[1]!.start!, "uses is declared more than once.");
  const property = candidates[0];
  if (property && (property.type !== "ObjectProperty" || property.shorthand))
    return refuse(property.start!, "uses must be an object-literal property.");
  // An object expression cannot contain a destructuring pattern as a property value.
  const value = property ? unwrap(property.value as Expression) : undefined;
  if (value && value.type !== "ObjectExpression")
    return refuse(value.start!, "uses is not an object literal.");
  const uses = value;
  for (const entry of uses?.properties ?? []) {
    if (
      entry.type !== "ObjectProperty" ||
      entry.computed ||
      entry.shorthand ||
      name(entry.key) === undefined
    )
      refuse(entry.start!, "uses contains a spread, computed property, method or shorthand.");
  }
  const matches =
    uses?.properties.filter(
      (entry) => entry.type !== "SpreadElement" && name(entry.key) === change.alias
    ) ?? [];
  if (change.kind === "add" && matches.length)
    refuse(matches[0]!.start!, `alias ${JSON.stringify(change.alias)} already exists.`);
  if (change.kind === "remove" && matches.length !== 1)
    refuse(
      (uses ?? config).start!,
      `alias ${JSON.stringify(change.alias)} is absent or ambiguous.`
    );

  // Babel's token list also contains comments. Token identity excludes commas inside either
  // comments or literals; property boundaries exclude commas in nested expressions.
  const tokens: readonly {
    readonly type: unknown;
    readonly start: number;
    readonly end: number;
  }[] = file.tokens ?? [];
  const commas = tokens.filter((token) => token.type === tokTypes.comma);
  if (change.kind === "remove") {
    const target = matches[0]!;
    const index = uses!.properties.indexOf(target);
    const next = uses!.properties[index + 1];
    const previous = uses!.properties[index - 1];
    const after = commas.find(
      (token) => token.start >= target.end! && token.end <= (next?.start ?? uses!.end! - 1)
    );
    const before =
      previous &&
      commas.find((token) => token.start >= previous.end! && token.end <= target.start!);
    const comma = after ?? before;
    const ranges = [{ start: target.start!, end: target.end! }, ...(comma ? [comma] : [])].sort(
      (a, b) => b.start - a.start
    );
    let edited = source;
    for (const range of ranges) edited = edited.slice(0, range.start) + edited.slice(range.end);
    return edited;
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const append = (object: ObjectExpression, entry: string) => {
    const last = object.properties.at(-1);
    const offset = last?.end ?? object.start! + 1;
    const close = object.end! - 1;
    const trailingComma = commas.some((token) => token.start >= offset && token.end <= close);
    const separator = last && !trailingComma ? "," : "";
    const lineStart = source.lastIndexOf("\n", object.start!) + 1;
    const indent = /^[\t ]*/.exec(source.slice(lineStart))![0];
    return (
      source.slice(0, offset) +
      separator +
      source.slice(offset, close) +
      newline +
      indent +
      "  " +
      entry +
      "," +
      newline +
      indent +
      source.slice(close)
    );
  };
  const entry = `${JSON.stringify(change.alias)}: ${JSON.stringify(change.declaration)}`;
  return uses ? append(uses, entry) : append(config, `uses: { ${entry} }`);
}
