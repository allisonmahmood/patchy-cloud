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
 * docs or source say; every agent in the contract's list has one. `NAME`
 * matches when it is set, even empty; `NAME=value` only at that value. A harness's
 * commands inherit the variables of whatever launched it, so the first one
 * present wins and the order runs from markers only a harness's own commands
 * carry to Claude Code, the usual outer shell.
 */
const variables = {
  // openai/codex codex-rs/protocol/src/shell_environment.rs: every sandbox mode.
  codex: "CODEX_THREAD_ID",
  // cursor.com/docs/agent/tools/terminal, and the cursor-agent bundle.
  cursor: "CURSOR_AGENT",
  // google-gemini/gemini-cli packages/core/src/services/shellExecutionService.ts
  "gemini-cli": "GEMINI_CLI",
  // Kilo-Org/kilocode packages/opencode/src/index.ts; Kilo also sets OPENCODE.
  "kilo-code": "KILO",
  // anomalyco/opencode packages/opencode/src/index.ts
  opencode: "OPENCODE",
  // The Copilot CLI changelog: "detect Copilot CLI subprocesses via COPILOT_CLI=1".
  "copilot-cli": "COPILOT_CLI",
  // xai-org/grok-build crates/codegen/xai-grok-tools/src/util/env.rs. People
  // also set it to choose a profile; Grok's own commands get exactly 1.
  grok: "GROK_AGENT=1",
  // charmbracelet/crush internal/shell/shell.go, CrushEnvMarkers
  crush: "CRUSH",
  // QwenLM/qwen-code packages/core/src/services/shellExecutionService.ts
  "qwen-code": "QWEN_CODE",
  // badlogic/pi-mono packages/coding-agent/src/cli/setup.ts
  pi: "PI_CODING_AGENT",
  // docs.augmentcode.com/cli/reference, environment variables.
  augment: "AUGMENT_AGENT",
  // RooCodeInc/Roo-Code src/integrations/terminal/Terminal.ts
  "roo-code": "ROO_ACTIVE",
  // cline/cline apps/vscode/src/hosts/vscode/terminal/VscodeTerminalRegistry.ts
  cline: "CLINE_ACTIVE",
  // code.claude.com/docs/en/env-vars: set only by Claude Code for its tools' and
  // hooks' commands. CLAUDECODE is also set in IDE terminals people type in.
  "claude-code": "CLAUDE_CODE_CHILD_SESSION"
} satisfies Record<Exclude<CodingAgent, "unknown">, string>;

/** The first agent whose variable matches, or `unknown`. */
export const detect: Effect.Effect<CodingAgent> = Effect.gen(function* () {
  // Keys keep the declared order; `satisfies` has already checked each one.
  for (const agent of Object.keys(variables) as ReadonlyArray<keyof typeof variables>) {
    const [name, expected] = variables[agent].split("=");
    const value = yield* Config.String(name!).pipe(Config.option, Effect.orDie);
    if (Option.isSome(value) && (expected === undefined || value.value === expected)) return agent;
  }
  return "unknown";
});
