/**
 * GitHub: a connection's repositories, read through twelve fixed operations Patchy writes. Patch
 * code names a repository by its name in the connection and plain filters, never a path, a query
 * string, GraphQL or a search: Patchy builds every request from these arguments, addresses the
 * repository by its numeric id, and decodes only the fields each record keeps. Nothing can be
 * written.
 *
 * Every list answers `complete`: whether everything that matches is in it, or, for a list with a
 * cursor, reached by following the cursor to its end.
 */
import * as Schema from "effect/Schema";
import { DefinitionName } from "./schemas.js";

/** A repository by its name in the connection, case-insensitive as GitHub's are. */
export const GithubRepoName = Schema.String.check(
  Schema.isBetweenLength(1, 100),
  Schema.isPattern(/^[A-Za-z0-9._-]+$/)
);
/** A branch or tag name, as git allows them: no spaces, controls or `~^:?*[\`, no `..`. */
export const GithubRefName = Schema.String.check(
  Schema.isBetweenLength(1, 255),
  Schema.isPattern(/^[^\0- \x7F~^:?*[\\]+$/),
  Schema.makeFilter(
    (ref) =>
      (!ref.includes("..") && !ref.startsWith("/") && !ref.endsWith("/")) ||
      "A ref has no `..` and doesn't start or end with `/`."
  )
);
/** A commit's full SHA. */
export const GithubSha = Schema.String.check(
  Schema.isPattern(/^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/)
);
/** A run's, job's or workflow's numeric id, as GitHub gives it. */
export const GithubId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
);
const PullNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }));
/** Patchy's cursor for the next page, passed back as it came. */
const Cursor = Schema.String.check(Schema.isBetweenLength(1, 1024));
/** 1–100 a page; 30 when left out. */
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

/** A day, `YYYY-MM-DD`, or a full ISO time with its offset. */
export const GithubTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/),
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)) || "Not a day or time.")
);
/** Runs created within a span: on or after `from`, on or before `to`, either left open. */
export const GithubCreated = Schema.Struct({
  from: Schema.optionalKey(GithubTime),
  to: Schema.optionalKey(GithubTime)
});

/** The run statuses and conclusions `runs.list` filters by, as GitHub names them. */
export const githubRunStatuses = [
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out"
] as const;

// ---------- what reads answer: Patchy's own trimmed records ----------

/** A GitHub account as a record names it: its login and numeric id, which never changes. */
export const GithubUser = Schema.Struct({ login: Schema.String, id: Schema.Int });
export type GithubUser = typeof GithubUser.Type;

const Time = Schema.String;
const OrNull = <S extends Schema.Top>(schema: S) => Schema.NullOr(schema);

export const GithubRepo = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  /** `owner/name`. */
  fullName: Schema.String,
  url: Schema.String,
  description: OrNull(Schema.String),
  private: Schema.Boolean,
  archived: Schema.Boolean,
  defaultBranch: Schema.String,
  pushedAt: OrNull(Time)
});
export type GithubRepo = typeof GithubRepo.Type;

export const GithubWorkflow = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  /** Its file, such as `.github/workflows/ci.yml`. */
  path: Schema.String,
  /** `active`, or how it was disabled. */
  state: Schema.String,
  url: Schema.String
});
export type GithubWorkflow = typeof GithubWorkflow.Type;

export const GithubRun = Schema.Struct({
  id: Schema.Int,
  /** The run's title, as GitHub shows it: a commit's message or a pull request's title. */
  title: OrNull(Schema.String),
  number: Schema.Int,
  url: Schema.String,
  workflow: Schema.Struct({ id: Schema.Int, name: OrNull(Schema.String), path: Schema.String }),
  event: Schema.String,
  branch: OrNull(Schema.String),
  headSha: Schema.String,
  attempt: Schema.Int,
  status: OrNull(Schema.String),
  conclusion: OrNull(Schema.String),
  actor: OrNull(GithubUser),
  /** The numbers of this repository's pull requests the run is for. */
  pullRequests: Schema.Array(Schema.Int),
  createdAt: Time,
  startedAt: OrNull(Time),
  updatedAt: Time
});
export type GithubRun = typeof GithubRun.Type;

