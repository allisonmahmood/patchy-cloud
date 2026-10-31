/**
 * A builder's HOME: a real user who has already set up. Each side gets one
 * template, made in the sandbox the way a person sets up: the instance's
 * `install.mjs`, which installs the CLI and runs `patchy setup`, putting the
 * global skill where each harness finds it (`~/.claude/skills`,
 * `~/.agents/skills`). The template also warms its pnpm store with a tier 1
 * and a tier 2 `patchy init`, as a person who has built a patch before would
 * have. Each run then gets a copy of its side's template, logged in as its own
 * publisher, with its harness's sign-in. None of it is timed.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { developerEnvFile } from "../developerEnv.js";
import { stepOutput } from "../steps.js";
import type { Builder } from "./builders.js";
import { type Bind, HOME, runSandboxed, type SandboxSpec, type Tool } from "./sandbox.js";

export class SetupFailed extends Schema.TaggedError<SetupFailed>()("SetupFailed", {
  step: Schema.String,
  detail: Schema.String
}) {
  override get message() {
    return `${this.step} failed in the sandbox: ${this.detail}`;
  }
}

export class NoSignIn extends Schema.TaggedError<NoSignIn>()("NoSignIn", {
  harness: Schema.String,
  fix: Schema.String
}) {
  override get message() {
    return `There is no ${this.harness} sign-in to give the builders. ${this.fix}`;
  }
}

/** How each harness signs in inside a sandbox, read once per suite. */
export interface SignIns {
  /** Claude Code: a token in its environment, or its credentials file mounted read-only. */
  readonly claude: {
    readonly env: Readonly<Record<string, string>>;
    readonly binds: ReadonlyArray<Bind>;
  };
  /** Codex: the `config.toml` each run's `~/.codex` gets, and its login mounted when it has one. */
  readonly codex: { readonly config: string; readonly binds: ReadonlyArray<Bind> };
  /** Every secret in the above, for the sanitizer. */
  readonly secrets: ReadonlyArray<string>;
}

const TOKEN_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/**
 * Codex's own settings for a run: no daemon outliving it, none of the
 * account's apps or plugins, no shell snapshot writing its environment to
 * disk; plus the developer's model provider, when they use one, since a
 * provider holds the way Codex reaches its models.
 */
export const codexConfig = (developerConfig: string) => {
  const provider = /^model_provider\s*=\s*"([^"]+)"/m.exec(developerConfig)?.[1];
  const table =
    provider === undefined
      ? undefined
      : new RegExp(
          String.raw`^\[model_providers\.${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\][\s\S]*?(?=^\[|(?![\s\S]))`,
          "m"
        ).exec(developerConfig)?.[0];
  return [
    "# Codex for a `pnpm dev eval` builder, written per run.",
    ...(provider === undefined || table === undefined ? [] : [`model_provider = "${provider}"`]),
    'cli_auth_credentials_store = "file"',
    "check_for_update_on_startup = false",
    "",
    "[features]",
    "daemon_auto_start = false",
    "apps = false",
    "plugins = false",
    "remote_plugin = false",
    "shell_snapshot = false",
    "",
    ...(table === undefined ? [] : [table.trimEnd(), ""])
  ].join("\n");
};

/** Secret-looking values in a provider table, such as a bearer token, for the sanitizer. */
const configSecrets = (config: string) =>
  [...config.matchAll(/^\s*\w*(?:token|key|secret)\w*\s*=\s*"([^"]+)"/gim)].map((m) => m[1]!);

/**
 * Each harness's sign-in. Claude Code takes `CLAUDE_CODE_OAUTH_TOKEN` (from
 * `claude setup-token`) or `ANTHROPIC_API_KEY`, from the environment or the
 * developer's `dev.env`; failing both, its credentials file read-only, which
 * lasts as long as its current access token. Codex takes the developer's
 * model provider, or their `auth.json`, mounted so a refresh is written back.
 */
export const readSignIns = Effect.fn("Eval.readSignIns")(function* (
  builders: ReadonlyArray<Builder>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME");
  const secrets: Array<string> = [];
  let claude: SignIns["claude"] = { env: {}, binds: [] };
  if (builders.some((builder) => builder.harness === "claude-code")) {
    const devEnv = yield* developerEnvFile(home);
    const devEnvText = (yield* fs.exists(devEnv)) ? yield* fs.readFileString(devEnv) : "";
    const fromFile = (name: string) =>
      new RegExp(String.raw`^${name}=(.+)$`, "m").exec(devEnvText)?.[1]?.trim();
    let found: readonly [string, string] | undefined;
    for (const name of TOKEN_NAMES) {
      const value =
        Option.getOrUndefined(yield* Config.option(Config.String(name))) ?? fromFile(name);
      if (value !== undefined && value !== "") {
        found = [name, value];
        break;
      }
    }
    if (found !== undefined) {
      claude = { env: { [found[0]]: found[1] }, binds: [] };
      secrets.push(found[1]);
    } else {
      const configDir = Option.getOrElse(
        yield* Config.option(Config.String("CLAUDE_CONFIG_DIR")),
        () => path.join(home, ".claude")
      );
      const file = path.join(configDir, ".credentials.json");
      if (!(yield* fs.exists(file)))
        return yield* new NoSignIn({
          harness: "Claude Code",
          fix: "Run `claude setup-token` and put CLAUDE_CODE_OAUTH_TOKEN=<token> in ~/.config/patchy-cloud/dev.env."
        });
      claude = {
        env: {},
        binds: [{ from: file, to: `${HOME}/.claude/.credentials.json`, readOnly: true }]
      };
    }
  }
  let codex: SignIns["codex"] = { config: codexConfig(""), binds: [] };
  if (builders.some((builder) => builder.harness === "codex")) {
    const codexHome = Option.getOrElse(yield* Config.option(Config.String("CODEX_HOME")), () =>
      path.join(home, ".codex")
    );
    const configFile = path.join(codexHome, "config.toml");
    const config = codexConfig(
      (yield* fs.exists(configFile)) ? yield* fs.readFileString(configFile) : ""
    );
    const auth = path.join(codexHome, "auth.json");
    const hasProvider = config.includes("model_provider =");
    if (!hasProvider && !(yield* fs.exists(auth)))
      return yield* new NoSignIn({ harness: "Codex", fix: "Sign Codex in with `codex login`." });
    codex = {
      config,
      binds: hasProvider ? [] : [{ from: auth, to: `${HOME}/.codex/auth.json`, readOnly: false }]
    };
    secrets.push(...configSecrets(config));
  }
  return { claude, codex, secrets } satisfies SignIns;
});

