/**
 * Evidence instances: throwaway Patchy Clouds at exact commits, for showing a
 * change in a PR. `pnpm dev compare` and `film` capture both sides here, never
 * in the developer's own environment, so patches are built from each commit's
 * scenario sources, flows that change data are repeatable, and the public
 * uploads only ever hold scenario data.
 *
 * Each side is a shared clone (`git clone --shared`, so it is no worktree) at
 * `$XDG_DATA_HOME/patchy-dev/<label>.evidence/{before,after}`, checked out at
 * its commit and brought up with its own runner on a fresh scenario. When the
 * run ends, however it ends, a finalizer takes both instances down with their
 * own runners, which deletes their data. The checkouts and `node_modules`
 * stay, so the next run skips the clone and installs incrementally. One run at
 * a time per worktree: the lock folder `<label>.evidence.lock/`, made before
 * anything else, spans setup, capture and cleanup. `pnpm dev down` takes it
 * too before deleting the checkouts, and never deletes the lock folder: a run
 * starting at that moment would lose its entry.
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { environmentDir, layoutFor, readManifest } from "./environment.js";
import { alive } from "./process.js";
import { Person } from "./scenario.js";
import { stepOutput } from "./steps.js";

export class EvidenceBusy extends Schema.TaggedError<EvidenceBusy>()("EvidenceBusy", {
  pid: Schema.Int,
  command: Schema.String,
  started: Schema.String
}) {
  override get message() {
    return `\`pnpm dev ${this.command}\` (pid ${this.pid}, since ${this.started}) is using this worktree's evidence instances. Wait for it to finish, or interrupt it; it cleans up either way.`;
  }
}

export class UncommittedChanges extends Schema.TaggedError<UncommittedChanges>()(
  "UncommittedChanges",
  {}
) {
  override get message() {
    return "Evidence shows commits, and this worktree has uncommitted changes or new files. Commit and push them first, so the PR shows what the evidence shows.";
  }
}

export class SideUnhealthy extends Schema.TaggedError<SideUnhealthy>()("SideUnhealthy", {
  side: Schema.String,
  apiUrl: Schema.String
}) {
  override get message() {
    return `The ${this.side} instance came up but ${this.apiUrl}/healthz does not answer.`;
  }
}

export class WrongCheckout extends Schema.TaggedError<WrongCheckout>()("WrongCheckout", {
  side: Schema.String,
  wanted: Schema.String,
  found: Schema.String
}) {
  override get message() {
    return `The ${this.side} checkout is at ${this.found.slice(0, 7)} after checking out ${this.wanted.slice(0, 7)}.`;
  }
}

/** A commit a side shows, and how the output names it. */
export interface Commit {
  readonly sha: string;
  readonly label: string;
}

export type SideName = "before" | "after";

/** What a side's `pnpm dev up --json` printed that the evidence commands need. */
export const Served = Schema.Struct({
  apiUrl: Schema.String,
  scenario: Schema.String,
  people: Schema.Array(Person)
});
export type Served = typeof Served.Type;
const decodeServed = Schema.decodeUnknownEffect(Schema.fromJsonString(Served));

/** A side that is up: its commit, its checkout and what it serves. */
export interface Side {
  readonly name: SideName;
  readonly commit: Commit;
  readonly clone: string;
  readonly served: Served;
}

/**
 * The "before" side: up, unavailable (its commit could not set up the
 * scenario, or lacks the person; the evidence then shows "after" only), or
 * not asked for.
 */
export type Before =
  | { readonly status: "served"; readonly side: Side }
  | { readonly status: "unavailable"; readonly commit: Commit; readonly reason: string }
  | { readonly status: "skipped" };

/** What the PR section says about where each side came from. */
export interface Provenance {
  readonly command: string;
  readonly scenario: string;
  readonly before: Before;
  readonly after: Commit;
}

const short = (sha: string) => sha.slice(0, 7);

