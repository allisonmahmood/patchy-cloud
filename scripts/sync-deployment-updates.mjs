/** Read GitHub Actions; write only a loopback dev instance. Never dispatch or deploy. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";
import { collectEvidence, makeDraft, requestNotes } from "./release-notes.mjs";

export const repository = "allisonmahmood/patchy-cloud";
export const workflowPath = ".github/workflows/deploy.yml";
const prefix = `repos/${repository}/actions`;
const root = fileURLToPath(new URL("../", import.meta.url));
const source = "github-actions-deploy";
const success = (value) => value.status === "completed" && value.conclusion === "success";
const key = (event) => `${event.runId}-${event.attempt}`;

export function deployedRevision(log) {
  // Read the resolved job environment, not head_sha (which is wrong for an explicit rollback).
  const values = (name, pattern) => [
    ...new Set(
      [...log.matchAll(new RegExp(`^\\S+ +${name}: (${pattern})\\s*$`, "gm"))].map(
        (match) => match[1]
      )
    )
  ];
  const commits = values("COMMIT", "[a-f0-9]{40}");
  const revisions = values("DEPLOYMENT_REVISION", "[a-f0-9]{40}(?:-(?:overlap|seal)-[0-9]+)?");
  if (commits.length !== 1 || revisions.length !== 1 || !revisions[0].startsWith(commits[0]))
    throw new Error(
      "The Deploy job log does not establish one actual deployed revision. Refusing a head-SHA fallback."
    );
  return { commit: commits[0], revision: revisions[0] };
}

/** The only discovery input is Deploy workflow runs and their successful attempts. */
export async function readDeployments({ request, readLog, known = [] }) {
  const workflow = await request(`${prefix}/workflows/deploy.yml`);
  if (workflow.name !== "Deploy" || workflow.path !== workflowPath)
    throw new Error("Expected the Deploy workflow at .github/workflows/deploy.yml.");
  const proofs = new Map(known.map((event) => [key(event), event]));
  const runs = await request(
    `${prefix}/workflows/${workflow.id}/runs?event=workflow_dispatch&per_page=100`,
    "workflow_runs"
  );
  for (const run of runs) {
    if (
      run.workflow_id !== workflow.id ||
      run.path?.split("@")[0] !== workflowPath ||
      run.event !== "workflow_dispatch"
    )
      continue;
    // A later failed/in-progress rerun must not erase a prior successful attempt.
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      if (proofs.has(`${run.id}-${attempt}`)) continue;
      const record = await request(`${prefix}/runs/${run.id}/attempts/${attempt}`);
      if (!success(record)) continue;
      if (
        record.id !== run.id ||
        record.run_attempt !== attempt ||
        record.workflow_id !== workflow.id
      )
        throw new Error("GitHub returned mismatched deployment attempt metadata.");
      const jobs = await request(
        `${prefix}/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`,
        "jobs"
      );
      const job = jobs.find((job) => job.name === "deploy" && success(job));
      const confirmed = job?.steps.find(
        (step) => step.name === "Confirm the release is live" && success(step)
      );
      if (!confirmed) continue;
      if (job.run_id !== run.id || typeof confirmed.completed_at !== "string")
        throw new Error("GitHub returned invalid deployment confirmation metadata.");
      const deployed = deployedRevision(await readLog(job.id));
      const confirmedAt = new Date(confirmed.completed_at).toISOString();
      proofs.set(`${run.id}-${attempt}`, {
        runId: run.id,
        attempt,
        jobId: job.id,
        confirmedAt,
        ...deployed,
        url: `https://github.com/${repository}/actions/runs/${run.id}/attempts/${attempt}`
      });
    }
  }
  return [...proofs.values()].sort(
    (a, b) =>
      a.confirmedAt.localeCompare(b.confirmedAt) || a.runId - b.runId || a.attempt - b.attempt
  );
}

export function deploymentEvents(proofs) {
  const events = [];
  for (const proof of proofs) {
    const previous = events.at(-1);
    // Re-running the same release without an intervening deployment is a retry.
    // Re-running an old run after a different release is a new rollback event.
    if (previous?.runId === proof.runId && previous.revision === proof.revision) continue;
    events.push({ ...proof, previousCommit: previous?.commit ?? null });
  }
  return events;
}

export async function localTarget(worktree) {
  const directory = await realpath(worktree);
  const plan = JSON.parse(await readFile(resolve(directory, ".local/dev/plan.json"), "utf8"));
  const url = new URL(plan.apiUrl);
  if (
    (await realpath(plan.worktree)) !== directory ||
    plan.signIn !== "personas" ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  )
    throw new Error(
      "Updates may only be written to this worktree's loopback dev-personas instance."
    );
  return {
    apiUrl: plan.apiUrl,
    historyFile: resolve(directory, ".local/dev/storage/platform-updates/history.json"),
    stateDirectory: resolve(directory, ".local/dev/deployment-updates")
  };
}

const optionalJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};
async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify(value, null, 2));
  await rename(file + ".tmp", file);
}