export const GithubStep = Schema.Struct({
  number: Schema.Int,
  name: Schema.String,
  status: Schema.String,
  conclusion: OrNull(Schema.String),
  startedAt: OrNull(Time),
  completedAt: OrNull(Time)
});
export const GithubJob = Schema.Struct({
  id: Schema.Int,
  runId: Schema.Int,
  attempt: Schema.Int,
  name: Schema.String,
  url: OrNull(Schema.String),
  status: Schema.String,
  conclusion: OrNull(Schema.String),
  startedAt: OrNull(Time),
  completedAt: OrNull(Time),
  steps: Schema.Array(GithubStep)
});
export type GithubJob = typeof GithubJob.Type;

export const GithubCheck = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  status: Schema.String,
  conclusion: OrNull(Schema.String),
  startedAt: OrNull(Time),
  completedAt: OrNull(Time),
  url: OrNull(Schema.String),
  /** The App that reported it, by slug, such as `github-actions`. */
  app: OrNull(Schema.String)
});
export type GithubCheck = typeof GithubCheck.Type;

export const GithubPull = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  title: Schema.String,
  /** Null when the account that opened it is gone. */
  author: OrNull(GithubUser),
  draft: Schema.Boolean,
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  mergedAt: OrNull(Time),
  /** Label names. */
  labels: Schema.Array(Schema.String),
  /** Logins of the people asked to review who haven't yet. */
  requestedReviewers: Schema.Array(Schema.String),
  /** Slugs of the teams asked to review. */
  requestedTeams: Schema.Array(Schema.String),
  base: Schema.Struct({ branch: Schema.String }),
  head: Schema.Struct({
    branch: Schema.String,
    sha: Schema.String,
    /** The repository the branch is on, `owner/name`, a fork's too; null once it's gone. */
    repository: OrNull(Schema.Struct({ id: Schema.Int, fullName: Schema.String }))
  }),
  createdAt: Time,
  updatedAt: Time,
  closedAt: OrNull(Time)
});
export type GithubPull = typeof GithubPull.Type;

/**
 * Patchy's count over a pull request's reviews, not GitHub's merge rule: each reviewer's latest
 * review that is an approval or a request for changes and isn't dismissed, over at most
 * `github.list.items` reviews, `complete` false past that.
 */
export const GithubReviewSummary = Schema.Struct({
  approved: Schema.Int,
  changesRequested: Schema.Int,
  complete: Schema.Boolean
});
export const GithubPullDetail = Schema.Struct({
  ...GithubPull.fields,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  reviews: GithubReviewSummary
});
export type GithubPullDetail = typeof GithubPullDetail.Type;

export const GithubFile = Schema.Struct({
  filename: Schema.String,
  /** `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`. */
  status: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  changes: Schema.Int,
  /** The diff's hunks; null when GitHub sends none, as for a binary or very large file. */
  patch: OrNull(Schema.String),
  /** The name before a rename. */
  previousFilename: OrNull(Schema.String)
});
export type GithubFile = typeof GithubFile.Type;

export const GithubReview = Schema.Struct({
  id: Schema.Int,
  author: OrNull(GithubUser),
  state: Schema.Literals(["approved", "changes_requested", "commented", "dismissed", "pending"]),
  submittedAt: OrNull(Time),
  commitId: OrNull(Schema.String),
  url: Schema.String
});
export type GithubReview = typeof GithubReview.Type;

const ok = Schema.Literal(true);
/** Whether everything that matches is here, or reached by following `cursor`. */
const complete = Schema.Boolean;
/** Pass back as `cursor` for the next page of the same call; `null` on the last. */
const next = Schema.NullOr(Schema.String);
const repo = { repo: GithubRepoName };
const paging = { limit: Schema.optionalKey(Limit), cursor: Schema.optionalKey(Cursor) };

