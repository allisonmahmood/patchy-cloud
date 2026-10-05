/**
 * Which coding agent runs this CLI, read from a variable each harness sets for
 * the commands it runs. Only the agent's id leaves the machine, never a value
 * read from the environment.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CodingAgent } from "@patchy/api";

/**
 * Each agent and the variable its harness sets for its commands, as its own
 * docs or source say. A harness's commands inherit the variables of whatever
 * launched it, so the first one present wins and the list runs from markers
 * only a harness's own commands carry to Claude Code, the usual outer shell.
 */
export const variables = [
  // codex-rs/protocol/src/shell_environment.rs: set in every sandbox mode.
  ["codex", "CODEX_THREAD_ID"],
  ["cursor", "CURSOR_AGENT"],
  // packages/core/src/services/shellExecutionService.ts
  ["gemini-cli", "GEMINI_CLI"],
  // Kilo Code is built on OpenCode and also sets OPENCODE.
  ["kilo-code", "KILO"],
  ["opencode", "OPENCODE"],
  ["copilot-cli", "COPILOT_CLI"],
  ["grok", "GROK_AGENT"],
  // internal/shell/shell.go, CrushEnvMarkers
  ["crush", "CRUSH"],
  ["qwen-code", "QWEN_CODE"],
  ["pi", "PI_CODING_AGENT"],
  ["augment", "AUGMENT_AGENT"],
  // The VS Code extensions set these in the terminals they run commands in.
  ["roo-code", "ROO_ACTIVE"],
  ["cline", "CLINE_ACTIVE"],
  // Only Claude Code's own commands; CLAUDECODE is also set in IDE terminals people type in.
  ["claude-code", "CLAUDE_CODE_CHILD_SESSION"]
] as const satisfies ReadonlyArray<readonly [Exclude<CodingAgent, "unknown">, string]>;

/** The agent whose variable is set, or `unknown`. Presence counts, even an empty value. */
export const detect: Effect.Effect<CodingAgent> = Effect.gen(function* () {
  for (const [agent, name] of variables) {
    const value = yield* Config.String(name).pipe(Config.option, Effect.orDie);
    if (Option.isSome(value)) return agent;
  }
  return "unknown";
});
