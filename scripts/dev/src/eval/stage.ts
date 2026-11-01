/**
 * A run's fixtures, staged before its builder starts and untimed: the task
 * scenario's patches, published into the run's own company by its publisher
 * through the run's own CLI in its sandbox, the way `pnpm dev up` publishes
 * them (`environment.ts`). Each repo patch is initialized at its tier in
 * `~/Patchy/<repo>`, overlaid with its builder-owned files from the runner's
 * checkout (never a side's, so every side gets the same fixtures) except
 * `AGENTS.md`, whose template is the side's to measure, refreshed and
 * published; each file patch is published from `~/Patchy/<file>`. Then
 * sample data is loaded as the publisher through the grader's keyed door and
 * guests are shared, the sources the builder isn't meant to find are removed,
 * and each patch's version is recorded, so grading can tell a new one.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { overlay, pressSampleData } from "../environment.js";
import type { Scenario } from "../scenario.js";
import type { RunIdentities } from "./fixtures.js";
import { decodeListed, type Door, type Listed, openAs } from "./grade.js";
import { SetupFailed } from "./home.js";
import { HOME, runSandboxed, type SandboxSpec } from "./sandbox.js";
import { type RunPerson, type Task, visibleRepos } from "./task.js";

/** A scenario patch as staged for a run. */
export interface StagedPatch {
  /** The scenario's `repo`, or a file patch's `name`. */
  readonly key: string;
  readonly id: string;
  readonly kind: "repo" | "page";
  /** Its served version once staged: a requested change has to publish a newer one. */
  readonly version: number;
}

type ScenarioPatch = Scenario["patches"][number];

/** How tasks and staging name a scenario patch: its repo, or a file patch's name. */
export const patchKey = (patch: ScenarioPatch) => ("repo" in patch ? patch.repo : patch.name);

/** Where a scenario patch's source lands, under `~/Patchy`. */
export const sourceName = (patch: ScenarioPatch) =>
  "repo" in patch ? patch.repo : (patch.file.split("/").at(-1) ?? patch.file);

/**
 * Each scenario patch as `patchy list` shows it once staged: a repo by the id
 * its `patchy.json` holds, a file patch by its name. `missing` names any that
 * isn't served, which fails staging.
 */
export const recordStaged = (
  patches: ReadonlyArray<ScenarioPatch>,
  listed: typeof Listed.Type,
  repoIds: ReadonlyMap<string, string>
) => {
  const staged: Array<StagedPatch> = [];
  const missing: Array<string> = [];
  for (const patch of patches) {
    const key = patchKey(patch);
    const found = listed.patches.find((each) =>
      "repo" in patch ? each.id === repoIds.get(patch.repo) : each.name === patch.name
    );
    if (found === undefined || found.state !== "live" || found.currentVersion === null)
      missing.push(key);
    else
      staged.push({
        key,
        id: found.id,
        kind: "repo" in patch ? "repo" : "page",
        version: found.currentVersion
      });
  }
  return { staged, missing };
};

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

/** Runs a staging command in the run's sandbox; anything but exit 0 fails setup. */
const step = Effect.fn("Eval.stageStep")(function* (
  what: string,
  spec: SandboxSpec,
  command: string,
  args: ReadonlyArray<string>
) {
  const ran = yield* runSandboxed(spec, command, args, { timeout: "10 minutes" });
  if (ran.exitCode !== 0)
    return yield* new SetupFailed({
      step: what,
      detail:
        ran.exitCode === null
          ? "it ran past 10 minutes"
          : lastLine(`${ran.stderr}\n${ran.stdout}`) || `exit ${ran.exitCode}`
    });
  return ran.stdout;
});

const decodeProject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ patch: Schema.String }))
);

/** Presses each patch's "Load sample data" as `person`, through the grader's keyed door. */
const loadSamples = (door: Door, person: RunPerson, addresses: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        for (const address of addresses) {
          const opened = await openAs(browser, door, person, address);
          if (!opened.signedIn) throw new Error("the instance wouldn't sign the publisher in");
          try {
            if (opened.broke !== null) throw new Error(opened.broke);
            await pressSampleData(opened.page);
          } finally {
            await opened.context.close();
          }
        }
      } finally {
        await browser.close();
      }
    },
    catch: (cause) =>
      new SetupFailed({
        step: "Loading sample data",
        detail: cause instanceof Error ? cause.message.split("\n")[0]! : String(cause)
      })
  });