/** Each operation's arguments, without the alias, and its result. */
export const githubReads = {
  // No arguments: an empty Struct would let any key through, so this one refuses every key.
  listRepos: {
    input: Schema.Record(Schema.String, Schema.Never),
    output: Schema.Struct({ ok, repositories: Schema.Array(GithubRepo), complete })
  },
  getRepo: {
    input: Schema.Struct(repo),
    output: Schema.Struct({ ok, repository: GithubRepo })
  },
  listWorkflows: {
    input: Schema.Struct(repo),
    output: Schema.Struct({ ok, workflows: Schema.Array(GithubWorkflow), complete })
  },
  /** Newest first. Past GitHub's 1,000 results the rest can't be reached: narrow by `created`. */
  listRuns: {
    input: Schema.Struct({
      ...repo,
      branch: Schema.optionalKey(GithubRefName),
      sha: Schema.optionalKey(GithubSha),
      /** A workflow by its id or its file's name, such as `ci.yml`. */
      workflow: Schema.optionalKey(
        Schema.Union([
          GithubId,
          Schema.String.check(Schema.isMaxLength(255), Schema.isPattern(/^[A-Za-z0-9._-]+\.ya?ml$/))
        ])
      ),
      event: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z_]{1,64}$/))),
      status: Schema.optionalKey(Schema.Literals(githubRunStatuses)),
      created: Schema.optionalKey(GithubCreated),
      ...paging
    }),
    output: Schema.Struct({ ok, runs: Schema.Array(GithubRun), cursor: next, complete })
  },
  getRun: {
    input: Schema.Struct({ ...repo, runId: GithubId }),
    output: Schema.Struct({ ok, run: GithubRun })
  },
  /** The jobs of the run's latest attempt. */
  listJobs: {
    input: Schema.Struct({ ...repo, runId: GithubId }),
    output: Schema.Struct({ ok, jobs: Schema.Array(GithubJob), complete })
  },
  /**
   * The end of a job's log, at most `github.log.bytes`: untrusted text from the repository's CI,
   * to show as text, never to run or follow. `truncated` says its start was cut off; `size` is
   * the whole log's, in bytes.
   */
  getJobLog: {
    input: Schema.Struct({ ...repo, jobId: GithubId }),
    output: Schema.Struct({
      ok,
      text: Schema.String,
      truncated: Schema.Boolean,
      size: Schema.Int
    })
  },
  /** A commit's check runs, by its SHA, a branch or a tag. */
  listChecks: {
    input: Schema.Struct({ ...repo, ref: GithubRefName }),
    output: Schema.Struct({ ok, checks: Schema.Array(GithubCheck), complete })
  },
  listPulls: {
    input: Schema.Struct({
      ...repo,
      /** `open` when left out. */
      state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
      /** The branch they merge into. */
      base: Schema.optionalKey(GithubRefName),
      /** The branch they merge from: `branch` on the connection's account, or `owner:branch`. */
      head: Schema.optionalKey(
        Schema.String.check(
          Schema.isBetweenLength(1, 356),
          Schema.isPattern(/^(?:[A-Za-z0-9-]{1,100}:)?[^\0- \x7F~^:?*[\\]+$/)
        )
      ),
      /** Newest created first when left out. */
      orderBy: Schema.optionalKey(
        Schema.Struct({
          field: Schema.Literals(["created", "updated", "popularity", "long-running"]),
          direction: Schema.optionalKey(Schema.Literals(["asc", "desc"]))
        })
      ),
      ...paging
    }),
    output: Schema.Struct({ ok, pulls: Schema.Array(GithubPull), cursor: next, complete })
  },
  getPull: {
    input: Schema.Struct({ ...repo, number: PullNumber }),
    output: Schema.Struct({ ok, pull: GithubPullDetail })
  },
  /** Past GitHub's 3,000 files the rest can't be reached. */
  listPullFiles: {
    input: Schema.Struct({ ...repo, number: PullNumber, ...paging }),
    output: Schema.Struct({ ok, files: Schema.Array(GithubFile), cursor: next, complete })
  },
  listPullReviews: {
    input: Schema.Struct({ ...repo, number: PullNumber }),
    output: Schema.Struct({ ok, reviews: Schema.Array(GithubReview), complete })
  }
} as const;
export type GithubRead = keyof typeof githubReads;
export const githubOperationNames = [
  "listRepos",
  "getRepo",
  "listWorkflows",
  "listRuns",
  "getRun",
  "listJobs",
  "getJobLog",
  "listChecks",
  "listPulls",
  "getPull",
  "listPullFiles",
  "listPullReviews"
] as const satisfies ReadonlyArray<GithubRead>;

