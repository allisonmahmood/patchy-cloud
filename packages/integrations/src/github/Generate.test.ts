import { assert, it } from "@effect/vitest";
import type {
  GithubCheck as WireCheck,
  GithubFile as WireFile,
  GithubJob as WireJob,
  GithubPull as WirePull,
  GithubPullDetail as WirePullDetail,
  GithubRepo as WireRepo,
  GithubReview as WireReview,
  GithubRun as WireRun,
  GithubUser as WireUser,
  GithubWorkflow as WireWorkflow,
  githubReads
} from "@patchy/api";
import { typecheck } from "../../../../test/typescript.js";
import type * as Client from "../../../patchy/src/github.js";
import { generate } from "./Generate.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/**
 * The client's copies of the wire's records are the wire's, so a patch reads exactly what the
 * host encodes; a change to one alone fails the typecheck here. Its arguments must always fit
 * the wire.
 */
const same: [
  Equal<Client.GithubUser, WireUser>,
  Equal<Client.GithubRepo, WireRepo>,
  Equal<Client.GithubWorkflow, WireWorkflow>,
  Equal<Client.GithubRun, WireRun>,
  Equal<Client.GithubJob, WireJob>,
  Equal<Client.GithubCheck, WireCheck>,
  Equal<Client.GithubPull, WirePull>,
  Equal<Client.GithubPullDetail, WirePullDetail>,
  Equal<Client.GithubFile, WireFile>,
  Equal<Client.GithubReview, WireReview>,
  Equal<Client.GithubLog, Omit<(typeof githubReads.getJobLog.output)["Type"], "ok">>
] = [true, true, true, true, true, true, true, true, true, true, true];
type Runs = Parameters<Client.GithubClient["runs"]["list"]>[0];
type Pulls = Parameters<Client.GithubClient["pulls"]["list"]>[0];
type Files = Parameters<Client.GithubClient["pulls"]["files"]>[0];
const fits: [
  Runs extends (typeof githubReads.listRuns.input)["Type"] ? true : false,
  Pulls extends (typeof githubReads.listPulls.input)["Type"] ? true : false,
  Files extends (typeof githubReads.listPullFiles.input)["Type"] ? true : false
] = [true, true, true];
void [same, fits];

const declaration = { kind: "github" as const, handle: "platform", id: "conn_repos", revision: 2 };
const snapshot = {
  version: 1 as const,
  account: { id: 9001, login: "northwind-labs", type: "Organization" as const },
  repositories: [
    {
      id: 11,
      name: "api",
      defaultBranch: "main",
      private: true,
      archived: false,
      disabled: false
    }
  ]
};

it("types a CI dashboard's and a pull-request board's reads, and their refusals", () => {
  assert.deepStrictEqual(
    typecheck({
      "generated.ts": generate(declaration, snapshot).client,
      "consumer.ts": `import { createClient, type Run, type ReadError } from "./generated.js";
import { isPatchyError } from "patchy/client";
const repos = createClient("repos", async () => ({ ok: true }));
async function dashboard() {
  const { repositories } = await repos.repos.list();
  const repo: string = repositories[0]!.name;
  const page = await repos.runs.list({ repo, branch: "main", status: "failure", created: { from: "2026-11-01" }, limit: 50 });
  const failing: readonly Run[] = page.runs;
  const more = page.complete ? null : page.cursor;
  const { jobs } = await repos.runs.jobs({ repo, runId: failing[0]!.id });
  const log = await repos.jobs.log({ repo, jobId: jobs[0]!.id });
  const cut: boolean = log.truncated;
  const { checks } = await repos.commits.checks({ repo, ref: failing[0]!.headSha });
  void [more, cut, checks[0]!.conclusion];
  // @ts-expect-error a status is one GitHub names
  void repos.runs.list({ repo, status: "red" });
}
async function board() {
  const { pulls, cursor } = await repos.pulls.list({ repo: "api", state: "open", orderBy: { field: "updated" } });
  const pull = await repos.pulls.get({ repo: "api", number: pulls[0]!.number });
  const approved: number = pull.reviews.approved;
  const author: string | undefined = pull.author?.login;
  const files = await repos.pulls.files({ repo: "api", number: pull.number, cursor: cursor ?? undefined });
  const patch: string | null = files.files[0]!.patch;
  const { reviews } = await repos.pulls.reviews({ repo: "api", number: pull.number });
  void [approved, author, patch, reviews[0]!.state];
  // @ts-expect-error nothing can be written
  void repos.pulls.merge;
}
function recover(error: ReadError | unknown) {
  if (isPatchyError(error, "not_found", "github")) {
    const resource: string = error.details.resource;
    return resource;
  }
  return null;
}
void [dashboard, board, recover];
`
    }),
    []
  );
});

it("tells an agent each operation, the caps and that nothing is written", () => {
  const { context } = generate(declaration, snapshot);
  for (const text of [
    "repos.list()",
    "runs.list({ repo, branch, sha, workflow, event, status, created, limit, cursor })",
    "runs.jobs({ repo, runId })",
    "jobs.log({ repo, jobId })",
    "commits.checks({ repo, ref })",
    "pulls.list({ repo, state, base, head, orderBy, limit, cursor })",
    "pulls.files({ repo, number, limit, cursor })",
    "complete",
    "1,000",
    "3,000",
    "none can change GitHub",
    "patchy-github/SKILL.md"
  ])
    assert.include(context, text);
});