/** Runs a setup command in the sandbox; anything but exit 0 fails setup with its last error line. */
const setupStep = Effect.fn("Eval.setupStep")(function* (
  step: string,
  spec: SandboxSpec,
  command: string,
  args: ReadonlyArray<string>,
  input?: string
) {
  const ran = yield* runSandboxed(spec, command, args, {
    ...(input === undefined ? {} : { input }),
    timeout: "10 minutes"
  });
  if (ran.exitCode !== 0)
    return yield* new SetupFailed({
      step,
      detail:
        ran.exitCode === null
          ? "it ran past 10 minutes"
          : (`${ran.stderr}\n${ran.stdout}`.trim().split("\n").at(-1) ?? `exit ${ran.exitCode}`)
    });
  return ran.stdout;
});

/**
 * A side's template HOME, set up as a person sets up: the instance's
 * installer, then a tier 1 and a tier 2 `patchy init` in the sandbox's own
 * `/tmp` to warm the package store, signed in with the side's scenario
 * publisher. The login is removed afterwards; each run logs in as its own.
 */
export const prepareTemplate = Effect.fn("Eval.prepareTemplate")(function* (input: {
  readonly dir: string;
  readonly apiUrl: string;
  readonly tools: ReadonlyArray<Tool>;
  /** A machine token on the side's instance, for the warming `init`s. */
  readonly token: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(input.dir, { recursive: true });
  const spec: SandboxSpec = { home: input.dir, tools: input.tools };
  yield* setupStep("Installing patchy from the instance", spec, "bash", [
    "-c",
    'curl -fsSL "$1/install.mjs" -o /tmp/install.mjs && node /tmp/install.mjs',
    "install",
    input.apiUrl
  ]);
  yield* setupStep(
    "Logging the template in",
    spec,
    "patchy",
    ["auth", "set", "--token-stdin", "--api-url", input.apiUrl, "--json"],
    input.token
  );
  for (const tier of ["1", "2"])
    yield* setupStep(`Warming the store with a tier ${tier} init`, spec, "patchy", [
      "init",
      `/tmp/warm-${tier}`,
      "--tier",
      tier,
      "--purpose",
      "Warms the package store.",
      "--json"
    ]);
  yield* fs.remove(path.join(input.dir, ".patchy", "credentials.json"), { force: true });
});

/**
 * A run's HOME: a copy-on-write copy of its side's template, logged in as the
 * run's publisher, with its harness's sign-in. Returns the builder's sandbox.
 */
export const prepareHome = Effect.fn("Eval.prepareHome")(function* (input: {
  readonly template: string;
  readonly home: string;
  readonly apiUrl: string;
  readonly tools: ReadonlyArray<Tool>;
  readonly token: string;
  readonly builder: Builder;
  readonly signIns: SignIns;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* stepOutput(
    "Copying the template home",
    "cp",
    ["-a", "--reflink=auto", input.template, input.home],
    {
      cwd: path.dirname(input.home),
      prefix: "cp"
    }
  );
  const base: SandboxSpec = { home: input.home, tools: input.tools };
  yield* setupStep(
    "Logging the run's publisher in",
    base,
    "patchy",
    ["auth", "set", "--token-stdin", "--api-url", input.apiUrl, "--json"],
    input.token
  );
  if (input.builder.harness === "codex") {
    yield* fs.makeDirectory(path.join(input.home, ".codex"), { recursive: true });
    yield* fs.writeFileString(
      path.join(input.home, ".codex", "config.toml"),
      input.signIns.codex.config,
      {
        mode: 0o600
      }
    );
    return { ...base, binds: input.signIns.codex.binds } satisfies SandboxSpec;
  }
  yield* fs.makeDirectory(path.join(input.home, ".claude"), { recursive: true });
  return {
    ...base,
    env: { ...input.signIns.claude.env, DISABLE_AUTOUPDATER: "1" },
    binds: input.signIns.claude.binds
  } satisfies SandboxSpec;
});