/** The opening lines every evidence section shares: the commits, the scenario, and a missing "before". */
export const provenanceLines = (input: Provenance) => {
  const after = `\`${short(input.after.sha)}\` (${input.after.label})`;
  const from = `on the \`${input.scenario}\` scenario, from \`pnpm dev ${input.command}\``;
  if (input.before.status === "skipped") return [`After is ${after}, ${from}.`];
  const commit = input.before.status === "served" ? input.before.side.commit : input.before.commit;
  const lines = [
    `Before is \`${short(commit.sha)}\` (${commit.label}) and after is ${after}, both ${from}.`
  ];
  if (input.before.status === "unavailable")
    lines.push("", `Before couldn't be shown: ${input.before.reason} This shows after only.`);
  return lines;
};

/** Where a worktree's evidence checkouts live, and the lock folder beside them. */
export const evidencePaths = (worktree: string) =>
  Effect.map(environmentDir(worktree), (dir) => ({
    dir: `${dir}.evidence`,
    lock: `${dir}.evidence.lock`
  }));

// ---- Commits ----------------------------------------------------------------

const git = (root: string, step: string, args: ReadonlyArray<string>) =>
  stepOutput(step, "git", args, { cwd: root, prefix: "git" });

/**
 * "After" is `HEAD`. "Before" is `base` when given, otherwise where `HEAD`
 * left `origin/<baseBranch>` (`main`, or the PR's base branch, fetched first
 * so it is current). The evidence is of commits, so `dirty` says whether the
 * working tree holds changes or new files that are not in them; ignored
 * files, such as flows under `.local/`, don't count.
 */
export const resolveCommits = Effect.fn("Evidence.resolveCommits")(function* (
  root: string,
  options: { readonly base: Option.Option<string>; readonly baseBranch: Option.Option<string> }
) {
  const head = yield* git(root, "Reading HEAD", ["rev-parse", "HEAD"]);
  const branch = yield* git(root, "Reading the branch", ["rev-parse", "--abbrev-ref", "HEAD"]);
  // New files count too: an untracked source file is as missing from the evidence as an edit.
  const dirty =
    (yield* git(root, "Checking for uncommitted changes", ["status", "--porcelain"])) !== "";
  const after: Commit = { sha: head, label: branch === "HEAD" ? "HEAD" : branch };
  if (Option.isSome(options.base)) {
    const sha = yield* git(root, "Resolving --base", [
      "rev-parse",
      "--verify",
      `${options.base.value}^{commit}`
    ]);
    // A sha names itself; a branch or tag is worth naming.
    const label = sha.startsWith(options.base.value) ? "--base" : `--base ${options.base.value}`;
    return { before: { sha, label } satisfies Commit, after, dirty };
  }
  const baseBranch = Option.getOrElse(options.baseBranch, () => "main");
  if (Option.isSome(options.baseBranch))
    yield* git(root, `Fetching ${baseBranch}`, ["fetch", "--quiet", "origin", baseBranch]);
  const sha = yield* git(root, "Finding the merge base", [
    "merge-base",
    "HEAD",
    `origin/${baseBranch}`
  ]);
  return {
    before: { sha, label: `where this branch left ${baseBranch}` } satisfies Commit,
    after,
    dirty
  };
});

/** The scenario both sides run: the requested one, this worktree's environment's, or `team`. */
export const scenarioFor = Effect.fn("Evidence.scenarioFor")(function* (
  root: string,
  requested: Option.Option<string>
) {
  if (Option.isSome(requested)) return requested.value;
  const manifest = yield* readManifest(yield* layoutFor(root));
  return Option.isSome(manifest) ? manifest.value.scenario : "team";
});

// ---- The lock ---------------------------------------------------------------

const LockRecord = Schema.Struct({
  pid: Schema.Int,
  command: Schema.String,
  started: Schema.String
});
type Lock = typeof LockRecord.Type;
const LockJson = Schema.fromJsonString(LockRecord);
const decodeLock = Schema.decodeUnknownEffect(LockJson);
const encodeLock = Schema.encodeSync(LockJson);

/**
 * Holds the lock folder `dir` for the rest of the scope, or fails at once
 * with who holds it. Each run writes its own entry there (whole, then renamed
 * into place, so no one reads half of it), then looks at the others: any live
 * one means another run holds the lock, and this one withdraws its entry. Two
 * runs can't both hold it, since each writes before it looks; two that start
 * at the same instant may both withdraw. An entry whose process is gone is
 * stale and is deleted, so a run that was killed never blocks the next one.
 */
