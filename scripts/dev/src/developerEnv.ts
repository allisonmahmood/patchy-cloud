/**
 * Clerk development settings, the seed's optional Clerk user id, Pidgeon test admin and Send keys,
 * an Attio read key, and the development GitHub App with an installation and repositories to seed,
 * from `$XDG_CONFIG_HOME/patchy-cloud/dev.env` (`~/.config/patchy-cloud/dev.env`). Clerk's and the
 * GitHub App's settings reach the server; the user id is consumed by the seed, the Pidgeon keys by
 * a scenario's inbox and connect page, the Attio key by its connect page, and the GitHub installation and repositories by the
 * `github` scenario's seed. Other settings in this developer-owned file never enter the dev instance.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Redacted from "effect/Redacted";
import { CredentialKeys, GithubSource } from "@patchy/integrations";

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
 * The Pidgeon test admin key that makes a scenario's test inbox and delivers its mail,
 * `PIDGEON_TEST_ADMIN_KEY`: from the environment, else from the developer's dev.env. None, and the
 * scenario skips Pidgeon.
 */
export const readPidgeonTestKey = (file: string) => readKey("PIDGEON_TEST_ADMIN_KEY", file);

/**
 * The Pidgeon test key a scenario's connect page is given, `PIDGEON_TEST_SEND_KEY`, as an admin
 * pastes a Send key from Pidgeon's dashboard: from the environment, else the developer's dev.env.
 * None, and the admin key connects instead.
 */
export const readPidgeonSendKey = (file: string) => readKey("PIDGEON_TEST_SEND_KEY", file);

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

/**
 * The development GitHub App's settings, `PATCHY_GITHUB_APP_*`, as the server reads them: the ones
 * dev.env holds, none when it holds none, which leaves GitHub unoffered.
 */
export const readGithubApp = Effect.fn("readGithubApp")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const settings: Partial<Record<(typeof GithubSource.configKeys)[number], string>> = {};
  if (!(yield* fs.exists(file))) return settings;
  const provider = ConfigProvider.fromDotEnvContents(yield* fs.readFileString(file));
  for (const key of GithubSource.configKeys) {
    const value = (yield* provider.load([key]))?.value;
    if (value !== undefined) settings[key] = value;
  }
  return settings;
});

/**
 * What the `github` scenario seeds its connection from: `GITHUB_DEV_INSTALLATION_ID`, one of the
 * development App's installations, and `GITHUB_DEV_REPOSITORY_IDS`, comma-separated repository ids
 * in it, from the environment or dev.env. None, and the scenario skips the connection.
 */
export const readGithubSeed = Effect.fn("readGithubSeed")(function* (file: string) {
  const installation = yield* readKey("GITHUB_DEV_INSTALLATION_ID", file);
  const repositories = yield* readKey("GITHUB_DEV_REPOSITORY_IDS", file);
  if (Option.isNone(installation) || Option.isNone(repositories)) return Option.none();
  const installationId = Number(Redacted.value(installation.value).trim());
  const repositoryIds = Redacted.value(repositories.value)
    .split(",")
    .map((id) => Number(id.trim()));
  return Number.isSafeInteger(installationId) &&
    repositoryIds.length > 0 &&
    repositoryIds.every((id) => Number.isSafeInteger(id) && id > 0)
    ? Option.some({ installationId, repositoryIds })
    : Option.none();
});

/** The development GitHub App as the server would read it from dev.env: none when it holds none. */
export const readGithubAppConfig = Effect.fn("readGithubAppConfig")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return Option.none<GithubSource.App>();
  const provider = ConfigProvider.fromDotEnvContents(yield* fs.readFileString(file));
  return yield* GithubSource.appConfig.pipe(Effect.provide(ConfigProvider.layer(provider)));
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
