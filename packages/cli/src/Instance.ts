/**
 * The instance every command targets and where that choice came from. One
 * resolution, in this order: `--api-url`, the `.local/dev/env` a `pnpm dev`
 * wrote in this worktree (searched upward from the working directory),
 * `PATCHY_API_URL`, the URL saved in the state dir's `config.json`, the local
 * default. The URL is the host key every other piece of state is filed under,
 * so it is normalised once here: trimmed, no trailing slash, and otherwise
 * exact — scheme and port differences are distinct instances by design.
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
import * as State from "./State.js";

export const DEFAULT_API_URL = "http://localhost:3000";

/** Which link of the chain answered; `status --json` reports it and `upload` names it. */
export type Source = "flag" | "dev-env" | "env" | "config" | "default";

/** How a source reads in a sentence: "target came from …". */
export const describeSource = (source: Source): string =>
  ({
    flag: "--api-url",
    "dev-env": ".local/dev/env",
    env: "PATCHY_API_URL",
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
    readonly token: Option.Option<string>;
  }
>()("@patchy/cli/Instance") {}

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
        return Option.some({ apiUrl: apiUrl.value, token: envValue(text, "PATCHY_API_TOKEN") });
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return Option.none<{ apiUrl: string; token: Option.Option<string> }>();
    dir = parent;
  }
});

export const make = Effect.fn("Instance.make")(function* (cwd: string) {
  const resolved = (apiUrl: string, source: Source, token = Option.none<string>()) =>
    Instance.of({ apiUrl: normalizeApiUrl(apiUrl), source, token });

  const flag = yield* ApiUrlFlag;
  if (Option.isSome(flag)) return resolved(flag.value, "flag");

  const dev = yield* devEnv(cwd);
  if (Option.isSome(dev)) return resolved(dev.value.apiUrl, "dev-env", dev.value.token);

  const env = yield* optionalEnv("PATCHY_API_URL");
  if (Option.isSome(env)) return resolved(env.value, "env");

  const state = yield* State.State;
  const saved = yield* state.readConfigUrl;
  if (Option.isSome(saved)) return resolved(saved.value, "config");

  return resolved(DEFAULT_API_URL, "default");
});

export const layer = (cwd: string) => Layer.effect(Instance, make(cwd));
