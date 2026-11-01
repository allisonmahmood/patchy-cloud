/**
 * A builder's HOME: a real user who has already set up. Each side gets one
 * template, made in the sandbox the way a person sets up: their own toolchain
 * (Node's release tarball, then pnpm, Claude Code and Codex from npm, at the
 * versions this machine has), then the instance's `install.mjs`, which
 * installs the CLI and runs `patchy setup`, putting the global skill where
 * each harness finds it (`~/.claude/skills`, `~/.agents/skills`). The template
 * also warms its pnpm store with a tier 1 and a tier 2 `patchy init`, as a
 * person who has built a patch before would have. Each run then gets a copy of
 * its side's template, logged in as its own publisher, with its harness's
 * sign-in. None of it is timed, and none of this machine's own installs is used.
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
import { secretsInJson } from "../sanitize.js";
import { endpoint, type Network } from "./network.js";
import {
  type Bind,
  HOME,
  runSandboxed,
  type SandboxSpec,
  type Toolchain,
  versionOf
} from "./sandbox.js";

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
  /**
   * Codex: the `config.toml` each run's `~/.codex` gets, and the developer's
   * `auth.json` to copy into it when there is no model provider. A copy, so a
   * builder can't write to the developer's own login.
   */
  readonly codex: { readonly config: string; readonly auth: string | null };
  /** The `host:port` endpoints on a private network the sandbox's proxy may reach: a model provider on the developer's own. */
  readonly privateEndpoints: ReadonlyArray<string>;
  /** Every secret in the above, credential files' tokens included, for the sanitizer. */
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

/** The endpoint a provider table's `base_url` names, its host and port, for the proxy to let through. */
export const providerEndpoint = (config: string) => {
  const url = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (url === undefined || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return endpoint(parsed.hostname, Number(parsed.port || (parsed.protocol === "http:" ? 80 : 443)));
};

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The secret-named values in a JSON credentials file, such as its tokens; none when it can't be read. */
export const fileSecrets = Effect.fn("Eval.fileSecrets")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const parsed = yield* decodeJson(text).pipe(Effect.option);
  return Option.match(parsed, { onNone: () => [], onSome: (value) => secretsInJson(value) });
});

/**
 * Each harness's sign-in. Claude Code takes `CLAUDE_CODE_OAUTH_TOKEN` (from
 * `claude setup-token`) or `ANTHROPIC_API_KEY`, from the environment or the
 * developer's `dev.env`; failing both, its credentials file read-only, which
 * lasts as long as its current access token. Codex takes the developer's
 * model provider, or a copy of their `auth.json` per run.
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
      secrets.push(...(yield* fileSecrets(file)));
    }
  }
  let codex: SignIns["codex"] = { config: codexConfig(""), auth: null };
  const privateEndpoints: Array<string> = [];
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
    codex = { config, auth: hasProvider ? null : auth };
    secrets.push(...configSecrets(config));
    if (hasProvider) {
      const provider = providerEndpoint(config);
      if (provider !== undefined) privateEndpoints.push(provider);
    } else secrets.push(...(yield* fileSecrets(auth)));
  }
  return { claude, codex, privateEndpoints, secrets } satisfies SignIns;
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

/** npm's package for each harness's command. */
const HARNESS_PACKAGES = {
  "claude-code": ["claude", "@anthropic-ai/claude-code"],
  codex: ["codex", "@openai/codex"]
} as const;

/** One installed tool and the version it reports, for the record. */
export const ToolVersion = Schema.Struct({ name: Schema.String, version: Schema.String });
export type ToolVersion = typeof ToolVersion.Type;

/**
 * A toolchain in `spec`'s HOME, as a person installs one: Node from its
 * release tarball into `~/.local/node`, then pnpm and each harness's CLI from
 * npm into `~/.local`, at `toolchain`'s versions. Returns each tool's own
 * reported version. Judges' homes get this alone, without Patchy's skill.
 */
