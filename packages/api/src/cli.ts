/**
 * The `Patchy-Cli` request header: the CLI names its release, the command it
 * runs and the coding agent running it, as `<release> <command> <agent>`, one
 * space between, such as `0.0.1 publish claude-code`. The server reads it only
 * for usage records; no route requires or answers it.
 */
import * as Schema from "effect/Schema";

export const PATCHY_CLI_HEADER = "patchy-cli";

/** A CLI release: three dot-separated numbers without leading zeros. */
export const CliRelease = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/)
);

/** Every CLI command that sends requests to an instance. */
export const CliCommand = Schema.Literals([
  "login",
  "logout",
  "whoami",
  "publish",
  "share",
  "delete",
  "retire",
  "restore",
  "rollback",
  "describe",
  "init",
  "dev",
  "refresh",
  "list",
  "look",
  "add",
  "remove",
  "__generate"
]);
export type CliCommand = typeof CliCommand.Type;

/** The coding agents the CLI recognises from their environment; `unknown` when none matched. */
export const CodingAgent = Schema.Literals([
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "kilo-code",
  "opencode",
  "copilot-cli",
  "grok",
  "crush",
  "qwen-code",
  "pi",
  "augment",
  "roo-code",
  "cline",
  "unknown"
]);
export type CodingAgent = typeof CodingAgent.Type;

export const PatchyCli = Schema.Struct({
  cliVersion: CliRelease,
  cliCommand: CliCommand,
  agent: CodingAgent
});
export type PatchyCli = typeof PatchyCli.Type;

export const formatPatchyCli = ({ cliVersion, cliCommand, agent }: PatchyCli): string =>
  `${cliVersion} ${cliCommand} ${agent}`;

const isRelease = Schema.is(CliRelease);
const isCommand = Schema.is(CliCommand);
const isAgent = Schema.is(CodingAgent);

/**
 * The header's fields that parse: a release that matches the pattern, and a
 * command and agent from their lists. A field that does not parse is dropped,
 * so a newer CLI's new command or agent still records its release. A header
 * that is not exactly three fields records nothing.
 */
export const parsePatchyCli = (header: string | undefined): Partial<PatchyCli> => {
  const fields = header?.split(" ");
  if (fields?.length !== 3) return {};
  const [cliVersion, cliCommand, agent] = fields;
  return {
    ...(isRelease(cliVersion) ? { cliVersion } : {}),
    ...(isCommand(cliCommand) ? { cliCommand } : {}),
    ...(isAgent(agent) ? { agent } : {})
  };
};
