/**
 * What `pnpm dev up` builds beside the instance, and `pnpm dev down` removes.
 *
 * It all lives in one folder outside the worktree, so an agent working there
 * never loads the repo's CLAUDE.md: `$XDG_DATA_HOME/patchy-dev/<worktree>/`
 * holds the CLI installed from the instance's release, that CLI's own state
 * (logged in as the scenario's publisher), the agent workspace with the
 * scenario's patch repos, browser profiles per person, the `agent` launcher
 * and `environment.json`, the manifest the card is printed from.
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { hostLabel, type Plan } from "./plan.js";
import { Person, publisherToken, type Scenario } from "./scenario.js";

/** A step's command ran and exited non-zero; its output was printed to stderr. */
export class StepExited extends Schema.TaggedError<StepExited>()("StepExited", {
  step: Schema.String,
  exitCode: Schema.Number
}) {
  override get message() {
    return `${this.step} failed (exit ${this.exitCode}); its output is above.`;
  }
}

/** A step's command could not be started at all. */
export class StepUnavailable extends Schema.TaggedError<StepUnavailable>()("StepUnavailable", {
  step: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `${this.step} could not start.`;
  }
}

export class SampleDataFailed extends Schema.TaggedError<SampleDataFailed>()("SampleDataFailed", {
  patch: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Loading sample data in ${this.patch} failed. If Playwright's browser is missing, run \`pnpm exec playwright install chromium\`; then run \`pnpm dev up\` again to finish, or press "Load sample data" yourself.`;
  }
}

export class BrowsersStillRunning extends Schema.TaggedError<BrowsersStillRunning>()(
  "BrowsersStillRunning",
  { profiles: Schema.String }
) {
  override get message() {
    return `Browsers using profiles in ${this.profiles} did not exit; close them and run \`pnpm dev down\` again. Nothing was deleted.`;
  }
}

export class NoBrowser extends Schema.TaggedError<NoBrowser>()("NoBrowser", {}) {
  override get message() {
    return "No Chromium-family browser found on PATH; set PATCHY_BROWSER to one.";
  }
}

export class PersonNotFound extends Schema.TaggedError<PersonNotFound>()("PersonNotFound", {
  query: Schema.String,
  people: Schema.Array(Schema.String)
}) {
  override get message() {
    return `No one matches "${this.query}". People: ${this.people.join(", ")}.`;
  }
}

export class ScreenshotFailed extends Schema.TaggedError<ScreenshotFailed>()("ScreenshotFailed", {
  target: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Capturing ${this.target} failed: ${String(this.cause)}. If Playwright's browser is missing, run \`pnpm exec playwright install chromium\`.`;
  }
}

const PublishedPatch = Schema.Struct({
  /** The scenario's repo or file-patch name. */
  key: Schema.String,
  name: Schema.String,
  address: Schema.String,
  sampled: Schema.Boolean
});

/**
 * `environment.json`: what the card shows, and `up`'s progress. It is written
 * after each step, so an `up` that failed halfway resumes where it stopped.
 */
export const Manifest = Schema.Struct({
  apiUrl: Schema.String,
  scenario: Schema.String,
  company: Schema.Struct({ name: Schema.String, handle: Schema.String }),
  people: Schema.Array(Person),
  publisher: Schema.String,
  /** The release tarball the CLI and repos were set up against. */
  release: Schema.String,
  patches: Schema.Array(PublishedPatch),
  complete: Schema.Boolean
});
export type Manifest = typeof Manifest.Type;
const ManifestJson = Schema.fromJsonString(Manifest, { space: 2 });
const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);
export const encodeManifest = Schema.encodeSync(ManifestJson);

const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

/** `$XDG_DATA_HOME/patchy-dev/<worktree label>`, outside every worktree. */
export const environmentDir = Effect.fn("environmentDir")(function* (worktree: string) {
  const path = yield* Path.Path;
  const home = yield* Config.String("HOME");
  const data = yield* Config.String("XDG_DATA_HOME").pipe(
    Config.withDefault(path.join(home, ".local", "share"))
  );
  return path.join(data, "patchy-dev", hostLabel(worktree));
});

