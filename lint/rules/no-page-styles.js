/**
 * A page fills a template's slots; the app's stylesheet draws it. So a page writes no `<style>`,
 * no `style` attribute, and its script sets no inline style: a page that styles itself drifts
 * from the system where no check sees it, and `pageResponse` takes no styles for the same reason.
 * It reads string and template literals as markup and as the source of a page's script, and real
 * code that reaches for an element's `style`. Core, which owns the stylesheet, is outside it, and
 * so is the served wrapper's own `<style>` (`.oxlintrc.json` says where it runs).
 */
import { literalText, memberName } from "./markup.js";

const STYLED = [
  { pattern: /<style\b/iu, messageId: "element" },
  // An attribute inside a tag, not a script's variable of the same name.
  { pattern: /<[a-z][^<>]*?\sstyle\s*=/iu, messageId: "attribute" },
  {
    pattern: /\.style\s*(\.|=|\[)|\.cssText\b|setAttribute\(\s*["'`]style["'`]/u,
    messageId: "script"
  }
];

/** @type {import("@oxlint/plugins").Rule} */
export default {
  meta: {
    type: "problem",
    docs: { description: "Pages carry no styles of their own." },
    schema: [],
    messages: {
      element: "A page writes no `<style>`: compose core's templates and helpers instead.",
      attribute: "A page sets no `style` attribute: compose core's templates and helpers instead.",
      script: "A page's script sets no inline style: compose core's templates and helpers instead."
    }
  },
  create(context) {
    const check = (node) => {
      const text = literalText(node);
      if (text === undefined) return;
      for (const { pattern, messageId } of STYLED)
        if (pattern.test(text)) context.report({ node, messageId });
    };
    return {
      Literal: check,
      TemplateLiteral: check,
      MemberExpression(node) {
        const name = memberName(node);
        if (name === "style" || name === "cssText") context.report({ node, messageId: "script" });
      },
      CallExpression(node) {
        const [first] = node.arguments;
        if (
          memberName(node.callee) === "setAttribute" &&
          first !== undefined &&
          literalText(first) === "style"
        )
          context.report({ node, messageId: "script" });
      }
    };
  }
};