export const acquireLock = Effect.fn("Evidence.acquireLock")(function* (
  dir: string,
  command: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  const mine: Lock = {
    pid: process.pid,
    command,
    started: DateTime.formatIso(yield* DateTime.now)
  };
  const entry = path.join(dir, `${mine.pid}-${(yield* Random.nextInt).toString(36)}.json`);
  yield* fs.writeFileString(`${entry}.tmp`, encodeLock(mine));
  yield* fs.rename(`${entry}.tmp`, entry);
  yield* Effect.addFinalizer(() => fs.remove(entry, { force: true }).pipe(Effect.ignore));
  for (const name of yield* fs.readDirectory(dir)) {
    const other = path.join(dir, name);
    if (other === entry || !name.endsWith(".json")) continue;
    const held = yield* fs.readFileString(other).pipe(Effect.flatMap(decodeLock), Effect.option);
    if (Option.isSome(held) && (yield* alive(held.value.pid))) {
      yield* fs.remove(entry, { force: true });
      return yield* new EvidenceBusy(held.value);
    }
    yield* fs.remove(other, { force: true }).pipe(Effect.ignore);
  }
});

// ---- Clones -----------------------------------------------------------------

/** What a side's checkout holds before a run, read from the checkout itself. */
export type CloneState =
  | { readonly exists: false }
  | {
      readonly exists: true;
      /** `HEAD` in the clone. */
      readonly sha: string;
      /** Tracked files differ from `HEAD`, as in a clone made without checking out. */
      readonly dirty: boolean;
      /** An instance or environment from an earlier run that never cleaned up. */
      readonly leftover: boolean;
    };

/**
 * Reuse or move: what a side's checkout needs before its instance comes up.
 * A leftover instance is taken down with the checkout's own runner before
 * anything moves; a checkout at another commit, or with stray changes, is
 * checked out at `wanted`. The install always runs: on a reused checkout it is
 * incremental and finishes an install that was interrupted.
 */
export const clonePlan = (state: CloneState, wanted: string) =>
  state.exists
    ? { clone: false, takeDown: state.leftover, checkout: state.sha !== wanted || state.dirty }
    : { clone: true, takeDown: false, checkout: true };

/**
 * Commands in a clone get a closed environment: what pnpm, git and the runner
 * need, with none of the shell's PATCHY_* settings and without the worktree's
 * own `node_modules/.bin`, which `pnpm dev` put first on PATH.
 */
const cloneEnv = Effect.fn("Evidence.cloneEnv")(function* (root: string) {
  const path = yield* Path.Path;
  const optional = (name: string) => Config.option(Config.String(name));
  const settings = yield* Config.all({
    PATH: Config.String("PATH").pipe(Config.withDefault("")),
    HOME: Config.String("HOME"),
    TMPDIR: optional("TMPDIR"),
    XDG_DATA_HOME: optional("XDG_DATA_HOME"),
    XDG_CACHE_HOME: optional("XDG_CACHE_HOME"),
    XDG_CONFIG_HOME: optional("XDG_CONFIG_HOME"),
    PLAYWRIGHT_BROWSERS_PATH: optional("PLAYWRIGHT_BROWSERS_PATH")
  });
  const env: Record<string, string> = { HOME: settings.HOME };
  for (const name of [
    "TMPDIR",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "PLAYWRIGHT_BROWSERS_PATH"
  ] as const) {
    const value = settings[name];
    if (Option.isSome(value)) env[name] = value.value;
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  env.PATH = settings.PATH.split(delimiter)
    .filter((dir) => dir !== "" && !path.resolve(dir).startsWith(`${root}${path.sep}`))
    .join(delimiter);
  return env;
});

/** Whether a checkout's runner left an instance or environment behind: its state dir or its environment folder. */
const hasInstance = Effect.fn("Evidence.hasInstance")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (
    (yield* fs.exists(path.join(dir, ".local", "dev"))) ||
    (yield* fs.exists(yield* environmentDir(dir)))
  );
});

