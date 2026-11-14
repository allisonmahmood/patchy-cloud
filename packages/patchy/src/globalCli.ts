// @effect-diagnostics nodeBuiltinImport:off -- homedir is OS-owned, as State's default state dir is.
/**
 * Refresh's last step: bring this machine's global CLI and skill to the instance's release, so
 * someone who works in existing repos doesn't keep an old global skill. A managed install, the
 * `patchy` package the installer keeps under `~/.patchy/cli`, is updated by the instance's own
 * `/install.mjs`, the one implementation of installing, run by this Node with no shell between.
 * A global skill without one is an install from before that layout, which only the install line
 * can move to it. Only the machine's own instance acts: no `PATCHY_STATE_DIR`, no worktree dev
 * env, and the instance saved in `~/.patchy` is the repo's, so a dev environment, eval or trial
 * never reaches a person's home. The step can only add a warning or stay silent: state it cannot
 * read means doing nothing, and interruption alone passes through.
 */
import { homedir } from "node:os";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import lt from "semver/functions/lt.js";
import valid from "semver/functions/valid.js";
import { LocalError } from "./CliError.js";
import * as Instance from "./Instance.js";
import { processResult } from "./processResult.js";
import { installLine } from "./ReleaseCheck.js";
import * as Setup from "./Setup.js";
import * as State from "./State.js";

/** What refresh reports for this machine: `globalCli` when its install moved, and any warnings. */
export interface GlobalCliResult {
  readonly globalCli?: { readonly from: string; readonly to: string; readonly skill: string };
  readonly warnings: ReadonlyArray<string>;
}

const decodeManaged = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.Literal("patchy"), version: Schema.String }))
);

/** The variable this platform's Node reads the home directory from. */
const homeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME";

/** The managed install's version, `None` when there is none; fails when it can't be read. */
const managedVersion = Effect.fn("globalCli.managedVersion")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
  if (Option.isNone(manifest)) return Option.none<string>();
  return Option.some((yield* decodeManaged(manifest.value)).version);
});

/** A managed install older than the release, from `from`, or a global skill with none. */
type Plan = { readonly kind: "update"; readonly from: string } | { readonly kind: "setUp" };

/** What this machine needs, or `None`: not its own instance, nothing older, or unreadable state. */
const plan = Effect.fn("globalCli.plan")(
  function* (release: string, home: string) {
    const path = yield* Path.Path;
    const state = yield* State.State;
    const instance = yield* Instance.Instance;
    if (
      Option.isSome(yield* Instance.optionalEnv("PATCHY_STATE_DIR")) ||
      instance.source === "dev-env" ||
      state.dir !== path.join(home, ".patchy")
    )
      return Option.none<Plan>();
    const saved = yield* state.readConfigUrl;
    if (!Option.exists(saved, (url) => Instance.normalizeApiUrl(url) === instance.apiUrl))
      return Option.none<Plan>();
    const installed = yield* managedVersion(home);
    if (Option.isNone(installed))
      return (yield* Setup.installed(home))
        ? Option.some<Plan>({ kind: "setUp" })
        : Option.none<Plan>();
    const version = installed.value;
    // Versions only: a same-version rebuild with another digest is not older.
    return valid(version) !== null && valid(release) !== null && lt(version, release)
      ? Option.some<Plan>({ kind: "update", from: version })
      : Option.none<Plan>();
  },
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Option.none<Plan>())
  )
);

/**
 * The instance's `/install.mjs`, downloaded into a temporary folder and run by this Node, with
 * `home` as the home it reads, so it installs where the plan looked. `--release` makes it stop
 * when the instance has moved to another release since refresh read it.
 */
const runInstaller = Effect.fn("globalCli.runInstaller")(function* (
  apiUrl: string,
  release: string,
  home: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const url = `${apiUrl}/install.mjs`;
  const script = yield* http.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError((cause) => new LocalError({ message: `Could not download ${url}.`, cause }))
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "patchy-install-" });
      const file = path.join(dir, "install.mjs");
      yield* fs.writeFileString(file, script);
      return yield* processResult(home, process.execPath, [file, "--release", release], {
        [homeVariable]: home
      });
    })
  );
});

/** A failure's own message, or the defect's. */
const reasonOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return Predicate.isError(error) ? error.message : String(error);
};

/**
 * Brings this machine's global CLI and skill to `release` after a refresh moved the repo there.
 * `globalCli` says what moved, to the version now installed, and where the skill is; a warning
 * carries the install line when the installer stopped, or when the install is one refresh can't
 * update. `home` is for tests.
 */
export const updateGlobalCli = Effect.fn("updateGlobalCli")(
  function* (release: string, home = homedir()) {
    const path = yield* Path.Path;
    const found = yield* plan(release, home);
    if (Option.isNone(found)) return { warnings: [] };
    const { apiUrl } = yield* Instance.Instance;
    const line = installLine(apiUrl);
    if (found.value.kind === "setUp")
      return {
        warnings: [
          `This machine's patchy CLI and skill were installed before the installer kept them under ~/.patchy, so refresh can't update them. Run the install line once; refreshes keep both current after that:\n${line}`
        ]
      };
    const { from } = found.value;
    const ran = yield* runInstaller(apiUrl, release, home).pipe(Effect.exit);
    if (Exit.isFailure(ran) && Cause.hasInterrupts(ran.cause)) return yield* Effect.interrupt;
    if (Exit.isSuccess(ran) && ran.value.code === 0) {
      const to = yield* managedVersion(home);
      if (Option.isSome(to))
        return {
          globalCli: { from, to: to.value, skill: path.join(Setup.skillCopy(home), "SKILL.md") },
          warnings: []
        };
    }
    // The installer's own failures name their fix; anything else is relayed as it was printed.
    const reason = Exit.isFailure(ran)
      ? reasonOf(ran.cause)
      : ran.value.code === 0
        ? "The installer finished, but there is no patchy package under ~/.patchy/cli."
        : ran.value.stderr.trim() ||
          ran.value.stdout.trim() ||
          `The installer exited with code ${ran.value.code}.`;
    return {
      warnings: [
        `Updating this machine's patchy CLI and skill from ${from} to ${release} stopped:\n${reason}\nInstall line: ${line}`
      ]
    };
  },
  // The refresh already committed: a defect here is no reason to fail it.
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.interrupt
      : Effect.succeed<GlobalCliResult>({ warnings: [] })
  )
);
