/**
 * GitHub's answers, decoded from only the fields Patchy keeps, and made Patchy's own trimmed
 * records. A field GitHub adds is never read; one it drops fails the decode, and the call answers
 * unavailable rather than a record missing a guaranteed field.
 */
import type {
  GithubCheck,
  GithubFile,
  GithubJob,
  GithubPull,
  GithubRepo,
  GithubReview,
  GithubRun,
  GithubUser,
  GithubWorkflow
} from "@patchy/api";
import * as Schema from "effect/Schema";

const Text = Schema.String;
const Maybe = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));
const User = Schema.Struct({ login: Text, id: Schema.Int });
const user = (value: typeof User.Type | null | undefined): GithubUser | null =>
  value === null || value === undefined ? null : { login: value.login, id: value.id };
const or = <A>(value: A | null | undefined): A | null => value ?? null;

const Repo = Schema.Struct({
  id: Schema.Int,
  name: Text,
  full_name: Text,
  html_url: Text,
  description: Maybe(Text),
  private: Schema.Boolean,
  archived: Schema.optionalKey(Schema.Boolean),
  default_branch: Maybe(Text),
  pushed_at: Maybe(Text)
});
export const repo = (body: typeof Repo.Type): GithubRepo => ({
  id: body.id,
  name: body.name,
  fullName: body.full_name,
  url: body.html_url,
  description: or(body.description),
  private: body.private,
  archived: body.archived ?? false,
  defaultBranch: body.default_branch ?? "",
  pushedAt: or(body.pushed_at)
});

const Workflow = Schema.Struct({
  id: Schema.Int,
  name: Text,
  path: Text,
  state: Text,
  html_url: Text
});
const workflow = (body: typeof Workflow.Type): GithubWorkflow => ({
  id: body.id,
  name: body.name,
  path: body.path,
  state: body.state,
  url: body.html_url
});

const Run = Schema.Struct({
  id: Schema.Int,
  name: Maybe(Text),
  display_title: Maybe(Text),
  run_number: Schema.Int,
  html_url: Text,
  workflow_id: Schema.Int,
  path: Text,
  event: Text,
  head_branch: Maybe(Text),
  head_sha: Text,
  run_attempt: Schema.optionalKey(Schema.Int),
  status: Maybe(Text),
  conclusion: Maybe(Text),
  actor: Maybe(User),
  pull_requests: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        base: Schema.Struct({ repo: Schema.Struct({ id: Schema.Int }) })
      })
    )
  ),
  created_at: Text,
  run_started_at: Maybe(Text),
  updated_at: Text,
  repository: Schema.Struct({ id: Schema.Int })
});
/** A run, its pull requests only those of `repositoryId`: a fork's own aren't the connection's. */
const run = (body: typeof Run.Type, repositoryId: number): GithubRun => ({
  id: body.id,
  title: or(body.display_title),
  number: body.run_number,
  url: body.html_url,
  workflow: { id: body.workflow_id, name: or(body.name), path: body.path },
  event: body.event,
  branch: or(body.head_branch),
  headSha: body.head_sha,
  attempt: body.run_attempt ?? 1,
  status: or(body.status),
  conclusion: or(body.conclusion),
  actor: user(body.actor),
  pullRequests: (body.pull_requests ?? [])
    .filter((item) => item.base.repo.id === repositoryId)
    .map((item) => item.number),
  createdAt: body.created_at,
  startedAt: or(body.run_started_at),
  updatedAt: body.updated_at
});

const Step = Schema.Struct({
  number: Schema.Int,
  name: Text,
  status: Text,
  conclusion: Maybe(Text),
  started_at: Maybe(Text),
  completed_at: Maybe(Text)
});
const Job = Schema.Struct({
  id: Schema.Int,
  run_id: Schema.Int,
  run_attempt: Schema.optionalKey(Schema.Int),
  name: Text,
  html_url: Maybe(Text),
  status: Text,
  conclusion: Maybe(Text),
  started_at: Maybe(Text),
  completed_at: Maybe(Text),
  steps: Schema.optionalKey(Schema.Array(Step))
});
const job = (body: typeof Job.Type): GithubJob => ({
  id: body.id,
  runId: body.run_id,
  attempt: body.run_attempt ?? 1,
  name: body.name,
  url: or(body.html_url),
  status: body.status,
  conclusion: or(body.conclusion),
  startedAt: or(body.started_at),
  completedAt: or(body.completed_at),
  steps: (body.steps ?? []).map((step) => ({
    number: step.number,
    name: step.name,
    status: step.status,
    conclusion: or(step.conclusion),
    startedAt: or(step.started_at),
    completedAt: or(step.completed_at)
  }))
});

const Check = Schema.Struct({
  id: Schema.Int,
  name: Text,
  status: Text,
  conclusion: Maybe(Text),
  started_at: Maybe(Text),
  completed_at: Maybe(Text),
  html_url: Maybe(Text),
  app: Maybe(Schema.Struct({ slug: Maybe(Text) }))
});
const check = (body: typeof Check.Type): GithubCheck => ({
  id: body.id,
  name: body.name,
  status: body.status,
  conclusion: or(body.conclusion),
  startedAt: or(body.started_at),
  completedAt: or(body.completed_at),
  url: or(body.html_url),
  app: or(body.app?.slug)
});