/** Preserve event sequences and existing notes. Note failures never invent maintenance claims. */
export async function reconcile(events, previous, createNotes, refreshNotes = false) {
  const lastSequence = previous.lastSequence ?? 0;
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0)
    throw new Error("Invalid update sequence watermark.");
  let sequence = Math.max(lastSequence, ...previous.entries.map((entry) => entry.sequence));
  const entries = [];
  for (const event of events) {
    const old = previous.entries.find((entry) => entry.deployment?.eventId === key(event));
    const assignedSequence = old?.sequence ?? ++sequence;
    if (entries.length && assignedSequence <= entries.at(-1).sequence)
      throw new Error("Deployment ordering changed; refusing to move a read marker's baseline.");
    const saved =
      !refreshNotes && old?.deployment.previousCommit === event.previousCommit && !old?.notesPending
        ? old
        : null;
    let notes = saved && { title: saved.title, summary: saved.summary, changes: saved.changes };
    let notesPending = false;
    let notesSource = saved?.deployment.notesSource;
    if (!notes) {
      try {
        const result = await createNotes(event);
        notes = result.notes;
        notesSource = result.source;
      } catch (error) {
        if (refreshNotes)
          throw new Error("Refreshing notes failed; existing history was preserved.", {
            cause: error
          });
        notesPending = true;
        notesSource = "pending";
        notes = {
          title: "A new Patchy update is available",
          summary: "This update was successfully deployed. Its detailed notes are being prepared.",
          changes: []
        };
        console.error(
          `Notes pending for Deploy ${event.runId}, attempt ${event.attempt}: ${error.message}`
        );
      }
    }
    entries.push({
      sequence: assignedSequence,
      publishedAt: event.confirmedAt,
      ...notes,
      notesPending,
      deployment: { ...event, eventId: key(event), notesSource }
    });
  }
  return {
    version: 1,
    source: { kind: source, repository, workflow: workflowPath },
    lastSequence: sequence,
    entries
  };
}

function gh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000
    });
  } catch {
    throw new Error(
      "Reading GitHub Actions failed. Check gh authentication, Actions read access, and log retention; existing history was preserved."
    );
  }
}
const github = {
  async request(endpoint, field) {
    const pages = JSON.parse(gh(["api", "--paginate", "--slurp", endpoint]));
    if (!field) return pages[0];
    const rows = pages.flatMap((page) => page[field]);
    if (rows.length < pages[0].total_count)
      throw new Error("GitHub returned incomplete Action history; refusing a truncated import.");
    return rows;
  },
  async readLog(jobId) {
    return gh(["api", `${prefix}/jobs/${jobId}/logs`, "--allow-escape-sequences"]);
  }
};

export async function sync(worktree, { refreshNotes = false } = {}) {
  const target = await localTarget(worktree);
  await mkdir(target.stateDirectory, { recursive: true });
  const lock = resolve(target.stateDirectory, "sync.lock");
  await mkdir(lock); // One local writer at a time; never race a watch process.
  try {
    const stateFile = resolve(target.stateDirectory, "confirmations.json");
    const known = await optionalJson(stateFile, []);
    const proofs = await readDeployments({ ...github, known });
    await atomicJson(stateFile, proofs); // Cache commit proof before GitHub expires logs.
    const previous = await optionalJson(target.historyFile, { version: 1, entries: [] });
    if (previous.entries.length && previous.source?.kind !== source)
      await atomicJson(resolve(target.stateDirectory, "sample-history-backup.json"), previous);
    const history = await reconcile(
      deploymentEvents(proofs),
      previous,
      async (event) => {
        for (const sha of [event.previousCommit, event.commit].filter(Boolean)) {
          try {
            execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
              cwd: root,
              stdio: "ignore"
            });
          } catch {
            execFileSync(
              "git",
              ["fetch", "--no-tags", `https://github.com/${repository}.git`, sha],
              {
                cwd: root,
                stdio: "pipe",
                timeout: 120_000
              }
            );
          }
        }
        const evidence = await collectEvidence({
          cwd: root,
          from: event.previousCommit,
          to: event.commit,
          repository,
          // No PR or branch listing determines entries or their ranges.
          loadPullRequests: async () => []
        });
        await atomicJson(
          resolve(target.stateDirectory, "evidence", `${key(event)}.json`),
          evidence
        );
        const reviewed = await optionalJson(
          resolve(target.stateDirectory, "responses", `${key(event)}.json`),
          null
        );
        const model = process.env.RELEASE_NOTES_MODEL || "gpt-4.1-mini";
        const response = !["forward", "initial"].includes(evidence.kind)
          ? null
          : (reviewed ??
            (await requestNotes(evidence, { apiKey: process.env.RELEASE_NOTES_API_KEY, model })));
        const origin = !["forward", "initial"].includes(evidence.kind)
          ? "deployment-facts"
          : reviewed
            ? "reviewed-local"
            : model;
        const draft = makeDraft(evidence, response, origin);
        await atomicJson(resolve(target.stateDirectory, "drafts", `${key(event)}.json`), draft);
        return { notes: draft.notes, source: origin };
      },
      refreshNotes
    );
    await atomicJson(target.historyFile, history);
    console.log(
      `${history.entries.length} confirmed Deploy entries; ${history.entries.filter((entry) => entry.notesPending).length} awaiting notes. ${target.apiUrl}/updates`
    );
    return history;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      worktree: { type: "string", default: root },
      watch: { type: "boolean", default: false },
      "refresh-notes": { type: "boolean", default: false }
    }
  });
  if (values.watch && values["refresh-notes"])
    throw new Error("Use --refresh-notes for a single import, then restart --watch.");
  do {
    try {
      await sync(values.worktree, { refreshNotes: values["refresh-notes"] });
    } catch (error) {
      if (!values.watch) throw error;
      console.error(error.message);
    }
    if (values.watch) await setTimeout(30_000);
  } while (values.watch);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
