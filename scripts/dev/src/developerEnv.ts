/**
 * The developer's own secrets for the local instance: `KEY=value` lines in
 * `$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env`),
 * one file per developer, shared by every worktree, never in the repo. Today
 * it holds the Clerk development keys (`clerk env pull --file` writes it).
 * The supervisor hands every line to the server, under the plan's own values.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** `$XDG_CONFIG_HOME/patchy-cloud/dev.env`, with `XDG_CONFIG_HOME` defaulting to `<home>/.config`. */
export const developerEnvFile = Effect.fn("developerEnvFile")(function* (home: string) {
  const path = yield* Path.Path;
  const configHome = yield* Config.string("XDG_CONFIG_HOME").pipe(
    Config.withDefault(path.join(home, ".config"))
  );
  return path.join(configHome, "patchy-cloud", "dev.env");
});

/**
 * dotenv's common ground: one `KEY=value` per line, split at the first `=`,
 * a matching pair of quotes around the value dropped; blank lines and `#`
 * comments skipped. Enough for what `clerk env pull` and a hand write.
 */
export const parseEnv = (text: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    const quoted = value.length >= 2 && /^(["']).*\1$/.test(value);
    env[key] = quoted ? value.slice(1, -1) : value;
  }
  return env;
};

/** The file's variables, or nothing when the developer has not written one. */
export const readDeveloperEnv = Effect.fn("readDeveloperEnv")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return {};
  return parseEnv(yield* fs.readFileString(file));
});
