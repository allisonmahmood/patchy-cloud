// @effect-diagnostics nodeBuiltinImport:off -- homedir is OS-owned, as State's default state dir is.
/**
 * Refresh's last step: bring this machine's global CLI and skill to the instance's release, so
 * someone who works in existing repos doesn't keep an old global skill. A managed install, the
 * `patchy` package the installer keeps under `~/.patchy/cli`, is updated by running the instance's
 * install line, the one implementation of installing. A global skill without one is an install
 * from before that layout, which only that line can move to it. Only the machine's own instance
 * acts: the default state dir, whose saved instance is the repo's, so a dev environment, eval or
 * trial never reaches a person's home. Nothing here fails a refresh, and state it cannot read
 * means doing nothing.
 */
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import lt from "semver/functions/lt.js";
import valid from "semver/functions/valid.js";
import * as Instance from "./Instance.js";
import { processResult } from "./processResult.js";
import { installLine } from "./ReleaseCheck.js";
import * as Setup from "./Setup.js";
import * as State from "./State.js";

const decodeManaged = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.Literal("patchy"), version: Schema.String }))
);

/**
 * The shell that runs the install line as a person's terminal would, and the variable its Node
 * reads the home from: set to the home the plan looked in, so the installer installs there.
 */
const shell =
  process.platform === "win32"
    ? {
        command: "powershell",
        args: ["-NoProfile", "-NonInteractive", "-Command"],
        home: "USERPROFILE"
      }
    : { command: "sh", args: ["-c"], home: "HOME" };

/** A managed install older than the release, from `from`, or a global skill with none. */
type Plan = { readonly kind: "update"; readonly from: string } | { readonly kind: "setUp" };

/** What this machine needs, or `None`: not its own instance, nothing older, or unreadable state. */
const plan = Effect.fn("globalCli.plan")(
  function* (release: string, home: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const state = yield* State.State;
    const instance = yield* Instance.Instance;
    if (state.dir !== path.join(home, ".patchy")) return Option.none<Plan>();
    const saved = yield* state.readConfigUrl;
    if (!Option.exists(saved, (url) => Instance.normalizeApiUrl(url) === instance.apiUrl))
      return Option.none<Plan>();
    const manifest = yield* fs
      .readFileString(path.join(home, ".patchy", "cli", "node_modules", "patchy", "package.json"))
      .pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : Effect.fail(cause)
        })
      );
    if (Option.isNone(manifest))
      return (yield* Setup.installed(home))
        ? Option.some<Plan>({ kind: "setUp" })
        : Option.none<Plan>();
    const { version } = yield* decodeManaged(manifest.value);
    // Versions only: a same-version rebuild with another digest is not older.
    return valid(version) !== null && valid(release) !== null && lt(version, release)
      ? Option.some<Plan>({ kind: "update", from: version })
      : Option.none<Plan>();
  },
  Effect.orElseSucceed(() => Option.none<Plan>())
);

/**
 * Brings this machine's global CLI and skill to `release` after a refresh moved the repo there.
 * `globalCli` says what moved and where the skill is; a warning carries the install line when
 * the installer stopped, or when the install is one refresh can't update. `home` is for tests.
 */
export const updateGlobalCli = Effect.fn("updateGlobalCli")(function* (
  release: string,
  home = homedir()
) {
  const path = yield* Path.Path;
  const found = yield* plan(release, home);
  if (Option.isNone(found)) return { warnings: [] };
  const line = installLine((yield* Instance.Instance).apiUrl);
  if (found.value.kind === "setUp")
    return {
      warnings: [
        `This machine's patchy CLI and skill were installed before the installer kept them under ~/.patchy, so refresh can't update them. Run the install line once; refreshes keep both current after that:\n${line}`
      ]
    };
  const { from } = found.value;
  const ran = yield* processResult(home, shell.command, [...shell.args, line], {
    [shell.home]: home
  }).pipe(Effect.result);
  if (ran._tag === "Success" && ran.success.code === 0)
    return {
      globalCli: { from, to: release, skill: path.join(Setup.skillCopy(home), "SKILL.md") },
      warnings: []
    };
  // The installer's own failures name their fix; curl's and the shell's are relayed as printed.
  const reason =
    ran._tag === "Failure"
      ? ran.failure.message
      : ran.success.stderr.trim() ||
        ran.success.stdout.trim() ||
        `It exited with code ${ran.success.code}.`;
  return {
    warnings: [
      `Updating this machine's patchy CLI and skill from ${from} to ${release} stopped:\n${reason}\nInstall line: ${line}`
    ]
  };
});
