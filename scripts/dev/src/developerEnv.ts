/**
 * Clerk development keys and the seed's optional Clerk user id, from
 * `$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env`).
 * Only the two keys reach the server; the user id is consumed by the seed.
 * Other settings in this developer-owned file never enter the dev instance.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const DEVELOPER_ENV_NAMES = [
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "PATCHY_DEV_CLERK_USER_ID"
] as const;

/** `$XDG_CONFIG_HOME/patchy-cloud/dev.env`, with `XDG_CONFIG_HOME` defaulting to `<home>/.config`. */
export const developerEnvFile = Effect.fn("developerEnvFile")(function* (home: string) {
  const path = yield* Path.Path;
  const configHome = yield* Config.string("XDG_CONFIG_HOME").pipe(
    Config.withDefault(path.join(home, ".config"))
  );
  return path.join(configHome, "patchy-cloud", "dev.env");
});

/** The allowed developer settings; empty when the developer has written no file. */
export const readDeveloperEnv = Effect.fn("readDeveloperEnv")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const keys: Partial<Record<(typeof DEVELOPER_ENV_NAMES)[number], string>> = {};
  if (!(yield* fs.exists(file))) return keys;
  const provider = ConfigProvider.fromDotEnvContents(yield* fs.readFileString(file));
  for (const key of DEVELOPER_ENV_NAMES) {
    const value = (yield* provider.load([key]))?.value;
    if (value !== undefined) keys[key] = value;
  }
  return keys;
});