export const layoutOf = (dir: string, path: Path.Path) => ({
  dir,
  cli: path.join(dir, "cli"),
  bin: path.join(dir, "bin"),
  state: path.join(dir, "cli-state"),
  workspace: path.join(dir, "workspace"),
  browsers: path.join(dir, "browsers"),
  agent: path.join(dir, "agent"),
  manifest: path.join(dir, "environment.json")
});
type Layout = ReturnType<typeof layoutOf>;

export const readManifest = Effect.fn("readManifest")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(layout.manifest))) return Option.none<Manifest>();
  return yield* decodeManifest(yield* fs.readFileString(layout.manifest)).pipe(Effect.option);
});

/**
 * Child commands get a closed env, as the server does: what a process needs to
 * run, the CLI's own state dir, and the environment's bin (its patchy and the
 * runner's Node) first on PATH. Nothing from the caller's PATCHY_* leaks in.
 */
const childEnv = Effect.fn("childEnv")(function* (layout: Layout) {
  const path = yield* Path.Path;
  const optional = (name: string) => Config.option(Config.String(name));
  const settings = yield* Config.all({
    PATH: Config.String("PATH").pipe(Config.withDefault("")),
    HOME: Config.String("HOME"),
    TMPDIR: optional("TMPDIR"),
    XDG_DATA_HOME: optional("XDG_DATA_HOME"),
    XDG_CACHE_HOME: optional("XDG_CACHE_HOME"),
    XDG_CONFIG_HOME: optional("XDG_CONFIG_HOME")
  });
  const passed: Record<string, string> = { HOME: settings.HOME };
  for (const name of ["TMPDIR", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] as const) {
    const value = settings[name];
    if (Option.isSome(value)) passed[name] = value.value;
  }
  return {
    ...passed,
    PATH: [layout.bin, path.dirname(process.execPath), settings.PATH].join(PATH_DELIMITER),
    PATCHY_STATE_DIR: layout.state
  };
});

/** Runs a command to completion and reports its exit code and output. */
const exec = Effect.fn("Environment.exec")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly input?: string }
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          extendEnv: false,
          stdin:
            options.input === undefined
              ? "ignore"
              : Stream.make(new TextEncoder().encode(options.input))
        })
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode
        ],
        { concurrency: "unbounded" }
      );
      return { stdout, stderr, exitCode };
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new StepUnavailable({ step, cause }))
    })
  );
});

/** Runs one step; on failure the tail of its output goes to stderr, not into the error. */
const run = Effect.fn("Environment.run")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string>; readonly input?: string }
) {
  const result = yield* exec(step, command, args, options);
  if (result.exitCode !== 0) {
    const output = result.stderr.trim() || result.stdout.trim();
    yield* Console.error(output.split("\n").slice(-12).join("\n"));
    return yield* new StepExited({ step, exitCode: result.exitCode });
  }
  return result.stdout;
});

const ReleaseJson = Schema.fromJsonString(
  Schema.Struct({ package: Schema.Struct({ tarball: Schema.String }) })
);
const PublishJson = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, address: Schema.String })
);
const decodeRelease = Schema.decodeUnknownEffect(ReleaseJson);
const decodePublish = Schema.decodeUnknownEffect(PublishJson);

const currentRelease = Effect.fn("currentRelease")(function* (apiUrl: string) {
  const response = yield* HttpClient.get(`${apiUrl}/api/release`);
  return (yield* decodeRelease(yield* response.text)).package.tarball;
});

/** The environment's own CLI, from the instance's current release; nothing is installed globally. */
const installCli = Effect.fn("installCli")(function* (layout: Layout, tarball: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(layout.cli, { recursive: true });
  yield* fs.makeDirectory(layout.bin, { recursive: true });
  yield* run(
    "Installing the patchy CLI",
    "npm",
    ["install", "--prefix", layout.cli, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: layout.dir, env: yield* childEnv(layout) }
  );
  for (const [name, target] of [
    ["patchy", path.join(layout.cli, "node_modules", ".bin", "patchy")],
    ["node", process.execPath]
  ] as const) {
    const link = path.join(layout.bin, name);
    yield* fs.remove(link, { force: true });
    yield* fs.symlink(target, link);
  }
});

const pnpmVersion = Effect.fn("pnpmVersion")(function* (layout: Layout) {
  const out = yield* run("Reading the pnpm version", "pnpm", ["--version"], {
    cwd: layout.dir,
    env: yield* childEnv(layout)
  });
  return out.trim();
});

/**
 * The agent workspace: the release's Patchy skill as a project skill, and the
 * runner's Node and pnpm pinned for mise (a newer global Node breaks the CLI).
 */
