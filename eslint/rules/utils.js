/**
 * The few AST readings the rules share. ESTree with typescript-eslint's
 * TypeScript nodes, so an expression may sit behind `as`, `satisfies`, `!`
 * or a parenthesis; the rules look through those.
 */

const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ChainExpression"
]);

/** The expression under any TypeScript-only wrapper, or `undefined`. */
export function unwrapExpression(node) {
  let current = node;
  while (current && WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return current ?? undefined;
}

/** The name of `obj.name` or `obj["name"]`, or `undefined` for a computed key. */
export function getPropertyName(property, computed = false) {
  if (!property) return undefined;
  if (!computed && property.type === "Identifier") return property.name;
  if (property.type === "Literal" && typeof property.value === "string") return property.value;
  return undefined;
}

/** Whether the node is the identifier `name`. */
export function isIdentifier(node, name) {
  const expression = unwrapExpression(node);
  return expression?.type === "Identifier" && expression.name === name;
}

/** `Object.method` for a callee of that shape, or `undefined`. */
export function memberCall(callee) {
  const expression = unwrapExpression(callee);
  if (expression?.type !== "MemberExpression") return undefined;
  const object = unwrapExpression(expression.object);
  const property = getPropertyName(expression.property, expression.computed);
  if (object?.type !== "Identifier" || property === undefined) return undefined;
  return { object: object.name, property };
}
