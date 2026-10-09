/**
 * The weekly flake report: which tests failed in CI over the last seven days,
 * on how many branches and commits, and how often the same job then passed on
 * the same commit. Failures are read from the error annotations that Vitest's
 * `github-actions` reporter and Playwright's `github` reporter leave on a job.
 *
 *   node scripts/flake-report.ts            print the report
 *   node scripts/flake-report.ts --publish  print it, rewrite the open issue labelled
 *                                           `flake-report` with it, and comment there
 *                                           when a flaky test is new to its list
 *
 * Needs GITHUB_TOKEN and GITHUB_REPOSITORY (`owner/name`). The flake report
 * workflow (.github/workflows/flake-report.yml) publishes every Monday.
 */
import { setTimeout as sleep } from "node:timers/promises";

/** The fields read from a workflow job. A job's id is also its check run's. */
export interface Job {
  readonly id: number;
  readonly run_id: number;
  readonly run_attempt: number;
  readonly name: string;
  readonly head_sha: string;
  readonly head_branch: string | null;
  readonly conclusion: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

/** The fields read from a check run annotation. */
export interface Annotation {
  readonly path: string;
  readonly start_line: number;
  readonly annotation_level: string;
  readonly title: string | null;
  readonly message: string;
}

/** A failed job execution and the annotations GitHub kept for it. */
export interface Failure {
  readonly job: Job;
  readonly annotations: ReadonlyArray<Annotation>;
}

/**
 * Each job execution once, and the failed ones. Rerunning a run's failed jobs
 * carries its successes into the new attempt under new ids with unchanged
 * timestamps. Runner acquisition failures surface as cancelled jobs, so a
 * cancelled job counts as failed when a later attempt reran it; a run cancelled
 * by a newer push is not rerun.
 */
export const executions = (jobs: ReadonlyArray<Job>) => {
  const distinct = new Map<string, Job>();
  for (const job of jobs) {
    const key = [job.run_id, job.name, job.started_at, job.completed_at].join(" ");
    const kept = distinct.get(key);
    if (kept === undefined || job.run_attempt < kept.run_attempt) distinct.set(key, job);
  }
  const all = [...distinct.values()];
  const failed = all.filter(
    (job) =>
      job.conclusion === "failure" ||
      job.conclusion === "timed_out" ||
      (job.conclusion === "cancelled" &&
        all.some(
          (other) =>
            other.run_id === job.run_id &&
            other.name === job.name &&
            other.run_attempt > job.run_attempt
        ))
  );
  return { all, failed };
};

/** The first line of an annotation's message that names the error, skipping Playwright's test header. */
const firstLine = (message: string) =>
  (
    message
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !/^\d+\) /.test(line)) ?? ""
  ).slice(0, 160);

/**
 * Failures grouped by test, counted once per job execution however many errors
 * the test reported there. Vitest titles every unhandled error alike, so those
 * group by where they were thrown. A failure passed on rerun when a later
 * execution of the same job succeeded on the same commit. A failed job with no
 * test annotation is unclassified.
 */
export const summarize = (all: ReadonlyArray<Job>, failures: ReadonlyArray<Failure>) => {
  const byTest = new Map<
    string,
    Array<{
      readonly job: Job;
      readonly annotation: Omit<Annotation, "title">;
      readonly passedLater: boolean;
    }>
  >();
  const unclassified = new Map<string, number>();
  let capped = 0;
  for (const { job, annotations } of failures) {
    const errors = annotations.flatMap(({ title, ...annotation }) =>
      annotation.annotation_level === "failure" && annotation.path !== ".github" && title
        ? [
            {
              ...annotation,
              test: title === "Unhandled error" ? `Unhandled error in ${annotation.path}` : title
            }
          ]
        : []
    );
    if (errors.length === 0) {
      unclassified.set(job.name, (unclassified.get(job.name) ?? 0) + 1);
      continue;
    }
    // GitHub keeps ten error annotations per step, so this job's may have been cut short.
    if (errors.length >= 10) capped++;
    const passedLater = all.some(
      (other) =>
        other.name === job.name &&
        other.head_sha === job.head_sha &&
        other.conclusion === "success" &&
        other.started_at > job.started_at
    );
    const firstPerTest = errors.filter(
      (error, index) => errors.findIndex((other) => other.test === error.test) === index
    );
    for (const annotation of firstPerTest) {
      const seen = byTest.get(annotation.test) ?? [];
      seen.push({ job, annotation, passedLater });
      byTest.set(annotation.test, seen);
    }
  }
  const tests = [...byTest]
    .map(([title, seen]) => {
      const last = seen.reduce((latest, next) =>
        next.job.started_at > latest.job.started_at ? next : latest
      );
      const distinct = (values: ReadonlyArray<string>) => [...new Set(values)].sort();
      return {
        title,
        failures: seen.length,
        passedOnRerun: seen.filter((failure) => failure.passedLater).length,
        branches: distinct(seen.map((failure) => failure.job.head_branch ?? "")),
        commits: distinct(seen.map((failure) => failure.job.head_sha)),
        jobs: distinct(seen.map((failure) => failure.job.name)),
        lastError: `${last.annotation.path}:${last.annotation.start_line} ${firstLine(last.annotation.message)}`
      };
    })
    .sort(
      (a, b) =>
        b.passedOnRerun - a.passedOnRerun ||
        b.branches.length - a.branches.length ||
        b.failures - a.failures ||
        a.title.localeCompare(b.title)
    );
  return { executions: all.length, failed: failures.length, tests, unclassified, capped };
};

