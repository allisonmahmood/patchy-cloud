import { expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deployedRevision,
  readDeployments,
  deploymentEvents,
  reconcile,
  localTarget,
  workflowPath
} from "./sync-deployment-updates.mjs";

const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40);
const log = (commit, revision = commit) =>
  `2026-10-05T12:00:00Z   COMMIT: ${commit}\n2026-10-05T12:00:00Z   DEPLOYMENT_REVISION: ${revision}\n`;
const run = (id, attempts = 1, extra = {}) => ({
  id,
  workflow_id: 42,
  path: workflowPath,
  event: "workflow_dispatch",
  run_attempt: attempts,
  head_sha: c,
  ...extra
});
const attempt = (run, number = 1, conclusion = "success") => ({
  ...run,
  run_attempt: number,
  status: "completed",
  conclusion
});
const job = (id, runId, time, confirmed = true) => ({
  id,
  run_id: runId,
  name: "deploy",
  status: "completed",
  conclusion: "success",
  steps: [
    {
      name: "Confirm the release is live",
      status: "completed",
      conclusion: confirmed ? "success" : "skipped",
      completed_at: time
    }
  ]
});
const proof = (runId, attempt, commit, hour, revision = commit) => ({
  runId,
  attempt,
  commit,
  revision,
  confirmedAt: `2026-10-05T${hour}:00:00.000Z`,
  url: `https://github.com/allisonmahmood/patchy-cloud/actions/runs/${runId}/attempts/${attempt}`
});
function github(runs, records, jobs, logs) {
  const calls = [];
  return {
    calls,
    async request(path, field) {
      calls.push(path);
      if (path.endsWith("/workflows/deploy.yml"))
        return { id: 42, path: workflowPath, name: "Deploy" };
      if (field === "workflow_runs") return runs;
      const [, id, number] = path.match(/\/runs\/(\d+)\/attempts\/(\d+)/) ?? [];
      if (!id) throw new Error(`Unexpected discovery input: ${path}`);
      return field === "jobs" ? jobs[`${id}-${number}`] : records[`${id}-${number}`];
    },
    async readLog(id) {
      if (!logs[id]) throw new Error("Logs expired");
      return logs[id];
    }
  };
}

it("imports only confirmed successful Deploy attempts and uses logged COMMIT, never branch head", async () => {
  const runs = [
    run(10),
    run(11),
    run(12, 1, { workflow_id: 99, path: ".github/workflows/ci.yml" }),
    run(13),
    run(14, 1, { event: "push" })
  ];
  const api = github(
    runs,
    { "10-1": attempt(runs[0]), "11-1": attempt(runs[1], 1, "failure"), "13-1": attempt(runs[3]) },
    {
      "10-1": [job(100, 10, "2026-10-05T12:00:00Z")],
      "13-1": [job(130, 13, "2026-10-05T13:00:00Z", false)]
    },
    { 100: log(a) }
  );
  const events = await readDeployments(api);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    runId: 10,
    attempt: 1,
    commit: a,
    confirmedAt: "2026-10-05T12:00:00.000Z"
  });
  expect(api.calls.every((path) => path.includes("/actions/"))).toBe(true);
  expect(api.calls.some((path) => path.includes("/runs/12/") || path.includes("/runs/14/"))).toBe(
    false
  );
});

it("keeps an earlier successful attempt when the latest rerun failed", async () => {
  const item = run(10, 2);
  const api = github(
    [item],
    { "10-1": attempt(item, 1), "10-2": attempt(item, 2, "failure") },
    { "10-1": [job(100, 10, "2026-10-05T12:00:00Z")] },
    { 100: log(a) }
  );
  expect((await readDeployments(api)).map((event) => event.attempt)).toEqual([1]);
});

it("retains cached confirmed history after runs/logs expire", async () => {
  const known = [proof(10, 1, a, "12")];
  expect(await readDeployments({ ...github([], {}, {}, {}), known })).toEqual(known);
  expect(await readDeployments({ ...github([run(10)], {}, {}, {}), known })).toEqual(known);
});

it("refuses unknown or conflicting deployed revisions instead of guessing head_sha", () => {
  expect(() => deployedRevision("No job environment")).toThrow("head-SHA");
  expect(() => deployedRevision(log(a) + log(b))).toThrow();
  expect(() => deployedRevision(log(a, b))).toThrow();
  expect(deployedRevision(log(a, `${a}-overlap-3`))).toEqual({
    commit: a,
    revision: `${a}-overlap-3`
  });
});

it("collapses retries but preserves an old run replayed as rollback and same-code rotations", () => {
  const events = deploymentEvents([
    proof(10, 1, a, "10"),
    proof(10, 2, a, "11"),
    proof(20, 1, b, "12"),
    proof(10, 3, a, "13"),
    proof(30, 1, a, "14", `${a}-overlap-3`)
  ]);
  expect(events.map((event) => [event.runId, event.attempt, event.previousCommit])).toEqual([
    [10, 1, null],
    [20, 1, a],
    [10, 3, b],
    [30, 1, a]
  ]);
});

