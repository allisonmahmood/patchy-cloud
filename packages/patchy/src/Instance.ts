/**
 * The instance every command targets and where that choice came from. One
 * resolution, in this order: `--api-url`, the `.local/dev/env` a `pnpm dev`
 * wrote in this worktree (searched upward from the working directory),
 * `PATCHY_API_URL`, the URL saved in the state dir's `config.json`, the local
 * default. Repo commands bind to patchy.json first: an effective flag, dev env
 * or environment override must match it, and saved config cannot override it.
 * The URL is the host key every other piece of state is filed under, normalised
 * here: trimmed, no trailing slash, and otherwise exact — scheme and port
 * differences are distinct instances by design.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Flag from "effect/unstable/cli/Flag";
import * as GlobalFlag from "effect/unstable/cli/GlobalFlag";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { InstanceMismatch, LocalError } from "./CliError.js";
import * as State from "./State.js";

export const DEFAULT_API_URL = "http://localhost:3000";

/** Which link of the chain answered; `status --json` reports it and `publish` names it. */
export type Source = "flag" | "dev-env" | "env" | "project" | "config" | "default";

/** How a source reads in a sentence: "target came from …". */
export const describeSource = (source: Source): string =>
  ({
    flag: "--api-url",
    "dev-env": ".local/dev/env",
    env: "PATCHY_API_URL",
    project: "patchy.json",
    config: "the saved config",
    default: "the built-in default"
  })[source];

/** The `--api-url` global flag, accepted by every command. */
export const ApiUrlFlag = GlobalFlag.setting("api-url")({
  flag: Flag.string("api-url").pipe(
    Flag.withDescription("The Patchy Cloud instance to talk to (its API base URL)"),
    Flag.optional
  )
});

export class Instance extends Context.Service<
  Instance,
  {
    readonly apiUrl: string;
    readonly source: Source;
    /** The seeded token beside a `dev-env` URL: `pnpm dev` wrote both so the CLI works at once. */
    readonly token: Option.Option<Redacted.Redacted>;
  }
>()("patchy/Instance") {}

export const normalizeApiUrl = (value: string): string => value.trim().replace(/\/+$/, "");

/** An unset variable and an empty one mean the same thing: nothing was configured. */
export const optionalEnv = (name: string) =>
  Config.string(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value !== "")),
    // A plain string variable cannot fail to parse; anything else here is a bug.
    Effect.orDie
  );

/** One `KEY=value` line of the dev env; the runner writes them `export`-free. */
const envValue = (text: string, key: string) =>
  Option.fromUndefinedOr(
    text
      .split("\n")
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1)
      .trim()
  ).pipe(Option.filter((value) => value !== ""));

/** A secret from the environment, redacted at the boundary; empty means unset. */
export const optionalSecret = (name: string) =>
  Config.redacted(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => Redacted.value(value) !== "")),
    Effect.orDie
  );

/**
 * The `PATCHY_API_URL` (and the seeded `PATCHY_API_TOKEN`) of the nearest
 * `.local/dev/env` at or above `cwd`. A worktree with a running dev instance
 * is the one place an agent should never have to say where to publish.
 */
export const devEnv = Effect.fn("devEnv")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, ".local", "dev", "env");
    if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) {
      const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      const apiUrl = envValue(text, "PATCHY_API_URL");
      if (Option.isSome(apiUrl)) {
        return Option.some({
          apiUrl: apiUrl.value,
          token: Option.map(envValue(text, "PATCHY_API_TOKEN"), Redacted.make)
        });
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return Option.none<{ apiUrl: string; token: Option.Option<Redacted.Redacted> }>();
    }
    dir = parent;
  }
});

const decodeProject = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      instance: Schema.String
    })
  )
);

export const make = Effect.fn("Instance.make")(function* (cwd: string, project = false) {
  let repoInstance: string | undefined;
  if (project) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(cwd, "patchy.json");
    if (
      yield* fs
        .exists(file)
        .pipe(
          Effect.mapError(
            (cause) => new LocalError({ message: "Could not inspect patchy.json.", cause })
          )
        )
    ) {
      const text = yield* fs
        .readFileString(file)
        .pipe(
          Effect.mapError(
            (cause) => new LocalError({ message: "Could not read patchy.json.", cause })
          )
        );
      const config = yield* Effect.try({
        try: () => decodeProject(text),
        catch: (cause) =>
          new LocalError({ message: "patchy.json must contain an instance URL.", cause })
      });
      repoInstance = config.instance;
    }
  }

  const resolved = (apiUrl: string, source: Source, token = Option.none<Redacted.Redacted>()) => {
    const normalized = normalizeApiUrl(apiUrl);
    if (repoInstance !== undefined && normalizeApiUrl(repoInstance) !== normalized) {
      return Effect.fail(InstanceMismatch.new({ stored: repoInstance, requested: apiUrl }));
    }
    return Effect.succeed(Instance.of({ apiUrl: normalized, source, token }));
  };

  const flag = yield* ApiUrlFlag;
  if (Option.isSome(flag)) return yield* resolved(flag.value, "flag");

  const dev = yield* devEnv(cwd);
  if (Option.isSome(dev)) return yield* resolved(dev.value.apiUrl, "dev-env", dev.value.token);

  const env = yield* optionalEnv("PATCHY_API_URL");
  if (Option.isSome(env)) return yield* resolved(env.value, "env");

  if (repoInstance !== undefined) return yield* resolved(repoInstance, "project");

  const state = yield* State.State;
  const saved = yield* state.readConfigUrl;
  if (Option.isSome(saved)) return yield* resolved(saved.value, "config");

  return yield* resolved(DEFAULT_API_URL, "default");
});

export const layer = (cwd: string, project = false) => Layer.effect(Instance, make(cwd, project));