const writeWorkspace = Effect.fn("writeWorkspace")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills = path.join(layout.workspace, ".claude", "skills");
  yield* fs.makeDirectory(skills, { recursive: true });
  const skill = path.join(skills, "patchy");
  yield* fs.remove(skill, { recursive: true, force: true });
  yield* fs.symlink(path.join(layout.cli, "node_modules", "patchy", "skills", "patchy"), skill);
  const miseFile = path.join(layout.workspace, "mise.toml");
  yield* fs.writeFileString(
    miseFile,
    `[tools]\nnode = "${process.versions.node}"\npnpm = "${yield* pnpmVersion(layout)}"\n`
  );
  // Without mise there is nothing to trust; the launcher's PATH still pins Node.
  yield* run("Trusting the workspace's mise.toml", "mise", ["trust", miseFile], {
    cwd: layout.workspace,
    env: yield* childEnv(layout)
  }).pipe(Effect.ignore);
});

const ALLOWED_TOOLS = [
  "Bash(patchy:*)",
  "Bash(pnpm:*)",
  "Bash(node:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(grep:*)",
  "Bash(find:*)",
  "Bash(mkdir:*)",
  "Bash(jq:*)",
  "Bash(sed -n:*)",
  "Bash(wc:*)"
];

/**
 * `agent`: Claude Code in the workspace as a fresh Patchy user has it, with no
 * personal settings, skills or connectors. Permissions come as flags, so the
 * workspace needs no trust prompt. Arguments pass through.
 */
const writeLauncher = Effect.fn("writeLauncher")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem;
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  yield* fs.writeFileString(
    layout.agent,
    [
      "#!/usr/bin/env bash",
      "# Claude Code in this Patchy environment's workspace, as a fresh Patchy user has it.",
      `export PATH=${quote(`${layout.bin}${PATH_DELIMITER}`)}"$PATH"`,
      `export PATCHY_STATE_DIR=${quote(layout.state)}`,
      `cd ${quote(layout.workspace)} || exit 1`,
      `exec claude "$@" --setting-sources project --strict-mcp-config --permission-mode acceptEdits --add-dir /tmp --allowedTools ${ALLOWED_TOOLS.map(quote).join(" ")}`,
      ""
    ].join("\n"),
    { mode: 0o755 }
  );
});

/** Presses a patch's "Load sample data" as `email`, through the persona sign-in. */
const loadSampleData = Effect.fn("loadSampleData")(function* (
  apiUrl: string,
  email: string,
  address: string
) {
  const target = new URL(address).pathname;
  yield* Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(
          `${apiUrl}/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent(target)}`
        );
        const frame = page.frameLocator("iframe").first();
        await frame
          .getByRole("button", { name: /load sample data/i })
          .first()
          .click({ timeout: 30_000 });
        // The button relabels while its call runs, so wait for the empty state
        // to stay gone; closing the browser earlier can drop the call.
        const emptyState = frame.getByText(/load(ing)? sample data/i);
        // 250ms polls: up to a minute, done once it has stayed gone for over 2s.
        for (let poll = 0, quiet = 0; poll < 240; poll++, await page.waitForTimeout(250)) {
          quiet = (await emptyState.count()) > 0 ? 0 : quiet + 1;
          if (quiet > 8) return;
        }
        throw new Error("the sample data never replaced the empty state");
      } finally {
        await browser.close();
      }
    },
    catch: (cause) => new SampleDataFailed({ patch: target, cause })
  });
});

/** The workspace's patch repos: directories holding a `patchy.json`, including ones an agent made. */
const workspaceRepos = Effect.fn("workspaceRepos")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(layout.workspace))) return [];
  const repos: Array<string> = [];
  for (const entry of yield* fs.readDirectory(layout.workspace)) {
    const repo = path.join(layout.workspace, entry);
    if (
      (yield* fs.stat(repo)).type === "Directory" &&
      (yield* fs.exists(path.join(repo, "patchy.json")))
    )
      repos.push(repo);
  }
  return repos;
});

const PATCH_SOURCE_SKIP = new Set(["node_modules", ".patchy", "dist"]);

/**
 * Copies a scenario repo's builder-owned files over the freshly initialized
 * repo. A directory the scenario has (`src/`, `server/` …) replaces the
 * starter's, so starter modules such as `server/notes.ts` don't linger.
 */
