/**
 * A test runs on `@effect/vitest` — `it.effect`, `it.layer` — never on a
 * runtime it made itself: `Effect.run*` and `ManagedRuntime.make` in a test
 * file bypass the test services (the `TestClock` above all) and the scope
 * that closes what the test opened.
 */
import { memberCall } from "./utils.js";

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

const RUNTIME_METHODS = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith"
]);

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Run tests through @effect/vitest, never a runtime the test made itself."
    },
    schema: [],
    messages: {
      manualRuntime:
        "Do not use {{runner}} in a test. Use @effect/vitest: `it.effect(...)` and `it.layer(...)`."
    }
  },
  create(context) {
    if (!TEST_FILE.test(context.filename)) return {};
    return {
      CallExpression(node) {
        const call = memberCall(node.callee);
        if (!call) return;
        const runner =
          call.object === "Effect" && RUNTIME_METHODS.has(call.property)
            ? `Effect.${call.property}`
            : call.object === "ManagedRuntime" && call.property === "make"
              ? "ManagedRuntime.make"
              : undefined;
        if (runner === undefined) return;
        context.report({ node: node.callee, messageId: "manualRuntime", data: { runner } });
      }
    };
  }
};
