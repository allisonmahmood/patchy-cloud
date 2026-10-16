/**
 * Before and after, for a PR: `pnpm dev compare` and `pnpm dev film`.
 *
 * The "before" side is a shared clone of this repo at the PR's base, kept
 * beside the environment folder (`$XDG_DATA_HOME/patchy-dev/<label>.base`)
 * and brought up with its own runner on the same scenario. The "after" side
 * is this worktree's environment, restarted so it serves the working tree.
 * This worktree's code drives the browser for both; the base only serves.
 * `pnpm dev down` stops and deletes the base with everything else.
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  environmentDir,
  layoutFor,
  readManifest,
  StepExited,
  StepUnavailable
} from "./environment.js";
import { Person } from "./scenario.js";

export class CaptureFailed extends Schema.TaggedError<CaptureFailed>()("CaptureFailed", {
  what: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `${this.what} failed: ${String(this.cause)}. If Playwright's browser is missing, run \`pnpm exec playwright install chromium\`.`;
  }
}

/** What either side's `pnpm dev up --json` printed that compare and film need. */
const Served = Schema.Struct({
  apiUrl: Schema.String,
  scenario: Schema.String,
  people: Schema.Array(Person)
});
export type Served = typeof Served.Type;
const decodeServed = Schema.decodeUnknownEffect(Schema.fromJsonString(Served));

/** What the base checkout is serving, so a second run reuses it. */
const BaseRecord = Schema.Struct({ sha: Schema.String, scenario: Schema.String });
const BaseRecordJson = Schema.fromJsonString(BaseRecord);
const decodeBaseRecord = Schema.decodeUnknownEffect(BaseRecordJson);
const encodeBaseRecord = Schema.encodeSync(BaseRecordJson);

/** The commit "before" means, and how the output names it. */
export interface Base {
  readonly sha: string;
  readonly label: string;
}

/**
 * Runs a command and returns its trimmed stdout. Its stderr goes to ours line
 * by line under `prefix`, so a slow base shows its progress.
 */
const capture = Effect.fn("Compare.capture")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  prefix: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], { cwd, stdin: "ignore", extendEnv: true })
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => Console.error(`  ${prefix}  ${line}`))
          ),
          handle.exitCode
        ],
        { concurrency: "unbounded" }
      );
      if (exitCode !== 0) return yield* new StepExited({ step, exitCode });
      return stdout.trim();
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new StepUnavailable({ step, cause }))
    })
  );
});

/** `ref` when given, otherwise where this branch left `origin/main`. */
export const resolveBase = Effect.fn("Compare.resolveBase")(function* (
  worktree: string,
  ref: Option.Option<string>
) {
  const sha = Option.isSome(ref)
    ? yield* capture(
        "Resolving the base",
        "git",
        ["rev-parse", "--verify", `${ref.value}^{commit}`],
        worktree,
        "git"
      )
    : yield* capture(
        "Finding the base",
        "git",
        ["merge-base", "HEAD", "origin/main"],
        worktree,
        "git"
      );
  const short = sha.slice(0, 7);
  return {
    sha,
    label: Option.isSome(ref) ? `${ref.value} (${short})` : `main (${short})`
  } satisfies Base;
});

/** The scenario both sides run: this worktree's environment's, or `team`. */
export const scenarioFor = Effect.fn("Compare.scenarioFor")(function* (
  worktree: string,
  requested: Option.Option<string>
) {
  if (Option.isSome(requested)) return requested.value;
  const manifest = yield* readManifest(yield* layoutFor(worktree));
  return Option.isSome(manifest) ? manifest.value.scenario : "team";
});

const baseDirOf = (worktree: string) =>
  Effect.map(environmentDir(worktree), (dir) => `${dir}.base`);

const devUp = (dir: string, scenario: string, prefix: string) =>
  capture(
    `Bringing up the ${prefix} environment`,
    "pnpm",
    ["--silent", "dev", "up", scenario, "--json"],
    dir,
    prefix
  ).pipe(Effect.flatMap(decodeServed));

/**
 * The base, served on `scenario`. A checkout already at `base.sha` on the
 * same scenario is reused; anything else is taken down, moved to the base and
 * reinstalled first.
 */
export const serveBase = Effect.fn("Compare.serveBase")(function* (
  worktree: string,
  base: Base,
  scenario: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* baseDirOf(worktree);
  const recordFile = path.join(dir, ".local", "compare-base.json");
  const recorded = (yield* fs.exists(recordFile))
    ? yield* fs.readFileString(recordFile).pipe(Effect.flatMap(decodeBaseRecord), Effect.option)
    : Option.none();
  const current =
    Option.isSome(recorded) &&
    recorded.value.sha === base.sha &&
    recorded.value.scenario === scenario;
  if (!current) {
    if (yield* fs.exists(path.join(dir, ".git"))) {
      yield* Console.error(`Moving the base to ${base.label}`);
      yield* capture(
        "Taking the old base down",
        "pnpm",
        ["--silent", "dev", "down"],
        dir,
        "before"
      );
    } else {
      yield* Console.error(`Checking out the base, ${base.label}`);
      const common = yield* capture(
        "Finding the repository",
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        worktree,
        "git"
      );
      yield* capture(
        "Cloning the base",
        "git",
        ["clone", "--quiet", "--shared", "--no-checkout", common, dir],
        worktree,
        "git"
      );
    }
    yield* capture(
      "Checking out the base",
      "git",
      ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", "--detach", base.sha],
      dir,
      "git"
    );
    yield* capture(
      "Installing the base",
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline", "--reporter=silent"],
      dir,
      "before"
    );
    yield* fs.makeDirectory(path.dirname(recordFile), { recursive: true });
    yield* fs.writeFileString(recordFile, encodeBaseRecord({ sha: base.sha, scenario }));
  }
  return yield* devUp(dir, scenario, "before");
});

