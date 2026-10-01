import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import ts from "typescript";

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ devDependencies: Schema.Record(Schema.String, Schema.String) })
  )
);

/** Read the release from a managed archive pin, retaining unknown pins for diagnostics. */
export function releaseFromPin(pin: string) {
  return /(?:^|\/)patchy-([^/?#]+?)(?:-[a-f0-9]{64})?\.tgz(?:[?#].*)?$/.exec(pin)?.[1] ?? pin;
}

/** Edit one managed dependency without rewriting author-owned fields or formatting. */
export function patchPackagePin(
  source: string,
  name: "patchy" | "workerd",
  expected: string | undefined,
  replacementLiteral: string | undefined
) {
  const decoded = decode(source);
  if (Option.isNone(decoded) || decoded.value.devDependencies[name] !== expected) return undefined;
  const file = ts.parseJsonText("package.json", source);
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return undefined;
  const root = statement.expression;
  if (!ts.isObjectLiteralExpression(root)) return undefined;
  const dependencies = root.properties
    .filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        ts.isStringLiteral(property.name) &&
        property.name.text === "devDependencies"
    )
    .at(-1)?.initializer;
  if (!dependencies || !ts.isObjectLiteralExpression(dependencies)) return undefined;
  const matches = dependencies.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === name
  );
  // Removing an effective duplicate would expose an older unmanaged value.
  if (matches.length > 1) return undefined;
  const property = matches[0];
  if (!property) {
    if (replacementLiteral === undefined) return { contents: source, previousLiteral: undefined };
    const opening = dependencies.getStart(file) + 1;
    const first = dependencies.properties[0];
    const start = first?.getStart(file) ?? opening;
    const separator = first ? `,${source.slice(opening, start)}` : "";
    return {
      contents:
        source.slice(0, start) +
        `${JSON.stringify(name)}: ${replacementLiteral}${separator}` +
        source.slice(start),
      previousLiteral: undefined
    };
  }
  const node = property.initializer;
  if (!ts.isStringLiteral(node)) return undefined;
  const previousLiteral = source.slice(node.getStart(file), node.end);
  if (replacementLiteral !== undefined) {
    return {
      contents: source.slice(0, node.getStart(file)) + replacementLiteral + source.slice(node.end),
      previousLiteral
    };
  }
  const index = dependencies.properties.indexOf(property);
  const previous = dependencies.properties[index - 1];
  const next = dependencies.properties[index + 1];
  const start = previous ? previous.end : property.getStart(file);
  const end = !previous && next ? next.getStart(file) : property.end;
  return { contents: source.slice(0, start) + source.slice(end), previousLiteral };
}
