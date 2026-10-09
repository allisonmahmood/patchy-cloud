import { describe, expect, it } from "vitest";
import {
  executions,
  newFlakyTests,
  render,
  summarize,
  type Annotation,
  type Job
} from "./flake-report.js";

// Recorded from CI, trimmed to the fields the report reads. Run 37646514779
// failed `test (22)` twice and passed on its third attempt, carrying `test (24)`'s
// success forward each time.
const docs = { run_id: 37646514779, head_sha: "e25a23f0", head_branch: "docs/whats-new-8" };
const devWatchFailed: Job = {
  ...docs,
  id: 112878644584,
  run_attempt: 1,
  name: "test (22)",
  conclusion: "failure",
  started_at: "2026-10-07T15:46:47Z",
  completed_at: "2026-10-07T15:55:07Z"
};
const fleetFailed: Job = {
  ...docs,
  id: 112883605872,
  run_attempt: 2,
  name: "test (22)",
  conclusion: "failure",
  started_at: "2026-10-07T15:56:35Z",
  completed_at: "2026-10-07T16:04:49Z"
};
const node22Passed: Job = {
  ...docs,
  id: 112888197374,
  run_attempt: 3,
  name: "test (22)",
  conclusion: "success",
  started_at: "2026-10-07T16:05:43Z",
  completed_at: "2026-10-07T16:11:59Z"
};
const node24: Job = {
  ...docs,
  id: 112878644576,
  run_attempt: 1,
  name: "test (24)",
  conclusion: "success",
  started_at: "2026-10-07T15:47:13Z",
  completed_at: "2026-10-07T15:54:44Z"
};
const docsRun = [
  devWatchFailed,
  node24,
  fleetFailed,
  { ...node24, id: 112883668572, run_attempt: 2 },
  node22Passed,
  { ...node24, id: 112888241061, run_attempt: 3 }
];

// Run 37366993872 waited out runner acquisition and was rerun; run 37645835379
// was cancelled by a newer push and never rerun.
const lifecycle = { run_id: 37366993872, head_sha: "0d4d6faf", head_branch: "analytics/536" };
const runnerLost: Job = {
  ...lifecycle,
  id: 111954460975,
  run_attempt: 1,
  name: "test (22)",
  conclusion: "cancelled",
  started_at: "2026-10-05T20:00:03Z",
  completed_at: "2026-10-05T20:19:34Z"
};
const lifecycleRun = [
  runnerLost,
  {
    ...runnerLost,
    id: 111961666325,
    run_attempt: 2,
    conclusion: "success",
    started_at: "2026-10-05T20:26:29Z",
    completed_at: "2026-10-05T20:34:19Z"
  }
];
const superseded: Job = {
  id: 112876933449,
  run_id: 37645835379,
  run_attempt: 1,
  name: "test (22)",
  head_sha: "219d30b0",
  head_branch: "dependabot/patch-updates",
  conclusion: "cancelled",
  started_at: "2026-10-07T15:41:59Z",
  completed_at: "2026-10-07T15:48:31Z"
};

const exitCode: Annotation = {
  path: ".github",
  start_line: 841,
  annotation_level: "failure",
  title: "",
  message: "Process completed with exit code 1."
};
const notice: Annotation = {
  path: ".github",
  start_line: 1,
  annotation_level: "notice",
  title: "",
  message: "The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026."
};
const devWatch: Annotation = {
  path: "packages/patchy/src/devServerWatch.ts",
  start_line: 72,
  annotation_level: "failure",
  title:
    "packages/patchy/src/devServerWatch.test.ts > re-discovers added and removed modules, edits descriptors, and ignores page changes",
  message:
    "LocalError: Could not watch server source files.\n ❯ FSWatcher.watchError packages/patchy/src/devServerWatch.ts:72:7"
};
const fleet: Annotation = {
  path: "packages/execution/src/Fleet.test.ts",
  start_line: 531,
  annotation_level: "failure",
  title:
    "packages/execution/src/Fleet.test.ts > host fleet controller > isolates wedged stats and failed binds, stops and starts while healthy companies claim replenished spares",
  message: "Error: Test timed out in 30000ms.\nIf this is a long-running test, pass a timeout value"
};

const unhandled: Annotation = {
  path: "packages/execution/src/process.ts",
  start_line: 79,
  annotation_level: "failure",
  title: "Unhandled error",
  message: "Error: kill ESRCH\n ❯ process.kill node:internal/process/per_thread:225:13"
};
// Playwright's reporter titles a test by its location and heads the message with it.
const loginDoor: Annotation = {
  path: "test/browser/login-door.spec.ts",
  start_line: 41,
  annotation_level: "failure",
  title:
    "login-door.spec.ts:9:1 › login-door: portal handshake, session renewal and company isolation",
  message:
    "  1) login-door.spec.ts:9:1 › login-door: portal handshake, session renewal and company isolation ──\n\n    Error: expect(page).toHaveURL(expected) failed\n"
};