const overlay = (
  from: string,
  to: string
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const entry of yield* fs.readDirectory(from)) {
      if (PATCH_SOURCE_SKIP.has(entry)) continue;
      const source = path.join(from, entry);
      const target = path.join(to, entry);
      if ((yield* fs.stat(source)).type === "Directory") {
        yield* fs.remove(target, { recursive: true, force: true });
        yield* fs.makeDirectory(target, { recursive: true });
        yield* overlay(source, target);
      } else yield* fs.copyFile(source, target);
    }
  });

/**
 * Publishes each scenario patch as the publisher, then loads its sample data,
 * recording each step in the manifest. Steps already recorded are skipped; a
 * repo left half-built by an earlier failure is initialized again.
 */
const materialize = Effect.fn("materialize")(function* (
  layout: Layout,
  scenarioDir: string,
  scenario: Scenario,
  manifest: Manifest
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* childEnv(layout);
  const publisher = scenario.people.find((person) => person.key === scenario.publisher)!;
  let current = manifest;
  const record = (entry: typeof PublishedPatch.Type) =>
    Effect.gen(function* () {
      current = {
        ...current,
        patches: [...current.patches.filter((patch) => patch.key !== entry.key), entry]
      };
      yield* fs.writeFileString(layout.manifest, encodeManifest(current));
    });
  for (const patch of scenario.patches) {
    const key = "repo" in patch ? patch.repo : patch.name;
    let entry = current.patches.find((done) => done.key === key);
    if ("repo" in patch) {
      const repo = path.join(layout.workspace, patch.repo);
      // The repo's pinned CLI, run directly: it finds the repo's workerd for tier 2
      // inspection, and pnpm's own output stays out of the JSON.
      const pinned = path.join(repo, "node_modules", "patchy", "dist", "index.js");
      if (entry === undefined) {
        yield* Console.error(`  ${patch.repo}: init, build and publish`);
        yield* fs.remove(repo, { recursive: true, force: true });
        yield* run(
          `Initializing ${patch.repo}`,
          "patchy",
          ["init", repo, "--tier", String(patch.tier), "--purpose", patch.description, "--json"],
          { cwd: layout.workspace, env }
        );
        yield* overlay(path.join(scenarioDir, "patches", patch.repo), repo);
        yield* run(`Refreshing ${patch.repo}`, process.execPath, [pinned, "refresh", "--json"], {
          cwd: repo,
          env
        });
        const result = yield* decodePublish(
          yield* run(`Publishing ${patch.repo}`, process.execPath, [pinned, "publish", "--json"], {
            cwd: repo,
            env
          })
        );
        entry = { key, ...result, sampled: patch.sampleData !== true };
        yield* record(entry);
      }
      if (!entry.sampled) {
        yield* Console.error(`  ${patch.repo}: loading sample data as ${publisher.name}`);
        yield* loadSampleData(manifest.apiUrl, publisher.email, entry.address);
        yield* record({ ...entry, sampled: true });
      }
    } else if (entry === undefined) {
      const dir = path.join(layout.workspace, "pages");
      yield* fs.makeDirectory(dir, { recursive: true });
      const file = path.join(dir, path.basename(patch.file));
      yield* fs.copyFile(path.join(scenarioDir, "files", patch.file), file);
      yield* Console.error(`  ${patch.name}: publish`);
      const result = yield* decodePublish(
        yield* run(
          `Publishing ${patch.file}`,
          "patchy",
          ["publish", file, "--name", patch.name, "--description", patch.description, "--json"],
          { cwd: layout.workspace, env }
        )
      );
      yield* record({ key, ...result, sampled: true });
    }
  }
  return current;
});

/**
 * Builds everything outside the instance, resuming an `up` that stopped
 * halfway. A finished environment only moves its CLI and workspace repos to
 * the instance's current release, which changes when bundled code changed.
 */