export const installToolchain = Effect.fn("Eval.installToolchain")(function* (
  spec: SandboxSpec,
  toolchain: Toolchain,
  harnesses: ReadonlyArray<Builder["harness"]>
) {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  yield* setupStep("Installing Node", spec, "bash", [
    "-c",
    'set -e; mkdir -p ~/.local; curl -fsSL "https://nodejs.org/dist/v$1/node-v$1-linux-$2.tar.xz" | tar -xJ -C ~/.local; mv ~/.local/node-v$1-linux-$2 ~/.local/node',
    "install",
    toolchain.node,
    arch
  ]);
  const unique = [...new Set(harnesses)];
  yield* setupStep("Installing pnpm and the harnesses", spec, "npm", [
    "install",
    "--global",
    "--prefix",
    `${HOME}/.local`,
    "--no-fund",
    "--no-audit",
    `pnpm@${toolchain.pnpm}`,
    ...unique.map((harness) => {
      const [command, pkg] = HARNESS_PACKAGES[harness];
      return `${pkg}@${toolchain[command]}`;
    })
  ]);
  const installed: Array<ToolVersion> = [];
  for (const name of ["node", "pnpm", ...unique.map((harness) => HARNESS_PACKAGES[harness][0])]) {
    const line = yield* setupStep(`Reading ${name}'s version`, spec, name, ["--version"]);
    installed.push({ name, version: versionOf(line) ?? line.trim() });
  }
  return installed;
});

/**
 * A side's template HOME, set up as a person sets up: Node from its release
 * tarball into `~/.local/node`, pnpm and the suite's harnesses from npm into
 * `~/.local`, the instance's installer, then a tier 1 and a tier 2 `patchy
 * init` in the sandbox's own `/tmp` to warm the package store, signed in with
 * the side's scenario publisher. The login is removed afterwards; each run
 * logs in as its own. Returns what was installed, each tool's own version.
 */
export const prepareTemplate = Effect.fn("Eval.prepareTemplate")(function* (input: {
  readonly dir: string;
  readonly apiUrl: string;
  readonly network: Network;
  readonly toolchain: Toolchain;
  readonly builders: ReadonlyArray<Builder>;
  /** A machine token on the side's instance, for the warming `init`s. */
  readonly token: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(input.dir, { recursive: true });
  const spec: SandboxSpec = { home: input.dir, network: input.network };
  const installed = yield* installToolchain(
    spec,
    input.toolchain,
    input.builders.map((builder) => builder.harness)
  );
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
  return installed;
});

/**
 * A run's HOME: a copy-on-write copy of its side's template, logged in as the
 * run's publisher, with its harness's sign-in. Returns the builder's sandbox.
 */
export const prepareHome = Effect.fn("Eval.prepareHome")(function* (input: {
  readonly template: string;
  readonly home: string;
  readonly apiUrl: string;
  readonly network: Network;
  readonly token: string;
  readonly builder: Builder;
  readonly signIns: SignIns;
}) {
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
  const base: SandboxSpec = { home: input.home, network: input.network };
  yield* setupStep(
    "Logging the run's publisher in",
    base,
    "patchy",
    ["auth", "set", "--token-stdin", "--api-url", input.apiUrl, "--json"],
    input.token
  );
  return {
    ...base,
    ...(yield* signInHarness(input.home, input.builder, input.signIns))
  } satisfies SandboxSpec;
});

/**
 * A harness's sign-in in a HOME: for Codex, its `config.toml` and a copy of
 * the developer's login when there is no provider; for Claude Code, its token
 * in the environment or its credentials file mounted read-only. Returns what
 * the sandbox adds for it.
 */
export const signInHarness = Effect.fn("Eval.signInHarness")(function* (
  home: string,
  harness: Pick<Builder, "harness">,
  signIns: SignIns
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (harness.harness === "codex") {
    yield* fs.makeDirectory(path.join(home, ".codex"), { recursive: true });
    yield* fs.writeFileString(path.join(home, ".codex", "config.toml"), signIns.codex.config, {
      mode: 0o600
    });
    if (signIns.codex.auth !== null)
      yield* fs.copyFile(signIns.codex.auth, path.join(home, ".codex", "auth.json"));
    return {} satisfies Pick<SandboxSpec, "env" | "binds">;
  }
  yield* fs.makeDirectory(path.join(home, ".claude"), { recursive: true });
  return {
    env: { ...signIns.claude.env, DISABLE_AUTOUPDATER: "1" },
    binds: signIns.claude.binds
  } satisfies Pick<SandboxSpec, "env" | "binds">;
});
