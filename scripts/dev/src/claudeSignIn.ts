/**
 * How the agents the runner starts reach Claude: `pnpm dev eval`'s builders
 * and judges, and `pnpm dev trial`'s agents. None of them loads the
 * developer's own Claude Code settings, so the model provider and tokens those
 * settings may hold are read here and passed in the agent's environment,
 * where the sanitizer finds the secrets among them (`secretsInEnv`).
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { developerEnvFile } from "./developerEnv.js";

/** Claude Code's own sign-in tokens, the one eval prefers first. */
const TOKEN_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/** What points Claude Code at a model provider, and the provider's own ways in. */
const PROVIDER_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS"
] as const;

type ClaudeVariable = (typeof TOKEN_NAMES)[number] | (typeof PROVIDER_NAMES)[number];

/** The developer's Claude Code variables that are set, by name. */
export type ClaudeVariables = Readonly<Partial<Record<ClaudeVariable, string>>>;

const pick = (variables: ClaudeVariables, names: ReadonlyArray<ClaudeVariable>) =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = variables[name];
      return value ? [[name, value] as const] : [];
    })
  );

/**
 * The developer's model provider, when `ANTHROPIC_BASE_URL` names one: it and
 * the variables that reach it. Nothing otherwise, so a stray
 * `ANTHROPIC_AUTH_TOKEN` never passes on its own.
 */
export const providerEnv = (variables: ClaudeVariables): Readonly<Record<string, string>> =>
  variables.ANTHROPIC_BASE_URL ? pick(variables, PROVIDER_NAMES) : {};

/**
 * Claude Code's environment for an eval sandbox: the developer's model
 * provider (`providerEnv`) and the first of their tokens. `signedIn` is false
 * when neither a token nor the provider's `ANTHROPIC_AUTH_TOKEN` signs Claude
 * Code in, so its credentials file has to.
 */
export const claudeEnv = (variables: ClaudeVariables) => {
  const provider = providerEnv(variables);
  const token = pick(variables, TOKEN_NAMES.filter((name) => variables[name]).slice(0, 1));
  const env: Readonly<Record<string, string>> = { ...provider, ...token };
  return {
    env,
    signedIn: Object.keys(token).length > 0 || "ANTHROPIC_AUTH_TOKEN" in provider
  };
};

/** The `env` Claude Code's `settings.json` sets, which is where a model provider usually lives. */
const ClaudeSettings = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
});
const decodeClaudeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeSettings));

/**
 * The developer's tokens and model provider: each variable from the
 * environment, else their `dev.env`, else the `env` of `settings.json` in
 * Claude Code's config folder (`CLAUDE_CONFIG_DIR`, or `~/.claude`). Returns
 * that folder too, which holds Claude Code's credentials file.
 */
export const readClaudeVariables = Effect.fn("ClaudeSignIn.readClaudeVariables")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME");
  const configDir = Option.getOrElse(yield* Config.option(Config.String("CLAUDE_CONFIG_DIR")), () =>
    path.join(home, ".claude")
  );
  const devEnv = yield* developerEnvFile(home);
  const devEnvText = (yield* fs.exists(devEnv)) ? yield* fs.readFileString(devEnv) : "";
  const fromFile = (name: string) =>
    new RegExp(String.raw`^${name}=(.+)$`, "m").exec(devEnvText)?.[1]?.trim();
  const settings = yield* fs.readFileString(path.join(configDir, "settings.json")).pipe(
    Effect.flatMap(decodeClaudeSettings),
    Effect.map((decoded) => decoded.env ?? {}),
    Effect.orElseSucceed((): Partial<Record<string, string>> => ({}))
  );
  const variables: Partial<Record<ClaudeVariable, string>> = {};
  for (const name of [...TOKEN_NAMES, ...PROVIDER_NAMES]) {
    const value =
      Option.getOrUndefined(yield* Config.option(Config.String(name))) ??
      fromFile(name) ??
      settings[name];
    if (value) variables[name] = value;
  }
  return { configDir, variables };
});