/** An operation's arguments on a declared connection: its alias beside the input. */
const withAlias = <F extends Schema.Struct.Fields>(input: Schema.Struct<F>) =>
  Schema.Struct({ connection: DefinitionName, ...input.fields });
export const GithubListRepos = Schema.Struct({ connection: DefinitionName });
export const GithubGetRepo = withAlias(githubReads.getRepo.input);
export const GithubListWorkflows = withAlias(githubReads.listWorkflows.input);
export const GithubListRuns = withAlias(githubReads.listRuns.input);
export const GithubGetRun = withAlias(githubReads.getRun.input);
export const GithubListJobs = withAlias(githubReads.listJobs.input);
export const GithubGetJobLog = withAlias(githubReads.getJobLog.input);
export const GithubListChecks = withAlias(githubReads.listChecks.input);
export const GithubListPulls = withAlias(githubReads.listPulls.input);
export const GithubGetPull = withAlias(githubReads.getPull.input);
export const GithubListPullFiles = withAlias(githubReads.listPullFiles.input);
export const GithubListPullReviews = withAlias(githubReads.listPullReviews.input);

const operation = <const Op extends string, Args extends Schema.Top, Output extends Schema.Top>(
  op: Op,
  args: Args,
  response: Output
) =>
  ({
    request: Schema.Struct({ op: Schema.Literal(op), args }),
    response,
    kind: "integration"
  }) as const;

/**
 * The runtime operations, flat as the runtime and dev-read grammar take them. Each result encodes
 * through its operation's own schema, so a field outside it never leaves the host.
 */
export const githubOperations = {
  "github.listRepos": operation("github.listRepos", GithubListRepos, githubReads.listRepos.output),
  "github.getRepo": operation("github.getRepo", GithubGetRepo, githubReads.getRepo.output),
  "github.listWorkflows": operation(
    "github.listWorkflows",
    GithubListWorkflows,
    githubReads.listWorkflows.output
  ),
  "github.listRuns": operation("github.listRuns", GithubListRuns, githubReads.listRuns.output),
  "github.getRun": operation("github.getRun", GithubGetRun, githubReads.getRun.output),
  "github.listJobs": operation("github.listJobs", GithubListJobs, githubReads.listJobs.output),
  "github.getJobLog": operation("github.getJobLog", GithubGetJobLog, githubReads.getJobLog.output),
  "github.listChecks": operation(
    "github.listChecks",
    GithubListChecks,
    githubReads.listChecks.output
  ),
  "github.listPulls": operation("github.listPulls", GithubListPulls, githubReads.listPulls.output),
  "github.getPull": operation("github.getPull", GithubGetPull, githubReads.getPull.output),
  "github.listPullFiles": operation(
    "github.listPullFiles",
    GithubListPullFiles,
    githubReads.listPullFiles.output
  ),
  "github.listPullReviews": operation(
    "github.listPullReviews",
    GithubListPullReviews,
    githubReads.listPullReviews.output
  )
} as const;
export type GithubOperation = keyof typeof githubOperations;