const Pull = Schema.Struct({
  number: Schema.Int,
  html_url: Text,
  title: Text,
  user: Maybe(User),
  draft: Schema.optionalKey(Schema.Boolean),
  state: Schema.Literals(["open", "closed"]),
  merged_at: Maybe(Text),
  labels: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Text }))),
  requested_reviewers: Schema.optionalKey(Schema.Array(Schema.Struct({ login: Text }))),
  requested_teams: Schema.optionalKey(Schema.Array(Schema.Struct({ slug: Text }))),
  base: Schema.Struct({ ref: Text, repo: Schema.Struct({ id: Schema.Int }) }),
  head: Schema.Struct({
    ref: Text,
    sha: Text,
    repo: Schema.NullOr(Schema.Struct({ id: Schema.Int, full_name: Text }))
  }),
  created_at: Text,
  updated_at: Text,
  closed_at: Maybe(Text)
});
const PullDetail = Schema.Struct({
  ...Pull.fields,
  additions: Schema.Int,
  deletions: Schema.Int,
  changed_files: Schema.Int
});
const pull = (body: typeof Pull.Type): GithubPull => ({
  number: body.number,
  url: body.html_url,
  title: body.title,
  author: user(body.user),
  draft: body.draft ?? false,
  state: body.state,
  merged: body.merged_at !== null && body.merged_at !== undefined,
  mergedAt: or(body.merged_at),
  labels: (body.labels ?? []).map((label) => label.name),
  requestedReviewers: (body.requested_reviewers ?? []).map((item) => item.login),
  requestedTeams: (body.requested_teams ?? []).map((item) => item.slug),
  base: { branch: body.base.ref },
  head: {
    branch: body.head.ref,
    sha: body.head.sha,
    repository:
      body.head.repo === null ? null : { id: body.head.repo.id, fullName: body.head.repo.full_name }
  },
  createdAt: body.created_at,
  updatedAt: body.updated_at,
  closedAt: or(body.closed_at)
});

const File = Schema.Struct({
  filename: Text,
  status: Text,
  additions: Schema.Int,
  deletions: Schema.Int,
  changes: Schema.Int,
  patch: Maybe(Text),
  previous_filename: Maybe(Text)
});
const file = (body: typeof File.Type): GithubFile => ({
  filename: body.filename,
  status: body.status,
  additions: body.additions,
  deletions: body.deletions,
  changes: body.changes,
  patch: or(body.patch),
  previousFilename: or(body.previous_filename)
});

const reviewStates = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "pending"
} as const;
const Review = Schema.Struct({
  id: Schema.Int,
  user: Maybe(User),
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  submitted_at: Maybe(Text),
  commit_id: Maybe(Text),
  html_url: Text
});
const review = (body: typeof Review.Type): GithubReview => ({
  id: body.id,
  author: user(body.user),
  state: reviewStates[body.state],
  submittedAt: or(body.submitted_at),
  commitId: or(body.commit_id),
  url: body.html_url
});

/**
 * Patchy's count over reviews, in the order GitHub lists them, oldest first: each reviewer's
 * latest review that is an approval or a request for changes and isn't dismissed. Not GitHub's
 * merge rule, which also weighs code owners, required counts and stale reviews.
 */
export const summary = (reviews: ReadonlyArray<GithubReview>) => {
  const latest = new Map<number, GithubReview["state"]>();
  for (const item of reviews)
    if (item.author !== null && (item.state === "approved" || item.state === "changes_requested"))
      latest.set(item.author.id, item.state);
  const states = [...latest.values()];
  return {
    approved: states.filter((state) => state === "approved").length,
    changesRequested: states.filter((state) => state === "changes_requested").length
  };
};

/** Each answer's decoder, and what it makes of the body. */
export const answers = {
  repo: { decode: Schema.decodeUnknownOption(Repo), make: repo },
  installationRepos: {
    decode: Schema.decodeUnknownOption(
      Schema.Struct({ total_count: Schema.Int, repositories: Schema.Array(Repo) })
    ),
    make: repo
  },
  workflows: {
    decode: Schema.decodeUnknownOption(
      Schema.Struct({ total_count: Schema.Int, workflows: Schema.Array(Workflow) })
    ),
    make: workflow
  },
  runs: {
    decode: Schema.decodeUnknownOption(
      Schema.Struct({ total_count: Schema.Int, workflow_runs: Schema.Array(Run) })
    ),
    make: run
  },
  run: { decode: Schema.decodeUnknownOption(Run), make: run },
  jobs: {
    decode: Schema.decodeUnknownOption(
      Schema.Struct({ total_count: Schema.Int, jobs: Schema.Array(Job) })
    ),
    make: job
  },
  checks: {
    decode: Schema.decodeUnknownOption(
      Schema.Struct({ total_count: Schema.Int, check_runs: Schema.Array(Check) })
    ),
    make: check
  },
  pulls: { decode: Schema.decodeUnknownOption(Schema.Array(Pull)), make: pull },
  pull: { decode: Schema.decodeUnknownOption(PullDetail), make: pull },
  files: { decode: Schema.decodeUnknownOption(Schema.Array(File)), make: file },
  reviews: { decode: Schema.decodeUnknownOption(Schema.Array(Review)), make: review }
};
