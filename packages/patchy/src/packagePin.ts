import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import ts from "typescript";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ devDependencies: Schema.Struct({ patchy: Schema.String }) })
  )
);

/** Replace only the effective pin literal; refuse a changed pin or unfinished author edit. */
export function patchPackagePin(source: string, expected: string, replacementLiteral: string) {
  const decoded = decode(source);
  if (Option.isNone(decoded) || decoded.value.devDependencies.patchy !== expected) return undefined;
  const file = ts.parseJsonText("package.json", source);
  const statement = file.statements[0];
  let node: ts.Expression | undefined =
    statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
  for (const key of ["devDependencies", "patchy"]) {
    if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
    let value: ts.Expression | undefined;
    for (const property of node.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isStringLiteral(property.name) &&
        property.name.text === key
      )
        value = property.initializer;
    }
    node = value;
  }
  if (!node || !ts.isStringLiteral(node)) return undefined;
  const start = node.getStart(file);
  return {
    contents: source.slice(0, start) + replacementLiteral + source.slice(node.end),
    previousLiteral: source.slice(start, node.end)
  };
}
