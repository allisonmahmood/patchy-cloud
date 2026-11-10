/**
 * What the UI rules read: the text of a string or template literal, as markup or as a page
 * script's source. A template's interpolations become one placeholder character each, so
 * `class="btn${x}"` still reads as the class `btn`, and a tag still ends at its `>`.
 */

/** Stands in for a template's `${…}`: never in markup, and not a class name's character. */
export const HOLE = "\u0000";

/** A literal's text, or `undefined` for a literal that isn't a string. */
export function literalText(node) {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : undefined;
  if (node.type === "TemplateLiteral")
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(HOLE);
  return undefined;
}

/** The class names in a class list, ignoring what an interpolation adds. */
export function classNames(list) {
  return list.split(new RegExp(`[\\s${HOLE}]+`, "u")).filter((name) => name !== "");
}

/** Every class list a literal's markup writes: `class="…"` attributes, quoted or not. */
export function classAttributes(text) {
  return [...text.matchAll(/(?<![\w-])class\s*=\s*(?:(["'])(.*?)\1|([^\s"'=<>`]+))/gsu)].map(
    (match) => match[2] ?? match[3]
  );
}

/** An element's attributes in order, each name with its value, quotes respected. */
const ATTRIBUTE = new RegExp(
  `([^\\s"'<>/=${HOLE}]+)(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+)))?`,
  "gu"
);

/** Whether an element's attributes make it an input of type hidden: a `type` whose whole value is `hidden`. */
export function isHidden(attributes) {
  return [...attributes.matchAll(ATTRIBUTE)].some(
    ([, name, double, single, bare]) =>
      name.toLowerCase() === "type" && (double ?? single ?? bare)?.toLowerCase() === "hidden"
  );
}

/** The property a member expression names, such as `className` in `el.className`. */
export function memberName(node) {
  if (node?.type !== "MemberExpression" || node.computed) return undefined;
  return node.property.type === "Identifier" ? node.property.name : undefined;
}