describe("flake report", () => {
  it("counts carried-forward successes once and fails only cancelled jobs a later attempt reran", () => {
    const { all, failed } = executions([...docsRun, ...lifecycleRun, superseded]);
    expect(all.map((job) => job.id)).toEqual([
      devWatchFailed.id,
      node24.id,
      fleetFailed.id,
      node22Passed.id,
      ...lifecycleRun.map((job) => job.id),
      superseded.id
    ]);
    expect(failed).toEqual([devWatchFailed, fleetFailed, runnerLost]);
  });

  it("groups failures by test once per execution and credits a later pass on the same commit", () => {
    const { all } = executions([...docsRun, ...lifecycleRun]);
    // The Fleet case on main: its job passed on that commit only before it failed,
    // and only another job passed after.
    const onMain = { ...node22Passed, run_attempt: 1, head_sha: "c0ffee00", head_branch: "main" };
    const mainPassedBefore: Job = {
      ...onMain,
      id: 1,
      run_id: 2,
      started_at: "2026-10-08T08:00:00Z",
      completed_at: "2026-10-08T08:08:00Z"
    };
    const mainFailed: Job = {
      ...onMain,
      id: 3,
      run_id: 4,
      conclusion: "failure",
      started_at: "2026-10-08T09:00:00Z",
      completed_at: "2026-10-08T09:08:00Z"
    };
    const nextCommitPassed: Job = {
      ...onMain,
      id: 5,
      run_id: 6,
      head_sha: "f00dfeed",
      started_at: "2026-10-08T10:00:00Z",
      completed_at: "2026-10-08T10:08:00Z"
    };
    const otherJobPassed: Job = {
      ...mainFailed,
      id: 7,
      name: "test (24)",
      conclusion: "success",
      started_at: "2026-10-08T09:30:00Z"
    };
    const summary = summarize(
      [...all, mainPassedBefore, mainFailed, otherJobPassed, nextCommitPassed],
      [
        { job: devWatchFailed, annotations: [exitCode, devWatch, notice] },
        // Vitest annotates each of a test's errors; the execution counts once.
        { job: fleetFailed, annotations: [exitCode, fleet, { ...fleet, start_line: 540 }, notice] },
        // Vitest titles every unhandled error alike; it is told apart by where it was thrown.
        { job: mainFailed, annotations: [fleet, unhandled] },
        {
          job: runnerLost,
          annotations: [{ ...exitCode, message: "The job was not acquired by Runner" }]
        }
      ]
    );

    expect(summary.tests).toEqual([
      {
        title: fleet.title,
        failures: 2,
        passedOnRerun: 1,
        branches: ["docs/whats-new-8", "main"],
        commits: ["c0ffee00", "e25a23f0"],
        jobs: ["test (22)"],
        lastError: "packages/execution/src/Fleet.test.ts:531 Error: Test timed out in 30000ms."
      },
      {
        title: devWatch.title,
        failures: 1,
        passedOnRerun: 1,
        branches: ["docs/whats-new-8"],
        commits: ["e25a23f0"],
        jobs: ["test (22)"],
        lastError:
          "packages/patchy/src/devServerWatch.ts:72 LocalError: Could not watch server source files."
      },
      {
        title: "Unhandled error in packages/execution/src/process.ts",
        failures: 1,
        passedOnRerun: 0,
        branches: ["main"],
        commits: ["c0ffee00"],
        jobs: ["test (22)"],
        lastError: "packages/execution/src/process.ts:79 Error: kill ESRCH"
      }
    ]);
    expect([...summary.unclassified]).toEqual([["test (22)", 1]]);
  });

  it("tables rerun passes, lists other failures, and comments only on flaky tests new to the table", () => {
    const { all } = executions(docsRun);
    // The live Clerk spec failed on two branches and never passed on a rerun.
    const clerkLive = (id: number, head_branch: string): Job => ({
      ...node22Passed,
      id,
      run_id: id,
      run_attempt: 1,
      name: "clerk-live",
      conclusion: "failure",
      head_sha: String(id),
      head_branch
    });
    const summary = summarize(all, [
      { job: devWatchFailed, annotations: [devWatch] },
      { job: fleetFailed, annotations: [fleet] },
      { job: clerkLive(1, "main"), annotations: [loginDoor] },
      { job: clerkLive(2, "auth/renewal"), annotations: [loginDoor] }
    ]);
    const window = {
      since: new Date("2026-10-05T06:00:00Z"),
      until: new Date("2026-10-12T06:00:00Z"),
      runs: 3
    };
    const lastWeek = render(summarize(all, [{ job: fleetFailed, annotations: [fleet] }]), window);

    expect(render(summary, window)).toContain(
      `- ${loginDoor.title}: 2 failures on 2 commits across 2 branches. test/browser/login-door.spec.ts:41 Error: expect(page).toHaveURL(expected) failed`
    );
    expect(newFlakyTests(summary, lastWeek).map((test) => test.title)).toEqual([devWatch.title]);
  });

  it("counts jobs at GitHub's annotation cap and bounds the table and its announcements", () => {
    const { all } = executions(docsRun);
    const tests = (count: number, from = 0) =>
      Array.from({ length: count }, (_, index) => ({ ...devWatch, title: `test ${from + index}` }));
    const window = {
      since: new Date("2026-10-05T06:00:00Z"),
      until: new Date("2026-10-12T06:00:00Z"),
      runs: 1
    };

    expect(
      summarize(all, [
        { job: devWatchFailed, annotations: tests(10) },
        { job: fleetFailed, annotations: tests(9, 10) }
      ]).capped
    ).toBe(1);

    const busy = summarize(
      all,
      tests(51).map((annotation) => ({ job: devWatchFailed, annotations: [annotation] }))
    );
    const body = render(busy, window);
    expect(body).toContain("And 1 more.");
    expect(newFlakyTests(busy, body)).toEqual([]);
  });
});
