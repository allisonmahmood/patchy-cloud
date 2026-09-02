/**
 * The Clerk development keys, from the developer's own dotenv file at
 * `$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env`):
 * one file per developer, shared by every worktree, never in the repo,
 * written by `clerk env pull --file`. Only these two names cross into the
 * server; the runner's env stays closed to everything else.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const CLERK_KEYS = ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] as const;

/** `$XDG_CONFIG_HOME/patchy-cloud/dev.env`, with `XDG_CONFIG_HOME` defaulting to `<home>/.config`. */
export const developerEnvFile = Effect.fn("developerEnvFile")(function* (home: string) {
  const path = yield* Path.Path;
  const configHome = yield* Config.string("XDG_CONFIG_HOME").pipe(
    Config.withDefault(path.join(home, ".config"))
  );
  return path.join(configHome, "patchy-cloud", "dev.env");
});

/** The Clerk keys the file holds, by name; empty when the developer has written no file. */
export const readClerkKeys = Effect.fn("readClerkKeys")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const keys: Partial<Record<(typeof CLERK_KEYS)[number], string>> = {};
  if (!(yield* fs.exists(file))) return keys;
  const provider = ConfigProvider.fromDotEnvContents(yield* fs.readFileString(file));
  for (const key of CLERK_KEYS) {
    const value = (yield* provider.load([key]))?.value;
    if (value !== undefined) keys[key] = value;
  }
  return keys;
});
