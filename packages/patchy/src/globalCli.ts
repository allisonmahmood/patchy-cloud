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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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

/** Generous for a script of a few kilobytes; past either, the download is abandoned. */
const installerLimit = { bytes: 1024 * 1024, label: "1 MiB", seconds: 30 };

/**
 * The instance's `/install.mjs` as text: a 200, at most `installerLimit.bytes`, within
 * `installerLimit.seconds`. Anything else is a `LocalError` naming why.
 */
const downloadInstaller = Effect.fn("globalCli.downloadInstaller")(
  function* (url: string) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .get(url)
      .pipe(
        Effect.mapError((cause) => new LocalError({ message: `Could not download ${url}.`, cause }))
      );
    if (response.status !== 200)
      return yield* new LocalError({
        message: `${url} answered ${response.status}, not the installer.`
      });
    const { chunks } = yield* response.stream.pipe(
      Stream.mapError((cause) => new LocalError({ message: `Could not download ${url}.`, cause })),
      Stream.runFoldEffect(
        () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
        ({ size, chunks }, chunk) =>
          size + chunk.length > installerLimit.bytes
            ? Effect.fail(
                new LocalError({
                  message: `${url} sent more than ${installerLimit.label}, which is not the installer.`
                })
              )
            : Effect.succeed({ size: size + chunk.length, chunks: [...chunks, chunk] })
      )
    );
    return Buffer.concat(chunks).toString("utf8");
  },
  (download, url) =>
    Effect.timeoutOrElse(download, {
      duration: Duration.seconds(installerLimit.seconds),
      orElse: () =>
        Effect.fail(
          new LocalError({
            message: `${url} did not send the installer within ${installerLimit.seconds} seconds.`
          })
        )
    })
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
  const script = yield* downloadInstaller(`${apiUrl}/install.mjs`);
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
 * `globalCli` says what moved and where the skill is, only once `~/.patchy/cli` holds `release`;
 * a warning carries the install line when the installer stopped or left another version, or when
 * the install is one refresh can't update. `home` is for tests.
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
    const finished = Exit.isSuccess(ran) && ran.value.code === 0;
    const installed = finished ? yield* managedVersion(home) : Option.none<string>();
    // Only the release refresh asked for counts: an installer that did nothing exits 0 too.
    if (Option.contains(installed, release))
      return {
        globalCli: { from, to: release, skill: path.join(Setup.skillCopy(home), "SKILL.md") },
        warnings: []
      };
    // The installer's own failures name their fix; anything else is relayed as it was printed.
    const reason = Exit.isFailure(ran)
      ? reasonOf(ran.cause)
      : !finished
        ? ran.value.stderr.trim() ||
          ran.value.stdout.trim() ||
          `The installer exited with code ${ran.value.code}.`
        : Option.match(installed, {
            onNone: () =>
              "The installer finished, but there is no patchy package under ~/.patchy/cli.",
            onSome: (version) =>
              `The installer finished, but ~/.patchy/cli holds patchy ${version}, not ${release}.`
          });
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
