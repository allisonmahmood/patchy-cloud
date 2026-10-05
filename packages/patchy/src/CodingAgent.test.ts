import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as CodingAgent from "./CodingAgent.js";

const detectIn = (env: Record<string, string>) =>
  CodingAgent.detect.pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true }))
    )
  );

it.effect("names the agent whose harness variable matches, even empty", () =>
  Effect.gen(function* () {
    for (const [env, agent] of [
      [{ CLAUDE_CODE_CHILD_SESSION: "1" }, "claude-code"],
      [{ CODEX_THREAD_ID: "" }, "codex"],
      [{ CURSOR_AGENT: "1" }, "cursor"],
      [{ GEMINI_CLI: "1" }, "gemini-cli"],
      [{ KILO: "1", OPENCODE: "1" }, "kilo-code"],
      [{ OPENCODE: "1" }, "opencode"],
      [{ COPILOT_CLI: "1" }, "copilot-cli"],
      [{ GROK_AGENT: "1" }, "grok"],
      [{ CRUSH: "1" }, "crush"],
      [{ QWEN_CODE: "1" }, "qwen-code"],
      [{ PI_CODING_AGENT: "true" }, "pi"],
      [{ AUGMENT_AGENT: "1" }, "augment"],
      [{ ROO_ACTIVE: "true" }, "roo-code"],
      [{ CLINE_ACTIVE: "true" }, "cline"]
    ] as const)
      assert.strictEqual(yield* detectIn(env), agent);
  })
);

it.effect("names a harness launched from Claude Code, and is unknown without one", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* detectIn({ CLAUDE_CODE_CHILD_SESSION: "1", CLAUDECODE: "1", CODEX_THREAD_ID: "t" }),
      "codex"
    );
    // An IDE terminal a person types in carries CLAUDECODE alone, and a person
    // may choose a Grok profile with GROK_AGENT.
    assert.strictEqual(
      yield* detectIn({ CLAUDECODE: "1", GROK_AGENT: "work", TERM: "xterm", CI: "1" }),
      "unknown"
    );
  })
);