const readCloneState = Effect.fn("Evidence.readCloneState")(function* (
  dir: string,
  env: Record<string, string>
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(path.join(dir, ".git")))) return { exists: false } satisfies CloneState;
  const options = { cwd: dir, env, prefix: "git" };
  const sha = yield* stepOutput("Reading the checkout", "git", ["rev-parse", "HEAD"], options);
  const status = yield* stepOutput(
    "Checking the checkout",
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    options
  );
  return {
    exists: true,
    sha,
    dirty: status !== "",
    leftover: yield* hasInstance(dir)
  } satisfies CloneState;
});

/**
 * Takes a side's instance down with its own runner, which deletes its data, with the Pidgeon test
 * admin key so the keys the instance holds are revoked first.
 */
const takeDown = (dir: string, side: SideName, env: Record<string, string>) =>
  Effect.flatMap(withPidgeonKey(env), (withKey) =>
    stepOutput(`Taking the ${side} instance down`, "pnpm", ["--silent", "dev", "down"], {
      cwd: dir,
      env: withKey,
      prefix: side
    })
  );
/** `env` and, when this environment has one, the Pidgeon test admin key: for `up` and `down` alone. */
const withPidgeonKey = (env: Record<string, string>) =>
  Effect.map(Config.option(Config.String("PIDGEON_TEST_ADMIN_KEY")), (key) =>
    Option.isSome(key) ? { ...env, PIDGEON_TEST_ADMIN_KEY: key.value } : env
  );

/** The side's checkout at `commit`, installed: cloned, reused or moved per `clonePlan`. */
const prepare = Effect.fn("Evidence.prepare")(function* (
  root: string,
  dir: string,
  side: SideName,
  commit: Commit,
  env: Record<string, string>
) {
  const plan = clonePlan(yield* readCloneState(dir, env), commit.sha);
  const options = { cwd: dir, env, prefix: side };
  if (plan.clone) {
    yield* Console.error(`  ${side.padEnd(6)}  cloning at ${commit.sha.slice(0, 7)}`);
    const common = yield* git(root, "Finding the repository", [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir"
    ]);
    yield* stepOutput(
      `Cloning the ${side} checkout`,
      "git",
      ["clone", "--quiet", "--shared", "--no-checkout", common, dir],
      { ...options, cwd: root }
    );
  }
  if (plan.takeDown) yield* takeDown(dir, side, env);
  if (plan.checkout) {
    if (!plan.clone)
      yield* Console.error(`  ${side.padEnd(6)}  moving to ${commit.sha.slice(0, 7)}`);
    yield* stepOutput(
      `Checking out ${side}`,
      "git",
      ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", commit.sha],
      options
    );
  }
  const found = yield* stepOutput("Reading the checkout", "git", ["rev-parse", "HEAD"], options);
  if (found !== commit.sha) return yield* new WrongCheckout({ side, wanted: commit.sha, found });
  yield* stepOutput(
    `Installing ${side}`,
    "pnpm",
    ["install", "--frozen-lockfile", "--prefer-offline", "--reporter=silent"],
    options
  );
});

/**
 * `pnpm dev up <scenario>` in the checkout, checked by asking the instance itself. A Pidgeon test
 * admin key in this environment reaches `up` and `down` alone, so a scenario's Pidgeon connection
 * is made, and its key revoked again.
 */
const bringUp = Effect.fn("Evidence.bringUp")(function* (
  dir: string,
  side: SideName,
  scenario: string,
  env: Record<string, string>
) {
  const served = yield* decodeServed(
    yield* stepOutput(
      `Bringing the ${side} instance up`,
      "pnpm",
      ["--silent", "dev", "up", scenario, "--json"],
      {
        cwd: dir,
        env: yield* withPidgeonKey(env),
        prefix: side
      }
    )
  );
  const healthy = yield* HttpClient.get(`${served.apiUrl}/healthz`).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() => false)
  );
  if (!healthy) return yield* new SideUnhealthy({ side, apiUrl: served.apiUrl });
  return served;
});

/**
 * One side, up for the rest of the scope. The finalizer is registered before
 * `up` starts, so an `up` that fails or is interrupted halfway is taken down
 * too. A take-down that fails is reported, not raised: the evidence is
 * already captured, and the next run tries again first.
 */