export const setUp = Effect.fn("Environment.setUp")(function* (
  plan: Plan,
  loaded: { readonly name: string; readonly dir: string; readonly scenario: Scenario }
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = layoutOf(yield* environmentDir(plan.worktree), path);
  const env = yield* childEnv(layout);
  const release = yield* currentRelease(plan.apiUrl);
  const existing = yield* readManifest(layout);
  if (Option.isSome(existing) && existing.value.complete) {
    if (existing.value.release === release) return existing.value;
    yield* Console.error("The instance's release changed; updating the CLI and workspace repos.");
    yield* installCli(layout, release);
    for (const repo of yield* workspaceRepos(layout))
      yield* run(`Refreshing ${path.basename(repo)}`, "patchy", ["refresh", "--json"], {
        cwd: repo,
        env
      });
    const manifest = { ...existing.value, release };
    yield* fs.writeFileString(layout.manifest, encodeManifest(manifest));
    return manifest;
  }
  const { scenario } = loaded;
  const started: Manifest = Option.getOrElse(existing, () => ({
    apiUrl: plan.apiUrl,
    scenario: loaded.name,
    company: scenario.company,
    people: scenario.people,
    publisher: scenario.publisher,
    release,
    patches: [],
    complete: false
  }));
  yield* fs.makeDirectory(layout.workspace, { recursive: true });
  yield* fs.writeFileString(layout.manifest, encodeManifest(started));
  yield* Console.error(`${Option.isSome(existing) ? "Resuming" : "Setting up"} ${layout.dir}`);
  yield* installCli(layout, release);
  yield* run(
    "Logging the CLI in",
    "patchy",
    ["auth", "set", "--token-stdin", "--api-url", plan.apiUrl, "--json"],
    { cwd: layout.dir, env, input: publisherToken(scenario) }
  );
  yield* writeWorkspace(layout);
  yield* writeLauncher(layout);
  // Repos published before an interruption are bound to the release they were
  // built on; move them to this one before the manifest records it.
  if (started.release !== release)
    for (const done of started.patches) {
      const repo = path.join(layout.workspace, done.key);
      if (yield* fs.exists(path.join(repo, "patchy.json")))
        yield* run(`Refreshing ${done.key}`, "patchy", ["refresh", "--json"], { cwd: repo, env });
    }
  const published = yield* materialize(layout, loaded.dir, scenario, { ...started, release });
  const manifest: Manifest = { ...published, release, complete: true };
  yield* fs.writeFileString(layout.manifest, encodeManifest(manifest));
  return manifest;
});

export const printCard = (manifest: Manifest, layout: Layout) => {
  const width = Math.max(...manifest.people.map((person) => person.key.length));
  const people = manifest.people.map(
    (person) =>
      `    ${person.key.padEnd(width)}  ${person.name} · ${person.role}${person.key === manifest.publisher ? " · the CLI publishes as them" : ""}`
  );
  const patches = manifest.patches.map((patch) => `    ${patch.address}`);
  return Console.log(
    [
      `${manifest.company.name} is up at ${manifest.apiUrl}  (scenario ${manifest.scenario})`,
      "",
      "  People       pnpm dev open <person>  (or any browser: /dev/sign-in)",
      ...people,
      ...(patches.length === 0 ? [] : ["", "  Patches", ...patches]),
      "",
      `  Agent        ${layout.agent}`,
      `  Workspace    ${layout.workspace}`,
      "  End          pnpm dev down"
    ].join("\n")
  );
};

const BROWSERS = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "brave-browser",
  "microsoft-edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
];

const browserBinary = Effect.fn("browserBinary")(function* () {
  const configured = yield* Config.option(Config.String("PATCHY_BROWSER"));
  if (Option.isSome(configured)) return configured.value;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dirs = (yield* Config.String("PATH").pipe(Config.withDefault(""))).split(PATH_DELIMITER);
  for (const candidate of BROWSERS) {
    const found = path.isAbsolute(candidate)
      ? [candidate]
      : dirs.map((d) => path.join(d, candidate));
    for (const file of found) if (yield* fs.exists(file)) return file;
  }
  return yield* new NoBrowser();
});

/** One of the environment's people, by key, email or the start of their name. */
export const findPerson = (manifest: Manifest, query: string) => {
  const needle = query.toLowerCase();
  const person =
    manifest.people.find((p) => p.key === needle || p.email.toLowerCase() === needle) ??
    manifest.people.find((p) => p.name.toLowerCase().startsWith(needle));
  return person === undefined
    ? Effect.fail(new PersonNotFound({ query, people: manifest.people.map((p) => p.key) }))
    : Effect.succeed(person);
};

