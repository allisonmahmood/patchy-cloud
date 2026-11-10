/**
 * A page draws buttons, badges, notices and fields with core's helpers, never by hand: those
 * helpers carry the anatomy the system promises (a field's label, hint and error tied to its
 * control, a notice's role, a button's pending state), and a hand-written copy drifts from them.
 * It reads string and template literals as markup, and the class names and elements a page's
 * script gives the DOM. A hidden input is protocol, not a field. Core, which owns the helpers,
 * is outside it (`.oxlintrc.json` says where it runs and what it leaves out).
 */
import { classAttributes, classNames, isHidden, literalText, memberName } from "./markup.js";

/** Each component's class names, and the element a script would create for it. */
const KINDS = {
  button: { classes: new Set(["btn"]), elements: new Set(["button"]) },
  badge: { classes: new Set(["badge", "pill", "tag"]), elements: new Set() },
  notice: { classes: new Set(["notice", "note", "receipt", "refusal"]), elements: new Set() },
  field: {
    classes: new Set(["field", "field-group"]),
    elements: new Set(["input", "select", "textarea"])
  }
};

const byClass = (names) =>
  Object.entries(KINDS)
    .filter(([, kind]) => names.some((name) => kind.classes.has(name)))
    .map(([name]) => name);

const byElement = (element) =>
  Object.entries(KINDS)
    .filter(([, kind]) => kind.elements.has(element.toLowerCase()))
    .map(([name]) => name);

/** What a literal's markup, or the page script it holds, draws by hand. */
function drawnIn(text) {
  const found = [];
  if (/<button\b/iu.test(text)) found.push("button");
  if (/<(select|textarea)\b/iu.test(text)) found.push("field");
  for (const [, attributes] of text.matchAll(/<input\b([^>]*)>?/giu))
    if (!isHidden(attributes)) found.push("field");
  for (const list of classAttributes(text)) found.push(...byClass(classNames(list)));
  // A page's script, held in a literal, drawing in the DOM.
  for (const [, element] of text.matchAll(
    /createElement\(\s*["'`](button|input|select|textarea)["'`]/giu
  ))
    found.push(...byElement(element));
  for (const [, list] of text.matchAll(/\bclassName\s*[:=]\s*["'`]([^"'`]*)["'`]/gu))
    found.push(...byClass(classNames(list)));
  for (const [, list] of text.matchAll(
    /\bsetAttribute\(\s*["'`]class["'`]\s*,\s*["'`]([^"'`]*)["'`]/gu
  ))
    found.push(...byClass(classNames(list)));
  for (const [, args] of text.matchAll(/\bclassList\.(?:add|toggle|replace)\(([^)]*)\)/gu))
    found.push(...byClass([...args.matchAll(/["'`]([^"'`]*)["'`]/gu)].map((match) => match[1])));
  return found;
}

/**
 * What a string or template drawn by real code gives the DOM: `el.className = "btn"`,
 * `` el.className = `btn ${kind}` ``, `el.setAttribute("class", "badge")`, `createElement("input")`.
 */
function drawnBy(node, text) {
  const parent = node.parent;
  if (parent?.type === "AssignmentExpression" && memberName(parent.left) === "className")
    return byClass(classNames(text));
  if (
    parent?.type === "Property" &&
    parent.value === node &&
    parent.key.type === "Identifier" &&
    parent.key.name === "className"
  )
    return byClass(classNames(text));
  if (parent?.type === "CallExpression" && parent.arguments.includes(node)) {
    const method = memberName(parent.callee);
    const [first, second] = parent.arguments;
    if (method === "createElement" && first === node) return byElement(text);
    if (method === "setAttribute" && second === node && literalText(first) === "class")
      return byClass(classNames(text));
    if (
      (method === "add" || method === "toggle" || method === "replace") &&
      memberName(parent.callee.object) === "classList"
    )
      return byClass(classNames(text));
  }
  return [];
}

/** @type {import("@oxlint/plugins").Rule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Draw buttons, badges, notices and fields with core's helpers, never by hand."
    },
    schema: [],
    messages: {
      button: "Draw a button with core's `button`, `linkButton` or `iconButton`, not by hand.",
      badge: "Draw a badge with core's `badge` or `dot`, not by hand.",
      notice: "Draw a notice with core's `notice`, `receipt` or `refusal`, not by hand.",
      field:
        "Draw a field with core's `field` and its controls (`input`, `select`, `textarea`, `prefixInput` …), not by hand. A hidden protocol input is fine."
    }
  },
  create(context) {
    const report = (node, kinds) => {
      for (const messageId of new Set(kinds)) context.report({ node, messageId });
    };
    return {
      Literal(node) {
        const text = literalText(node);
        if (text !== undefined) report(node, [...drawnIn(text), ...drawnBy(node, text)]);
      },
      TemplateLiteral(node) {
        const text = literalText(node);
        report(node, [...drawnIn(text), ...drawnBy(node, text)]);
      }
    };
  }
};
