import { parse } from "@babel/parser";
import type { Node, ObjectExpression, ObjectMethod, ObjectProperty } from "@babel/types";
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

// Babel's syntax errors carry the line they stopped at.
const isLocatedSyntaxError = Schema.is(Schema.Struct({ loc: Schema.Struct({ line: Schema.Int }) }));

// The line terminators JavaScript, and so Babel's line numbers, count.
const lineBreak = /\r\n|[\n\r\u2028\u2029]/;

/** A parsed node's source offsets; Babel records them on every node it parses. */
const span = (node: Node) => ({ start: node.start!, end: node.end! });

/** A property's name, or `undefined` for a computed or numeric key. */
const keyName = (property: ObjectProperty | ObjectMethod) =>
  property.computed
    ? undefined
    : property.key.type === "Identifier"
      ? property.key.name
      : property.key.type === "StringLiteral"
        ? property.key.value
        : undefined;

const unwrap = (node: Node): Node => {
  while (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    node = node.expression;
  }
  return node;
};

/**
 * Edit only the literal uses object, one property at a time, so the rest of the user's config,
 * its imports, comments and layout, stay byte for byte.
 */
export function editUses(source: string, change: UsesChange): string {
  const refuse = (line: number, reason: string): never => {
    const instruction =
      change.kind === "add"
        ? `Add this line to uses, then run patchy refresh:\n${JSON.stringify(change.alias)}: ${JSON.stringify(change.declaration)},`
        : `Remove the ${JSON.stringify(change.alias)} declaration from uses, then run patchy refresh.`;
    const sourceLine = source.split(lineBreak)[line - 1] ?? "";
    throw new UsesEditRefused({ line, reason, sourceLine, instruction });
  };
  const refuseAt = (node: Node, reason: string): never => refuse(node.loc!.start.line, reason);
  const file = (() => {
    try {
      return parse(source, { sourceType: "module", plugins: ["typescript"] });
    } catch (cause) {
      if (isLocatedSyntaxError(cause))
        return refuse(cause.loc.line, "the config is not valid TypeScript.");
      throw cause;
    }
  })();
  const body = file.program.body;
  const exported = body.find((statement) => statement.type === "ExportDefaultDeclaration");
  if (
    !exported ||
    exported.declaration.type === "FunctionDeclaration" ||
    exported.declaration.type === "ClassDeclaration"
  )
    return refuseAt(exported ?? file.program, "expected a default config export.");
  let expression = unwrap(exported.declaration);
  if (expression.type === "Identifier") {
    const identifier = expression.name;
    const declarations = body
      .map((statement) =>
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
      )
      .filter((statement) => statement?.type === "VariableDeclaration")
      .flatMap((statement) => statement.declarations)
      .filter(
        (declaration) => declaration.id.type === "Identifier" && declaration.id.name === identifier
      );
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (!declaration?.init)
      return refuseAt(expression, "the default config is not a local literal.");
    expression = unwrap(declaration.init);
  }
  if (expression.type === "CallExpression") {
    const builders = body.flatMap((statement) =>
      statement.type === "ImportDeclaration" && statement.source.value === "patchy/config"
        ? statement.specifiers.flatMap((binding) =>
            binding.type === "ImportSpecifier" &&
            (binding.imported.type === "Identifier"
              ? binding.imported.name
              : binding.imported.value) === "defineConfig"
              ? [binding.local.name]
              : []
          )
        : []
    );
    const [argument] = expression.arguments;
    if (
      expression.callee.type !== "Identifier" ||
      !builders.includes(expression.callee.name) ||
      expression.arguments.length !== 1 ||
      !argument
    )
      return refuseAt(expression, "expected defineConfig with one object literal.");
    expression = unwrap(argument);
  }
  if (expression.type !== "ObjectExpression")
    return refuseAt(expression, "the config is not an object literal.");
  const config = expression;
  for (const property of config.properties) {
    if (property.type === "SpreadElement" || keyName(property) === undefined)
      refuseAt(property, "a spread or computed property can replace uses.");
  }
  const candidates = config.properties.filter(
    (property) => property.type !== "SpreadElement" && keyName(property) === "uses"
  );
  if (candidates.length > 1) refuseAt(candidates[1]!, "uses is declared more than once.");
  const property = candidates[0];
  if (property && (property.type !== "ObjectProperty" || property.shorthand))
    return refuseAt(property, "uses must be an object-literal property.");
  const value = property ? unwrap(property.value) : undefined;
  if (value && value.type !== "ObjectExpression")
    return refuseAt(value, "uses is not an object literal.");
  const uses = value;
  const entries = (uses?.properties ?? []).map((entry) =>
    entry.type !== "ObjectProperty" || entry.shorthand || keyName(entry) === undefined
      ? refuseAt(entry, "uses contains a spread, computed property, method or shorthand.")
      : entry
  );
  const matches = entries.filter((entry) => keyName(entry) === change.alias);
  if (change.kind === "add" && matches.length)
    refuseAt(matches[0]!, `alias ${JSON.stringify(change.alias)} already exists.`);
  if (change.kind === "remove" && matches.length !== 1)
    refuseAt(uses ?? config, `alias ${JSON.stringify(change.alias)} is absent or ambiguous.`);

  const replace = (start: number, end: number, text: string) =>
    source.slice(0, start) + text + source.slice(end);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lineStart = (offset: number) =>
    Math.max(...["\n", "\r"].map((terminator) => source.lastIndexOf(terminator, offset - 1))) + 1;
  /** The rest of the line from `offset`, up to its line break. */
  const restOfLine = (offset: number) => source.slice(offset).split(lineBreak)[0]!;
  /** Where the separator after `offset` ends, when one follows before `limit`, past comments. */
  const commaAfter = (offset: number, limit: number) => {
    const comma = /^(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[^]*?\*\/)*,/.exec(
      source.slice(offset, limit)
    );
    return comma ? offset + comma[0].length : undefined;
  };
  const onlyComment = /^[ \t]*(?:\/\/.*|\/\*.*\*\/[ \t]*)?$/;
  if (change.kind === "remove") {
    const removed = matches[0]!;
    const index = entries.indexOf(removed);
    const previous = entries[index - 1];
    const next = entries[index + 1];
    const object = span(uses!);
    const { start, end } = span(removed);
    const comma = commaAfter(end, next ? span(next).start : object.end - 1);
    const after = comma ?? end;
    const separatorBefore = previous ? commaAfter(span(previous).end, start) : undefined;
    // An entry on lines of its own goes with them, and with a comment ending its last line. The
    // comments on other lines belong to the entries beside them and stay.
    if (
      source.slice(lineStart(start), start).trim() === "" &&
      onlyComment.test(restOfLine(after))
    ) {
      const lineEnd = after + restOfLine(after).length;
      const breakEnd = source.startsWith("\r\n", lineEnd) ? lineEnd + 2 : lineEnd + 1;
      const edited = replace(lineStart(start), breakEnd, "");
      // A last entry without its own trailing comma leaves the previous one's trailing; it goes,
      // so the object keeps its style.
      return !next && comma === undefined && separatorBefore !== undefined
        ? edited.slice(0, separatorBefore - 1) + edited.slice(separatorBefore)
        : edited;
    }
    if (next) return replace(start, after + /^[ \t]*/.exec(source.slice(after))![0].length, "");
    if (separatorBefore !== undefined) return replace(separatorBefore - 1, end, "");
    const edited = replace(start, after, "");
    const inner = edited.slice(object.start + 1, object.end - 1 - (after - start));
    return inner.trim() === "" ? replace(object.start, object.end, "{}") : edited;
  }
  /** Insert a property after the object's last one, in the object's own layout. */
  const insert = (object: ObjectExpression, text: string) => {
    const { start, end } = span(object);
    const first = object.properties[0];
    const last = object.properties.at(-1);
    if (!first || !last) {
      const inner = source.slice(start + 1, end - 1).trimEnd();
      if (inner.trim() === "") return replace(start, end, `{ ${text} }`);
      // An empty object's comments stay; the entry follows them, indented like the last.
      const at = start + 1 + inner.length;
      if (!lineBreak.test(inner)) return replace(at, at, ` ${text}`);
      const indent = /^[ \t]*/.exec(inner.split(lineBreak).at(-1)!)![0];
      return replace(at, at, `${newline}${indent}${text}`);
    }
    const after = span(last).end;
    // The separator may sit behind comments that belong to the last property.
    const comma = commaAfter(after, end - 1);
    const at = comma ?? after;
    const [separator, closing] = comma ? ["", ","] : [",", ""];
    if (!lineBreak.test(source.slice(start, span(first).start)))
      return replace(at, at, `${separator} ${text}${closing}`);
    // Indent like the line the last property starts on.
    const indent = /^[ \t]*/.exec(source.slice(lineStart(span(last).start)))![0];
    // A comment that ends the last property's line stays on that line.
    const rest = restOfLine(at);
    const line = rest.trim() !== "" && onlyComment.test(rest) ? at + rest.length : at;
    return (
      source.slice(0, after) +
      separator +
      source.slice(after, line) +
      `${newline}${indent}${text}${closing}` +
      source.slice(line)
    );
  };
  // Literal declarations need no second managed edit to the user's imports.
  const fields = Object.entries(change.declaration).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`
  );
  const declaration = `${JSON.stringify(change.alias)}: { ${fields.join(", ")} }`;
  return uses ? insert(uses, declaration) : insert(config, `uses: { ${declaration} }`);
}