/** A browser window with its own profile, signed in as the person and opened at `target`. */
export const openPerson = Effect.fn("Environment.openPerson")(function* (
  worktree: string,
  manifest: Manifest,
  query: string,
  target: string
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const layout = layoutOf(yield* environmentDir(worktree), path);
  const person = yield* findPerson(manifest, query);
  const url = `${manifest.apiUrl}/dev/sign-in?as=${encodeURIComponent(person.email)}&return=${encodeURIComponent(target)}`;
  const browser = yield* Effect.scoped(
    spawner
      .spawn(
        ChildProcess.make(
          yield* browserBinary(),
          [
            `--user-data-dir=${path.join(layout.browsers, person.key)}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--new-window",
            url
          ],
          { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
        )
      )
      .pipe(Effect.tap((handle) => handle.unref))
  );
  yield* Console.log(`Opened ${person.name} (pid ${browser.pid}) at ${url}`);
});

/** What `pnpm dev shot` saw: where the page landed, its HTTP status and the browser's errors. */
export const Shot = Schema.Struct({
  url: Schema.String,
  status: Schema.NullOr(Schema.Int),
  file: Schema.String,
  errors: Schema.Array(Schema.String)
});
export type Shot = typeof Shot.Type;

/**
 * A full-page PNG of `target` as `email`, signed in through the personas door,
 * with every console error and uncaught exception from the page and its patch
 * frames. A page holding a live stream never goes network-idle, so settling
 * waits at most five seconds.
 */
export const screenshot = Effect.fn("Environment.screenshot")(function* (
  apiUrl: string,
  email: string,
  target: string,
  file: string
) {
  return yield* Effect.tryPromise({
    try: async (): Promise<Shot> => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const errors: Array<string> = [];
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        page.on("pageerror", (error) => errors.push(error.message));
        const response = await page.goto(
          `${apiUrl}/dev/sign-in?as=${encodeURIComponent(email)}&return=${encodeURIComponent(target)}`
        );
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        await page.screenshot({ path: file, fullPage: true });
        return { url: page.url(), status: response?.status() ?? null, file, errors };
      } finally {
        await browser.close();
      }
    },
    catch: (cause) => new ScreenshotFailed({ target, cause })
  });
});

/**
 * Stops what `up` started outside the instance: patch dev sessions in the
 * workspace and the persons' browsers. Then deletes the environment folder.
 */
export const tearDown = Effect.fn("Environment.tearDown")(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layout = layoutOf(yield* environmentDir(worktree), path);
  if (!(yield* fs.exists(layout.dir))) return false;
  const env = yield* childEnv(layout);
  for (const repo of yield* workspaceRepos(layout))
    if (yield* fs.exists(path.join(repo, ".patchy", "dev")))
      yield* run(
        `Stopping ${path.basename(repo)}'s dev session`,
        "patchy",
        ["dev", "stop", "--json"],
        { cwd: repo, env }
      ).pipe(Effect.ignore);
  // `--` keeps the pattern from reading as an option. pkill and pgrep exit 1
  // when nothing matches and above 1 on failure. Profiles are deleted only
  // once their browsers are confirmed gone.
  const browsers = ["-f", "--", `--user-data-dir=${layout.browsers}`];
  const options = { cwd: layout.dir, env };
  const signal = Effect.fn("signalBrowsers")(function* (step: string, args: ReadonlyArray<string>) {
    const { exitCode } = yield* exec(step, "pkill", args, options);
    if (exitCode > 1) return yield* new StepExited({ step, exitCode });
  });
  const gone = Effect.fn("browsersGone")(function* (polls: number) {
    for (let poll = 0; poll < polls; poll++) {
      const { exitCode } = yield* exec("Waiting for browsers", "pgrep", browsers, options);
      if (exitCode === 1) return true;
      if (exitCode !== 0) return yield* new StepExited({ step: "Waiting for browsers", exitCode });
      yield* Effect.sleep("250 millis");
    }
    return false;
  });
  yield* signal("Closing browsers", browsers);
  if (!(yield* gone(20))) {
    yield* signal("Killing browsers", ["-KILL", ...browsers]);
    if (!(yield* gone(8))) return yield* new BrowsersStillRunning({ profiles: layout.browsers });
  }
  yield* fs.remove(layout.dir, { recursive: true, force: true });
  return true;
});

export const layoutFor = Effect.fn("layoutFor")(function* (worktree: string) {
  const path = yield* Path.Path;
  return layoutOf(yield* environmentDir(worktree), path);
});
