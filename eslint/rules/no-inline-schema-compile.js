/**
 * `Schema.decodeUnknownSync(Foo)` and its siblings compile a function. Built
 * inside a function body and called at once, that compile happens on every
 * call — on a request path, on every request. The compiled function belongs
 * at module scope: `const decode = Schema.decodeUnknownSync(Foo)` once,
 * `decode(input)` per call. Only a static schema (a capitalised name, a
 * member such as `Wire.Foo`, or a `Schema.*` call) is flagged: a schema
 * passed in as a parameter is the caller's to hoist. A test has no hot
 * path, so test files are not held to it.
 */
import { memberCall, unwrapExpression } from "./utils.js";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const COMPILERS = new Set([
  "is",
  "asserts",
  "decodeEffect",
  "decodeExit",
  "decodeOption",
  "decodePromise",
  "decodeResult",
  "decodeSync",
  "decodeUnknownExit",
  "decodeUnknownEffect",
  "decodeUnknownOption",
  "decodeUnknownPromise",
  "decodeUnknownResult",
  "decodeUnknownSync",
  "encodeExit",
  "encodeEffect",
  "encodeOption",
  "encodePromise",
  "encodeResult",
  "encodeSync",
  "encodeUnknownExit",
  "encodeUnknownEffect",
  "encodeUnknownOption",
  "encodeUnknownPromise",
  "encodeUnknownResult",
  "encodeUnknownSync"
]);

const isStaticSchema = (node) => {
  const expression = unwrapExpression(node);
  if (!expression) return false;
  if (expression.type === "Identifier") return /^[A-Z]/u.test(expression.name);
  if (expression.type === "MemberExpression") return true;
  return expression.type === "CallExpression" && memberCall(expression.callee)?.object === "Schema";
};

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Hoist Schema compiler calls out of function bodies."
    },
    schema: [],
    messages: {
      hoist:
        "Hoist `Schema.{{method}}(...)` to module scope: built here, the compiled function is rebuilt on every call."
    }
  },
  create(context) {
    if (TEST_FILE.test(context.filename)) return {};
    let depth = 0;
    const enter = () => {
      depth += 1;
    };
    const exit = () => {
      depth -= 1;
    };
    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      CallExpression(node) {
        if (depth === 0) return;
        const call = memberCall(node.callee);
        if (!call || call.object !== "Schema" || !COMPILERS.has(call.property)) return;
        // Only the compile-and-call-at-once shape: a compiled function kept
        // in a variable inside a factory is that factory's to reuse.
        const parent = unwrapExpression(node.parent);
        if (parent?.type !== "CallExpression" || unwrapExpression(parent.callee) !== node) return;
        if (!isStaticSchema(node.arguments[0])) return;
        context.report({ node: node.callee, messageId: "hoist", data: { method: call.property } });
      }
    };
  }
};