export type Summary = ReturnType<typeof summarize>;
type TestFailures = Summary["tests"][number];

/** Flaky: failed, then passed when its job ran again on the same commit. */
const isFlaky = (test: TestFailures) => test.passedOnRerun > 0;

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("<", "&lt;");
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const minute = (date: Date) => date.toISOString().slice(0, 16).replace("T", " ");
// Each list names at most this many tests, so a bad week's issue body and
// comment stay inside GitHub's 65,536 characters.
const listed = 50;
const bounded = (entries: ReadonlyArray<string>) =>
  entries.length > listed
    ? [...entries.slice(0, listed), "", `And ${entries.length - listed} more.`]
    : entries;

/** The issue body: flaky tests first, then other failing tests, unclassified jobs and the limits. */
export const render = (
  summary: Summary,
  window: { readonly since: Date; readonly until: Date; readonly runs: number }
) => {
  const flaky = summary.tests.filter(isFlaky);
  const others = summary.tests.filter((test) => !isFlaky(test));
  const unclassified = [...summary.unclassified]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([name, count]) => `${name} ${count}`);
  return [
    `CI runs created ${minute(window.since)} to ${minute(window.until)} UTC: ${plural(window.runs, "run")}, ${plural(summary.executions, "job execution")}, ${summary.failed} failed.`,
    "",
    "### Flaky tests",
    "",
    "Tests that failed, then passed when their job ran again on the same commit. CI does not retry: a test that only passes on rerun is still a flake. Fix the cause, not the timeout.",
    "",
    ...(flaky.length === 0
      ? ["None."]
      : [
          "| Test | Failures | Passed on rerun | Branches | Commits | Jobs | Last error |",
          "| --- | --: | --: | --: | --: | --- | --- |",
          ...bounded(
            flaky.map(
              (test) =>
                `| ${cell(test.title)} | ${test.failures} | ${test.passedOnRerun} | ${test.branches.length} | ${test.commits.length} | ${test.jobs.join(", ")} | ${cell(test.lastError)} |`
            )
          )
        ]),
    "",
    ...(others.length === 0
      ? []
      : [
          `<details><summary>${plural(others.length, "other failing test")}</summary>`,
          "",
          "None of these passed when their job ran again on the same commit. Most were broken by their branch's change; one that failed on several branches may still be a flake nobody reran.",
          "",
          ...bounded(
            others.map(
              (test) =>
                `- ${cell(test.title)}: ${plural(test.failures, "failure")} on ${plural(test.commits.length, "commit")} ${test.branches.length === 1 ? `of \`${test.branches[0]}\`` : `across ${plural(test.branches.length, "branch", "branches")}`}. ${cell(test.lastError)}`
            )
          ),
          "",
          "</details>",
          ""
        ]),
    "### Unclassified",
    "",
    summary.unclassified.size === 0
      ? "Every failed job left a test annotation."
      : `${plural(
          [...summary.unclassified.values()].reduce((sum, count) => sum + count, 0),
          "failed job"
        )} left no test annotation (${unclassified.join(", ")}): lint and type errors, the packed CLI scripts, crashes before the test reporter ran, runner acquisition failures and job timeouts.`,
    "",
    "### Limits",
    "",
    `- Counts are lower bounds. GitHub keeps at most 10 error annotations per step and 50 per job; ${plural(summary.capped, "failed job")} reached that cap.`,
    "- Runs are chosen by when they were created, so a rerun this week of an older run is missed.",
    "- The packed CLI scripts (`cli-smoke`, `tier2-smoke`) emit no test annotations, so their failures are unclassified.",
    "",
    "Rewritten every Monday by the flake report workflow from `scripts/flake-report.ts`; edits here are overwritten."
  ].join("\n");
};

/** The flaky tests this week's table names that the previous body's table did not. */
export const newFlakyTests = (summary: Summary, previousBody: string) =>
  summary.tests
    .filter(isFlaky)
    .slice(0, listed)
    .filter((test) => !previousBody.includes(`| ${cell(test.title)} |`));

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const label = "flake-report";
// GITHUB_TOKEN allows 1,000 requests an hour per repository; a week took 315.
const maxRequests = 800;
let requests = 0;

/**
 * One GitHub API request, sequential and spaced so a week's report stays within
 * budget. Reads stop at the budget and a read GitHub fails with a 5xx is tried
 * up to three times; the few writes go through once.
 */
const request = async (path: string, init?: { readonly method: string; readonly body: object }) => {
  for (let attempt = 1; ; attempt++) {
    if (++requests > maxRequests && init === undefined)
      throw new Error(`Stopped reading after ${maxRequests} GitHub API requests.`);
    await sleep(attempt === 1 ? 100 : 10_000);
    const response = await fetch(new URL(path, "https://api.github.com"), {
      method: init?.method ?? "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28"
      },
      ...(init && { body: JSON.stringify(init.body) })
    });
    if (response.status < 500 || init !== undefined || attempt === 3) return response;
  }
};

/** A successful response's JSON, trusted to have GitHub's documented shape, and its next page. */
const call = async <T>(path: string, init?: { readonly method: string; readonly body: object }) => {
  const response = await request(path, init);
  if (!response.ok)
    throw new Error(
      `GitHub answered ${response.status} to ${init?.method ?? "GET"} ${path}: ${await response.text()}`
    );
  const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
  return { body: (await response.json()) as T, next };
};

/** Every item of a paginated list whose pages wrap their items under `key`. */
const list = async <T>(path: string, key: string): Promise<ReadonlyArray<T>> => {
  const { body, next } = await call<Record<string, ReadonlyArray<T>>>(path);
  return [...(body[key] ?? []), ...(next === undefined ? [] : await list<T>(next, key))];
};

/** Rewrites the open `flake-report` issue, creating the label and issue the first time. */
const publish = async (summary: Summary, body: string) => {
  const { body: open } = await call<
    ReadonlyArray<{
      readonly number: number;
      readonly body: string | null;
      readonly pull_request?: object;
    }>
  >(`/repos/${repo}/issues?labels=${label}&state=open&per_page=100`);
  // The issues API lists pull requests too.
  const issue = open.find((item) => item.pull_request === undefined);
  if (issue === undefined) {
    const created = await request(`/repos/${repo}/labels`, {
      method: "POST",
      body: { name: label, color: "fbca04", description: "The weekly CI flake report" }
    });
    // 422: the label exists without an open issue.
    if (!created.ok && created.status !== 422)
      throw new Error(`GitHub answered ${created.status} creating the ${label} label.`);
    const { body: opened } = await call<{ readonly html_url: string }>(`/repos/${repo}/issues`, {
      method: "POST",
      body: { title: "Weekly CI flake report", body, labels: [label] }
    });
    console.log(`\nOpened ${opened.html_url}`);
    return;
  }
  const added = newFlakyTests(summary, issue.body ?? "");
  // Comment first: once the body lists a test, the next run no longer finds it new.
  if (added.length > 0)
    await call(`/repos/${repo}/issues/${issue.number}/comments`, {
      method: "POST",
      body: {
        body: [
          "New to the flaky list:",
          "",
          ...added.map(
            (test) =>
              `- ${cell(test.title)}: ${plural(test.failures, "failure")}, ${test.passedOnRerun} passed on rerun, ${plural(test.branches.length, "branch", "branches")}`
          )
        ].join("\n")
      }
    });
  await call(`/repos/${repo}/issues/${issue.number}`, { method: "PATCH", body: { body } });
  console.log(`\nUpdated issue #${issue.number}; ${plural(added.length, "new flaky test")}.`);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!token || !repo || args.some((arg) => arg !== "--publish")) {
    console.error(
      "Usage: GITHUB_TOKEN=<token> GITHUB_REPOSITORY=<owner/name> node scripts/flake-report.ts [--publish]"
    );
    process.exit(2);
  }
  const until = new Date();
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
  const second = (date: Date) => date.toISOString().replace(/\.\d+Z$/, "Z");
  // Bounded at both ends, so a run created while listing cannot shift the pages.
  const runs = await list<{ readonly id: number }>(
    `/repos/${repo}/actions/workflows/ci.yml/runs?per_page=100&created=${second(since)}..${second(until)}`,
    "workflow_runs"
  );
  const jobs: Array<Job> = [];
  for (const run of runs)
    jobs.push(
      ...(await list<Job>(
        `/repos/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
        "jobs"
      ))
    );
  const { all, failed } = executions(jobs);
  // A job keeps at most 50 annotations, so one page holds them all.
  const failures: Array<Failure> = [];
  for (const job of failed) {
    const { body: annotations } = await call<ReadonlyArray<Annotation>>(
      `/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`
    );
    failures.push({ job, annotations });
  }
  const summary = summarize(all, failures);
  const body = render(summary, { since, until, runs: runs.length });
  console.log(body);
  if (args.includes("--publish")) await publish(summary, body);
  console.error(`${requests} GitHub API requests.`);
}