it("preserves read sequences and notes on repeated imports; main changes create no new entry", async () => {
  const events = deploymentEvents([proof(10, 1, a, "10"), proof(20, 1, b, "12")]);
  const notes = async () => ({
    notes: { title: "Clearer sign-in", summary: "Find your invitation to join.", changes: [] },
    source: "reviewed-local"
  });
  const first = await reconcile(events, { entries: [{ sequence: 6 }] }, notes);
  expect(first.entries.map((entry) => entry.sequence)).toEqual([7, 8]);
  const second = await reconcile(events, first, () => {
    throw new Error("Existing notes must be reused");
  });
  expect(second).toEqual(first);
  expect(second.entries.map((entry) => entry.deployment.commit)).toEqual([a, b]);
});

it("publishes an honest pending entry on note failure, then fills it without another notification", async () => {
  const events = deploymentEvents([proof(10, 1, a, "10")]);
  const pending = await reconcile(events, { entries: [] }, async () => {
    throw new Error("No model key");
  });
  expect(pending.entries[0]).toMatchObject({ sequence: 1, notesPending: true, changes: [] });
  expect(pending.entries[0].title).not.toBe("Platform maintenance");
  const ready = await reconcile(events, pending, async () => ({
    notes: { title: "Clearer sign-in", summary: "Open your invitation to join.", changes: [] },
    source: "reviewed-local"
  }));
  expect(ready.entries).toHaveLength(1);
  expect(ready.entries[0]).toMatchObject({
    sequence: 1,
    notesPending: false,
    title: "Clearer sign-in"
  });
});

it("refuses a newly discovered older event that would reorder existing read sequences", async () => {
  const notes = async () => ({
    notes: { title: "Update", summary: "Details", changes: [] },
    source: "test"
  });
  const prior = await reconcile(deploymentEvents([proof(20, 1, b, "12")]), { entries: [] }, notes);
  await expect(
    reconcile(deploymentEvents([proof(10, 1, a, "10"), proof(20, 1, b, "12")]), prior, notes)
  ).rejects.toThrow("ordering changed");
});

it("writes only to a matching loopback dev-personas worktree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchy-action-target-"));
  try {
    await mkdir(join(directory, ".local/dev"), { recursive: true });
    const plan = { worktree: directory, signIn: "personas", apiUrl: "http://127.0.0.1:12345" };
    const write = (value) =>
      writeFile(join(directory, ".local/dev/plan.json"), JSON.stringify(value));
    await write(plan);
    expect((await localTarget(directory)).historyFile).toContain(
      "storage/platform-updates/history.json"
    );
    for (const extra of [
      { apiUrl: "https://cloud.patchyhq.com" },
      { signIn: "clerk" },
      { worktree: tmpdir() }
    ]) {
      await write({ ...plan, ...extra });
      await expect(localTarget(directory)).rejects.toThrow("loopback");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refreshes completed summaries without duplicating events or changing read markers", async () => {
  const events = deploymentEvents([proof(10, 1, a, "10")]);
  const notes = (title) => async () => ({
    notes: { title, summary: "Details", changes: [] },
    source: "reviewed-local"
  });
  const first = await reconcile(events, { entries: [] }, notes("Old summary"));
  const refreshed = await reconcile(events, first, notes("Specific deployment summary"), true);
  expect(refreshed.entries).toHaveLength(1);
  expect(refreshed.entries[0].sequence).toBe(first.entries[0].sequence);
  expect(refreshed.entries[0].title).toBe("Specific deployment summary");
  expect(refreshed.entries[0].deployment).toEqual(first.entries[0].deployment);
});

it("preserves completed notes when a requested refresh fails", async () => {
  const events = deploymentEvents([proof(10, 1, a, "10")]);
  const first = await reconcile(events, { entries: [] }, async () => ({
    notes: { title: "Existing summary", summary: "Details", changes: [] },
    source: "reviewed-local"
  }));
  await expect(
    reconcile(
      events,
      first,
      async () => {
        throw new Error("Provider unavailable");
      },
      true
    )
  ).rejects.toThrow("existing history was preserved");
  expect(first.entries[0].title).toBe("Existing summary");
});

it("removes simulated entries without reusing their read-marker sequences on future imports", async () => {
  const notes = async () => ({
    notes: { title: "Update", summary: "Details", changes: [] },
    source: "test"
  });
  const first = await reconcile(deploymentEvents([proof(10, 1, a, "10")]), { entries: [] }, notes);
  const simulated = { ...first, entries: [...first.entries, { sequence: 12, simulation: true }] };
  const clean = await reconcile(deploymentEvents([proof(10, 1, a, "10")]), simulated, notes);
  expect(clean.entries.map((entry) => entry.sequence)).toEqual([1]);
  expect(clean.lastSequence).toBe(12);
  const repeated = await reconcile(deploymentEvents([proof(10, 1, a, "10")]), clean, notes);
  const next = await reconcile(
    deploymentEvents([proof(10, 1, a, "10"), proof(20, 1, b, "12")]),
    repeated,
    notes
  );
  expect(next.entries.map((entry) => entry.sequence)).toEqual([1, 13]);
});