/**
 * This worktree's environment on `scenario`, restarted first: the server is
 * not watched, so a running one may still serve code from before the change.
 */
export const serveHead = Effect.fn("Compare.serveHead")(function* (
  worktree: string,
  scenario: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fs.exists(path.join(worktree, ".local", "dev", "plan.json")))
    yield* capture(
      "Stopping this instance",
      "pnpm",
      ["--silent", "dev", "stop"],
      worktree,
      "after"
    );
  return yield* devUp(worktree, scenario, "after");
});

/** Stops and deletes the base checkout, if there is one. */
export const tearDownBase = Effect.fn("Compare.tearDownBase")(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* baseDirOf(worktree);
  if (!(yield* fs.exists(dir))) return false;
  if (yield* fs.exists(path.join(dir, "node_modules")))
    yield* capture("Taking the base down", "pnpm", ["--silent", "dev", "down"], dir, "before");
  yield* fs.remove(dir, { recursive: true, force: true });
  return true;
});

/** One side's view of one page at one width. */
export const Capture = Schema.Struct({
  side: Schema.Literals(["before", "after"]),
  target: Schema.String,
  width: Schema.Int,
  url: Schema.String,
  status: Schema.NullOr(Schema.Int),
  file: Schema.String,
  errors: Schema.Array(Schema.String)
});
export type Capture = typeof Capture.Type;

/** Where a page at a width lands for one side, under `dir`. */
export const shotFile = (dir: string, side: string, target: string, width: number) =>
  `${dir}/${side}-${target.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "home"}-${width}.png`;

/**
 * Full-page PNGs of every target at every width, signed in as `email` on each
 * side, at twice the pixel density so text stays sharp when zoomed. One
 * browser, a fresh context per shot.
 */
export const shootAll = Effect.fn("Compare.shootAll")(function* (
  sides: ReadonlyArray<{ readonly side: "before" | "after"; readonly apiUrl: string }>,
  email: string,
  targets: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
  dir: string
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      const shots: Array<Capture> = [];
      try {
        for (const target of targets)
          for (const width of widths)
            for (const { side, apiUrl } of sides) {
              const context = await browser.newContext({
                viewport: { width, height: 800 },
                deviceScaleFactor: 2
              });
              const page = await context.newPage();
              const errors: Array<string> = [];
              page.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
              });
              page.on("pageerror", (error) => errors.push(error.message));
              const response = await page.goto(
                `${apiUrl}/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent(target)}`
              );
              await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
              await page.evaluate(() => document.fonts.ready.then(() => undefined));
              const file = shotFile(dir, side, target, width);
              await page.screenshot({ path: file, fullPage: true });
              shots.push({
                side,
                target,
                width,
                url: page.url(),
                status: response?.status() ?? null,
                file,
                errors
              });
              await context.close();
            }
      } finally {
        await browser.close();
      }
      return shots;
    },
    catch: (cause) => new CaptureFailed({ what: "Taking the screenshots", cause })
  });
});

/**
 * The PR body section: per page, a Width | Before | After table, with paths
 * relative to the worktree so `gh pr edit --attach <path>` rewrites each one
 * to its upload. A width whose two PNGs are byte-identical says so instead.
 */
export const compareMarkdown = (input: {
  readonly person: Person;
  readonly base: Base;
  readonly shots: ReadonlyArray<Capture & { readonly relative: string }>;
  readonly identical: (target: string, width: number) => boolean;
}) => {
  const lines: Array<string> = [];
  const targets = [...new Set(input.shots.map((shot) => shot.target))];
  for (const target of targets) {
    const ofTarget = input.shots.filter((shot) => shot.target === target);
    lines.push(
      `#### \`${target}\` as ${input.person.name} (${input.person.role})`,
      "",
      `| Width | Before: ${input.base.label} | After: this PR |`,
      "| --- | --- | --- |"
    );
    for (const width of [...new Set(ofTarget.map((shot) => shot.width))]) {
      const at = (side: Capture["side"]) =>
        ofTarget.find((shot) => shot.width === width && shot.side === side);
      const before = at("before");
      const after = at("after");
      const cell = (shot: (typeof ofTarget)[number] | undefined) =>
        shot === undefined
          ? "—"
          : `![${shot.side === "before" ? "Before" : "After"}: ${target} at ${width}px](${shot.relative})`;
      lines.push(identicalRow(width, input.identical(target, width), cell(before), cell(after)));
    }
    const errors = ofTarget.filter((shot) => shot.side === "after" && shot.errors.length > 0);
    for (const shot of errors)
      lines.push("", `Browser errors after, at ${shot.width}px: ${shot.errors.join("; ")}`);
    lines.push("");
  }
  return lines.join("\n");
};

const identicalRow = (width: number, identical: boolean, before: string, after: string) =>
  identical ? `| ${width} | No visible change | ${after} |` : `| ${width} | ${before} | ${after} |`;