/** Stages the task scenario's patches for a run; returns each one's staged version. */
export const stage = Effect.fn("Eval.stage")(function* (input: {
  readonly task: Task;
  readonly scenario: Scenario;
  /** The scenario's folder in the runner's checkout. */
  readonly scenarioDir: string;
  readonly spec: SandboxSpec;
  readonly identities: RunIdentities;
  readonly door: Door;
}) {
  const { scenario, spec, identities } = input;
  if (scenario.patches.length === 0) return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = path.join(spec.home, "Patchy");
  yield* fs.makeDirectory(workspace, { recursive: true });
  const repoIds = new Map<string, string>();
  for (const patch of scenario.patches) {
    const source = `${HOME}/Patchy/${sourceName(patch)}`;
    if ("repo" in patch) {
      if ((patch.connections ?? []).length > 0)
        return yield* new SetupFailed({
          step: `Staging ${patch.repo}`,
          detail: "an eval can't make a scenario's connections yet"
        });
      const inRepo = { ...spec, cwd: source };
      yield* step(`Initializing ${patch.repo}`, spec, "patchy", [
        "init",
        source,
        "--tier",
        String(patch.tier),
        "--purpose",
        patch.description,
        "--json"
      ]);
      // The side's own AGENTS.md stays: its template is part of what an eval measures.
      const agentsFile = path.join(workspace, patch.repo, "AGENTS.md");
      const agentsTemplate = yield* fs.readFileString(agentsFile);
      yield* overlay(
        path.join(input.scenarioDir, "patches", patch.repo),
        path.join(workspace, patch.repo)
      );
      yield* fs.writeFileString(agentsFile, agentsTemplate);
      yield* step(`Refreshing ${patch.repo}`, inRepo, "pnpm", ["patchy", "refresh", "--json"]);
      yield* step(`Publishing ${patch.repo}`, inRepo, "pnpm", ["patchy", "publish", "--json"]);
      const project = decodeProject(
        yield* fs.readFileString(path.join(workspace, patch.repo, "patchy.json"))
      );
      if (Option.isNone(project))
        return yield* new SetupFailed({
          step: `Publishing ${patch.repo}`,
          detail: "its patchy.json names no patch"
        });
      repoIds.set(patch.repo, project.value.patch);
    } else {
      yield* fs.copyFile(
        path.join(input.scenarioDir, "files", patch.file),
        path.join(workspace, sourceName(patch))
      );
      yield* step(`Publishing ${patch.name}`, spec, "patchy", [
        "publish",
        source,
        "--name",
        patch.name,
        "--description",
        patch.description,
        "--json"
      ]);
    }
  }

  const listed = decodeListed(
    yield* step("Listing the staged patches", spec, "patchy", ["list", "--json"])
  );
  if (Option.isNone(listed))
    return yield* new SetupFailed({ step: "Listing the staged patches", detail: "no list" });
  const { staged, missing } = recordStaged(scenario.patches, listed.value, repoIds);
  if (missing.length > 0)
    return yield* new SetupFailed({
      step: "Listing the staged patches",
      detail: `${missing.join(", ")} isn't served`
    });
  const sampled = new Set(
    scenario.patches.filter((patch) => "repo" in patch && patch.sampleData === true).map(patchKey)
  );
  yield* loadSamples(
    input.door,
    identities.publisher,
    listed.value.patches
      .filter((patch) => staged.some((each) => each.id === patch.id && sampled.has(each.key)))
      .map((patch) => patch.address)
  );

  for (const patch of scenario.patches)
    for (const guest of identities.guests.filter((person) => patch.guests?.includes(person.key)))
      yield* "repo" in patch
        ? step(
            `Sharing ${patch.repo} with ${guest.name}`,
            { ...spec, cwd: `${HOME}/Patchy/${patch.repo}` },
            "pnpm",
            ["patchy", "share", "--add", guest.email, "--json"]
          )
        : step(`Sharing ${patch.name} with ${guest.name}`, spec, "patchy", [
            "share",
            `${HOME}/Patchy/${sourceName(patch)}`,
            "--add",
            guest.email,
            "--json"
          ]);

  const visible = new Set(visibleRepos(input.task));
  for (const patch of scenario.patches)
    if (!visible.has(patchKey(patch)))
      yield* fs.remove(path.join(workspace, sourceName(patch)), { recursive: true });
  return staged;
});
