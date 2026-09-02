/**
 * The Clerk development keys, from the developer's own dotenv file at
 * `$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env`):
 * one file per developer, shared by every worktree, never in the repo,
 * written by `clerk env pull --file`. Only `CLERK_*` names cross into the
 * server (plus `PROTOTYPE_DOOR_MODE` while the #119 login-door prototype
 * lives on its branch); the runner's env stays closed to everything else.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const CLERK_KEYS = ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] as const;

/**
 * PROTOTYPE for #119 (throwaway): every `CLERK_*` name in the file is
 * forwarded, not just the two keys, so `CLERK_JWT_KEY` and
 * `CLERK_AUTHORIZED_PARTIES` can be tried without touching the runner;
 * `PROTOTYPE_DOOR_MODE` picks the door's signed-out behaviour.
 */
const FORWARDED_PREFIX = "CLERK_";
const FORWARDED_EXTRA = ["PROTOTYPE_DOOR_MODE"] as const;

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
  const keys: Record<string, string> = {};
  if (!(yield* fs.exists(file))) return keys;
  const contents = yield* fs.readFileString(file);
  const provider = ConfigProvider.fromDotEnvContents(contents);
  // The dotenv provider answers by name, so the names come from the file's
  // own lines: every `CLERK_*` assignment, plus the prototype's door switch.
  const names = new Set<string>(FORWARDED_EXTRA);
  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line);
    if (match?.[1]?.startsWith(FORWARDED_PREFIX)) names.add(match[1]);
  }
  for (const key of names) {
    const value = (yield* provider.load([key]))?.value;
    if (value !== undefined) keys[key] = value;
  }
  return keys;
});