const serveSide = Effect.fn("Evidence.serveSide")(function* (
  root: string,
  name: SideName,
  commit: Commit,
  scenario: string,
  runDir: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join((yield* evidencePaths(root)).dir, name);
  const env = yield* cloneEnv(root);
  yield* prepare(root, dir, name, commit, env);
  yield* Effect.addFinalizer(() =>
    hasInstance(dir).pipe(
      Effect.flatMap((up) =>
        up
          ? Console.error(`  ${name.padEnd(6)}  taking the instance down`).pipe(
              Effect.andThen(takeDown(dir, name, env))
            )
          : Effect.void
      ),
      Effect.catch((error) =>
        Console.error(
          `The ${name} instance did not come down (${error.message}). Run \`pnpm dev down\` in ${dir}.`
        )
      )
    )
  );
  yield* Console.error(`  ${name.padEnd(6)}  bringing up ${scenario}`);
  // The take-down deletes the instance's log, so a side that fails to come up keeps a copy.
  const log = path.join(dir, ".local", "dev", "dev.log");
  const kept = path.join(runDir, `${name}-dev.log`);
  const served = yield* bringUp(dir, name, scenario, env).pipe(
    Effect.tapError(() =>
      fs
        .copyFile(log, kept)
        .pipe(
          Effect.andThen(Console.error(`  ${name.padEnd(6)}  its dev.log is kept at ${kept}`)),
          Effect.ignore
        )
    )
  );
  return { name, commit, clone: dir, served } satisfies Side;
});

/**
 * Both sides on `scenario`, up together, for the rest of the scope, holding
 * the worktree's evidence lock throughout. "After" must come up; a "before"
 * that cannot is reported as unavailable instead. `before: None` skips it.
 */
export const evidence = Effect.fn("Evidence.evidence")(function* (input: {
  readonly root: string;
  readonly command: string;
  readonly scenario: string;
  readonly before: Option.Option<Commit>;
  readonly after: Commit;
  /** The run's folder, absolute; a side that fails to come up leaves its log here. */
  readonly runDir: string;
}) {
  yield* acquireLock((yield* evidencePaths(input.root)).lock, input.command);
  const [before, after] = yield* Effect.all(
    [
      Option.match(input.before, {
        onNone: () => Effect.succeed<Before>({ status: "skipped" }),
        onSome: (commit) => {
          const unavailable = (reason: string) =>
            Effect.succeed<Before>({ status: "unavailable", commit, reason });
          return serveSide(input.root, "before", commit, input.scenario, input.runDir).pipe(
            Effect.map((side): Before => ({ status: "served", side })),
            // The reason goes in a public PR, so it names the step, never its output.
            Effect.catchTags({
              StepExited: (error) => unavailable(`${error.step} failed (exit ${error.exitCode}).`),
              StepUnavailable: (error) => unavailable(`${error.step} could not start.`),
              SchemaError: () => unavailable("Its `pnpm dev up --json` printed something else."),
              SideUnhealthy: (error) => unavailable(error.message),
              WrongCheckout: (error) => unavailable(error.message)
            }),
            Effect.catch(() => unavailable("It could not be set up."))
          );
        }
      }),
      serveSide(input.root, "after", input.after, input.scenario, input.runDir)
    ],
    { concurrency: "unbounded" }
  );
  return { before, after };
});

/**
 * For `pnpm dev down`: takes any leftover evidence instance down and deletes
 * the checkouts, holding the lock so no run is setting up meanwhile. The lock
 * folder stays, empty. Returns whether there was anything to delete.
 */
export const removeEvidence = Effect.fn("Evidence.removeEvidence")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { dir, lock } = yield* evidencePaths(root);
  // A run makes the lock folder before anything else: with neither, there is no run and nothing to delete.
  if (!(yield* fs.exists(dir)) && !(yield* fs.exists(lock))) return false;
  yield* acquireLock(lock, "down");
  if (!(yield* fs.exists(dir))) return false;
  const env = yield* cloneEnv(root);
  for (const side of ["before", "after"] as const) {
    const clone = path.join(dir, side);
    const state = yield* readCloneState(clone, env).pipe(
      Effect.orElseSucceed((): CloneState => ({ exists: false }))
    );
    if (state.exists && state.leftover) yield* takeDown(clone, side, env);
  }
  yield* fs.remove(dir, { recursive: true, force: true });
  return true;
}, Effect.scoped);
