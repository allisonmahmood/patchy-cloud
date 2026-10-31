/**
 * Clerk development settings, the seed's optional Clerk user id, a Pidgeon test admin key and an
 * Attio read key, from `$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env`).
 * Only Clerk settings reach the server; the user id is consumed by the seed, and the Pidgeon and
 * Attio keys by a scenario's connect page. Other settings in this developer-owned file never enter
 * the dev instance.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { CredentialKeys } from "@patchy/integrations";

/** A worktree-local keyring survives restarts without changing shared developer settings. */
export const readCredentialKeys = Effect.fn("readCredentialKeys")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    yield* fs.writeFileString(file, `PATCHY_CREDENTIAL_KEYS=dev:${key}\n`, {
      flag: "wx",
      mode: 0o600
    });
  }
  const provider = ConfigProvider.fromDotEnvContents(yield* fs.readFileString(file));
  return yield* CredentialKeys.config.pipe(Effect.provide(ConfigProvider.layer(provider)));
});
/** An environment's personas secret: random once per state dir, private, kept across restarts. */
export const readPersonasSecret = Effect.fn("readPersonasSecret")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) {
    const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    yield* fs.writeFileString(file, `PATCHY_DEV_PERSONAS_SECRET=${secret}\n`, {
      flag: "wx",
      mode: 0o600
    });
  }
  const provider = ConfigProvider.fromDotEnvContents(yield* fs.readFileString(file));
  return yield* Config.Redacted("PATCHY_DEV_PERSONAS_SECRET").pipe(
    Effect.provide(ConfigProvider.layer(provider))
  );
});

/**
 * An environment's personas door key, when its `personas.env` holds one: `pnpm dev eval` writes
 * it before an instance starts, so only its grader can sign people in there.
 */
export const readPersonasKey = Effect.fn("readPersonasKey")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return Option.none();
  const provider = ConfigProvider.fromDotEnvContents(yield* fs.readFileString(file));
  return yield* Config.option(Config.Redacted("PATCHY_DEV_PERSONAS_KEY")).pipe(
    Effect.provide(ConfigProvider.layer(provider))
  );
});

const DEVELOPER_ENV_NAMES = [
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_JWT_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "PATCHY_DEV_CLERK_USER_ID"
] as const;

/** `$XDG_CONFIG_HOME/patchy-cloud/dev.env`, with `XDG_CONFIG_HOME` defaulting to `<home>/.config`. */
export const developerEnvFile = Effect.fn("developerEnvFile")(function* (home: string) {
  const path = yield* Path.Path;
  const configHome = yield* Config.String("XDG_CONFIG_HOME").pipe(
    Config.withDefault(path.join(home, ".config"))
  );
  return path.join(configHome, "patchy-cloud", "dev.env");
});

/**
 * The Pidgeon test admin key a scenario's connections paste, `PIDGEON_TEST_ADMIN_KEY`: from the
 * environment, else from the developer's dev.env. None, and the scenario skips Pidgeon.
 */
export const readPidgeonTestKey = (file: string) => readKey("PIDGEON_TEST_ADMIN_KEY", file);

/**
 * The Attio read key a scenario's connections paste, `ATTIO_TEST_READ_KEY`: from the environment,
 * else from the developer's dev.env. None, and the scenario skips Attio.
 */
export const readAttioTestKey = (file: string) => readKey("ATTIO_TEST_READ_KEY", file);

const readKey = Effect.fn("readKey")(function* (name: string, file: string) {
  const key = Config.option(Config.Redacted(name));
  const fromEnv = yield* key;
  if (Option.isSome(fromEnv)) return fromEnv;
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return Option.none();
  const provider = ConfigProvider.fromDotEnvContents(yield* fs.readFileString(file));
  return yield* key.pipe(Effect.provide(ConfigProvider.layer(provider)));
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
