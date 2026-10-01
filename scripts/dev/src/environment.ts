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
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hostLabel, type Plan } from "./plan.js";
import { Person, publisherToken, type Scenario } from "./scenario.js";

export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.String,
  detail: Schema.String
}) {
  override get message() {
    return `${this.step} failed:\n${this.detail}`;
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

/** `environment.json`: everything the card shows, written once `up` has finished. */
export const Manifest = Schema.Struct({
  apiUrl: Schema.String,
  scenario: Schema.String,
  company: Schema.Struct({ name: Schema.String, handle: Schema.String }),
  people: Schema.Array(Person),
  publisher: Schema.String,
  /** The release tarball the CLI and repos were set up against. */
  release: Schema.String,
  patches: Schema.Array(Schema.Struct({ name: Schema.String, address: Schema.String }))
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

/** Runs one step to completion; a failure carries the tail of its output. */
const run = Effect.fn("Environment.run")(function* (
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
      const [stdout, stderr, code] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode
        ],
        { concurrency: "unbounded" }
      );
      if (code !== 0)
        return yield* new StepFailed({
          step,
          detail: (stderr.trim() || stdout.trim()).split("\n").slice(-12).join("\n")
        });
      return stdout;
    })
  ).pipe(
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(new StepFailed({ step, detail: cause.message }))
    })
  );
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
    catch: (cause) =>
      new StepFailed({
        step: `Loading sample data in ${target}`,
        detail: `${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}. Run \`pnpm exec playwright install chromium\` if the browser is missing, or press "Load sample data" yourself.`
      })
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

/** Initializes, overlays, refreshes and publishes each scenario patch as the publisher. */
const materialize = Effect.fn("materialize")(function* (
  layout: Layout,
  scenarioDir: string,
  scenario: Scenario,
  apiUrl: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* childEnv(layout);
  const publisher = scenario.people.find((person) => person.key === scenario.publisher)!;
  const published: Array<{ readonly name: string; readonly address: string }> = [];
  for (const patch of scenario.patches) {
    if ("repo" in patch) {
      const repo = path.join(layout.workspace, patch.repo);
      yield* Console.log(`  ${patch.repo}: init, build and publish`);
      yield* run(
        `Initializing ${patch.repo}`,
        "patchy",
        ["init", repo, "--tier", String(patch.tier), "--purpose", patch.description, "--json"],
        { cwd: layout.workspace, env }
      );
      yield* overlay(path.join(scenarioDir, "patches", patch.repo), repo);
      // The repo's pinned CLI, run directly: it finds the repo's workerd for tier 2
      // inspection, and pnpm's own output stays out of the JSON.
      const pinned = path.join(repo, "node_modules", "patchy", "dist", "index.js");
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
      published.push(result);
      if (patch.sampleData === true) {
        yield* Console.log(`  ${patch.repo}: loading sample data as ${publisher.name}`);
        yield* loadSampleData(apiUrl, publisher.email, result.address);
      }
    } else {
      const dir = path.join(layout.workspace, "pages");
      yield* fs.makeDirectory(dir, { recursive: true });
      const file = path.join(dir, path.basename(patch.file));
      yield* fs.copyFile(path.join(scenarioDir, "files", patch.file), file);
      yield* Console.log(`  ${patch.name}: publish`);
      published.push(
        yield* decodePublish(
          yield* run(
            `Publishing ${patch.file}`,
            "patchy",
            ["publish", file, "--name", patch.name, "--description", patch.description, "--json"],
            { cwd: layout.workspace, env }
          )
        )
      );
    }
  }
  return published;
});

/**
 * Builds everything outside the instance, or, when it already exists, moves the
 * CLI and the workspace repos to the instance's current release (a restart
 * rebuilds the package with a new digest).
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
  if (Option.isSome(existing)) {
    if (existing.value.release === release) return existing.value;
    yield* Console.log("The instance's release changed; updating the CLI and workspace repos.");
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
  yield* fs.makeDirectory(layout.workspace, { recursive: true });
  yield* Console.log(`Setting up ${layout.dir}`);
  yield* installCli(layout, release);
  yield* run(
    "Logging the CLI in",
    "patchy",
    ["auth", "set", "--token-stdin", "--api-url", plan.apiUrl, "--json"],
    { cwd: layout.dir, env, input: publisherToken(scenario) }
  );
  yield* writeWorkspace(layout);
  yield* writeLauncher(layout);
  const patches = yield* materialize(layout, loaded.dir, scenario, plan.apiUrl);
  const manifest: Manifest = {
    apiUrl: plan.apiUrl,
    scenario: loaded.name,
    company: scenario.company,
    people: scenario.people,
    publisher: scenario.publisher,
    release,
    patches
  };
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
  const needle = query.toLowerCase();
  const person =
    manifest.people.find((p) => p.key === needle || p.email.toLowerCase() === needle) ??
    manifest.people.find((p) => p.name.toLowerCase().startsWith(needle));
  if (person === undefined)
    return yield* new PersonNotFound({ query, people: manifest.people.map((p) => p.key) });
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
  // pkill exits 1 when nothing matched; either way the profiles' browsers are gone.
  yield* run("Closing browsers", "pkill", ["-f", `--user-data-dir=${layout.browsers}`], {
    cwd: layout.dir,
    env
  }).pipe(Effect.ignore);
  yield* fs.remove(layout.dir, { recursive: true, force: true });
  return true;
});

export const layoutFor = Effect.fn("layoutFor")(function* (worktree: string) {
  const path = yield* Path.Path;
  return layoutOf(yield* environmentDir(worktree), path);
});
