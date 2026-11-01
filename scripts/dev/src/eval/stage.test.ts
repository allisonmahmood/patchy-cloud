import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vitest";
import { loadScenario, type Scenario } from "../scenario.js";
import { GRADER_AGENT } from "./agent.js";
import { failedCalls, pickTarget, publishedCheck } from "./grade.js";
import { patchKey, recordStaged, sourceName, type StagedPatch } from "./stage.js";
import { visibleRepos } from "./task.js";
import { TASKS } from "./tasks/index.js";

const repo = new URL("../../../..", import.meta.url).pathname;

const listedPatch = (
  id: string,
  name: string,
  { version = 1 as number | null, state = "live", publishedAt = "2026-11-01T10:00:00Z" } = {}
) => ({
  id,
  name,
  address: `http://x/acme/${name}`,
  tier: 2,
  state,
  currentVersion: version,
  publishedAt: version === null ? null : publishedAt
});

const patches: Scenario["patches"] = [
  { repo: "kudos", tier: 2, description: "Kudos.", sampleData: true },
  { file: "pages/kickoff.html", name: "kickoff", description: "Kickoff." }
];

describe("staging", () => {
  it("names a repo by its repo and a page by its name, its source by its file", () => {
    expect(patches.map(patchKey)).toEqual(["kudos", "kickoff"]);
    expect(patches.map(sourceName)).toEqual(["kudos", "kickoff.html"]);
  });

  it("records a repo by the id its patchy.json holds and a page by its name", () => {
    const { staged, missing } = recordStaged(
      patches,
      {
        patches: [
          // The config may name the patch differently from its repo; the id decides.
          listedPatch("p_kudos", "studio-kudos", { version: 3 }),
          listedPatch("p_kick", "kickoff")
        ]
      },
      new Map([["kudos", "p_kudos"]])
    );
    expect(missing).toEqual([]);
    expect(staged).toEqual([
      { key: "kudos", id: "p_kudos", kind: "repo", version: 3 },
      { key: "kickoff", id: "p_kick", kind: "page", version: 1 }
    ]);
  });

  it("calls a patch that isn't served missing", () => {
    const { missing } = recordStaged(
      patches,
      { patches: [listedPatch("p_kudos", "kudos", { version: null })] },
      new Map([["kudos", "p_kudos"]])
    );
    expect(missing).toEqual(["kudos", "kickoff"]);
  });

  it("shows an existing target's own source by default, and nothing for a new patch", () => {
    expect(visibleRepos({ target: { existing: "kudos" } })).toEqual(["kudos"]);
    expect(visibleRepos({ target: { create: "repo" } })).toEqual([]);
    expect(visibleRepos({ target: { existing: "kudos" }, visible: ["kudos", "spend"] })).toEqual([
      "kudos",
      "spend"
    ]);
  });
});

describe("the graded target", () => {
  const staged: ReadonlyArray<StagedPatch> = [
    { key: "kudos", id: "p_kudos", kind: "repo", version: 2 },
    { key: "spend", id: "p_spend", kind: "repo", version: 1 }
  ];
  const listed = {
    patches: [
      listedPatch("p_kudos", "kudos", { version: 3, publishedAt: "2026-11-01T09:00:00Z" }),
      listedPatch("p_spend", "spend", { publishedAt: "2026-11-01T12:00:00Z" }),
      listedPatch("p_new", "new", { publishedAt: "2026-11-01T11:00:00Z" })
    ]
  };

  it("is the newest patch the run didn't stage, for a new patch", () => {
    expect(pickTarget(listed, { create: "repo" }, staged)?.id).toBe("p_new");
    expect(pickTarget({ patches: listed.patches.slice(0, 2) }, { create: "repo" }, staged)).toBe(
      null
    );
  });

  it("is the staged patch the task names, for an existing one, while it is served", () => {
    expect(pickTarget(listed, { existing: "kudos" }, staged)).toMatchObject({
      id: "p_kudos",
      version: 3
    });
    const retired = { patches: [listedPatch("p_kudos", "kudos", { state: "retired" })] };
    expect(pickTarget(retired, { existing: "kudos" }, staged)).toBeNull();
  });

  it("counts as published only with a version newer than the staged one", () => {
    const target = { id: "p_kudos", name: "kudos", address: "", tier: 2, version: 2 };
    const same = publishedCheck({ target: { existing: "kudos" } }, target, staged);
    expect(same).toMatchObject({ fresh: false, check: { status: "fail" } });
    const newer = publishedCheck(
      { target: { existing: "kudos" } },
      { ...target, version: 3 },
      staged
    );
    expect(newer).toMatchObject({ fresh: true, check: { status: "pass" } });
  });

  it("counts every failed call but the refusals a check expected", () => {
    const entry = (handler: string, outcome: string, viewer: string, more = {}) => ({
      startedAt: "2026-11-01T10:00:05Z",
      version: 2,
      handler,
      outcome,
      code: outcome === "handler_error" ? "not_admin" : null,
      viewer: { id: viewer },
      agent: null,
      ...more
    });
    const failed = failedCalls(
      [
        entry("requests.approve", "handler_error", "usr_cleo"),
        entry("requests.approve", "handler_error", "usr_ada"),
        entry("totals.summary", "handler_error", "usr_ben"),
        entry("kudos.giveKudos", "handler_error", "usr_jordan", {
          agent: { name: GRADER_AGENT }
        }),
        entry("requests.list", "failure", "usr_ben"),
        entry("requests.list", "failure", "usr_ben", { version: 1 }),
        entry("requests.list", "failure", "usr_ben", { startedAt: "2026-11-01T09:59:00Z" })
      ],
      {
        from: "2026-11-01T10:00:00Z",
        version: 2,
        expected: [{ person: "usr_cleo", handler: "requests.approve" }]
      }
    );
    expect(failed).toEqual([
      "requests.approve: not_admin",
      "totals.summary: not_admin",
      "requests.list: failure"
    ]);
  });

  it("fails a target at a tier the task rules out, and still checks it", () => {
    const target = { id: "p_new", name: "new", address: "", tier: 1, version: 1 };
    expect(publishedCheck({ target: { create: "repo" }, tier: 2 }, target, staged)).toMatchObject({
      fresh: true,
      check: { status: "fail", detail: "new v1, tier 1, where this task needs tier 2." }
    });
  });
});

it.layer(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))("the suite", (it) => {
  it.effect("names patches and people its scenarios have, and nothing a run can't stage", () =>
    Effect.gen(function* () {
      for (const task of TASKS) {
        const { scenario } = yield* loadScenario(repo, task.scenario);
        const keys = scenario.patches.map(patchKey);
        if ("existing" in task.target) expect(keys, task.id).toContain(task.target.existing);
        for (const key of visibleRepos(task)) expect(keys, task.id).toContain(key);
        expect(scenario.connections ?? [], task.id).toEqual([]);
        const people = scenario.people
          .filter((person) => person.company === undefined)
          .map((person) => person.key);
        for (const check of task.checks)
          for (const key of check.agents ?? []) expect(people, check.name).toContain(key);
        expect(new Set(task.checks.map((check) => check.name)).size, task.id).toBe(
          task.checks.length
        );
      }
    })
  );
});
