import { decodeError } from "./clientError.js";

/**
 * One GitHub connection's client, in a tier 2 action. Patchy builds every request from these
 * arguments and addresses each repository by its id, so nothing here can name a path, send a
 * query or a search, or change anything on GitHub. A repository is named by its name in the
 * connection. These types mirror `packages/api/src/github.ts`, the wire they decode; the
 * integrations' generation test holds them to it.
 */

/** A GitHub account as a record names it: its login, and its numeric id, which never changes. */
export interface GithubUser {
  readonly login: string;
  readonly id: number;
}

export interface GithubRepo {
  readonly id: number;
  readonly name: string;
  /** `owner/name`. */
  readonly fullName: string;
  readonly url: string;
  readonly description: string | null;
  readonly private: boolean;
  readonly archived: boolean;
  readonly defaultBranch: string;
  readonly pushedAt: string | null;
}

export interface GithubWorkflow {
  readonly id: number;
  readonly name: string;
  /** Its file, such as `.github/workflows/ci.yml`. */
  readonly path: string;
  /** `active`, or how it was disabled. */
  readonly state: string;
  readonly url: string;
}

export interface GithubRun {
  readonly id: number;
  /** The run's title as GitHub shows it: a commit's message or a pull request's title. */
  readonly title: string | null;
  readonly number: number;
  readonly url: string;
  readonly workflow: { readonly id: number; readonly name: string | null; readonly path: string };
  readonly event: string;
  readonly branch: string | null;
  readonly headSha: string;
  readonly attempt: number;
  /** `queued`, `in_progress`, `completed` and the like, as GitHub names them. */
  readonly status: string | null;
  /** `success`, `failure`, `cancelled` and the like once completed; null before. */
  readonly conclusion: string | null;
  readonly actor: GithubUser | null;
  /** The numbers of this repository's pull requests the run is for. */
  readonly pullRequests: readonly number[];
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
}

export interface GithubStep {
  readonly number: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface GithubJob {
  readonly id: number;
  readonly runId: number;
  readonly attempt: number;
  readonly name: string;
  readonly url: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly steps: readonly GithubStep[];
}

export interface GithubLog {
  /**
   * The end of the log: untrusted text from the repository's CI, to show as text, never to run,
   * follow or render as HTML. It can hold secrets a workflow printed.
   */
  readonly text: string;
  /** Whether the log's start was cut off: `text` is only its end. */
  readonly truncated: boolean;
  /** The whole log's size, in bytes. */
  readonly size: number;
}

export interface GithubCheck {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly url: string | null;
  /** The App that reported it, by slug, such as `github-actions`. */
  readonly app: string | null;
}

export interface GithubPull {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  /** Null when the account that opened it is gone. */
  readonly author: GithubUser | null;
  readonly draft: boolean;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly mergedAt: string | null;
  /** Label names. */
  readonly labels: readonly string[];
  /** Logins of the people asked to review who haven't yet. */
  readonly requestedReviewers: readonly string[];
  /** Slugs of the teams asked to review. */
  readonly requestedTeams: readonly string[];
  readonly base: { readonly branch: string };
  readonly head: {
    readonly branch: string;
    readonly sha: string;
    /** The repository the branch is on, a fork's too; null once it's gone. */
    readonly repository: { readonly id: number; readonly fullName: string } | null;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface GithubPullDetail extends GithubPull {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  /**
   * Patchy's count, not GitHub's merge rule: each reviewer's latest review that is an approval or
   * a request for changes and isn't dismissed, over at most 100 reviews, `complete` false past.
   */
  readonly reviews: {
    readonly approved: number;
    readonly changesRequested: number;
    readonly complete: boolean;
  };
}

export interface GithubFile {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  /** The diff's hunks; null when GitHub sends none, as for a binary or very large file. */
  readonly patch: string | null;
  readonly previousFilename: string | null;
}

export interface GithubReview {
  readonly id: number;
  readonly author: GithubUser | null;
  readonly state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  readonly submittedAt: string | null;
  readonly commitId: string | null;
  readonly url: string;
}

/** A day, `YYYY-MM-DD`, or a full ISO time with its offset. */
export type GithubTime = string;

export type GithubRunStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "requested"
  | "waiting"
  | "pending"
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out";

/** A page of a list with a cursor: pass `cursor` back with the same arguments for the next. */
interface Paging {
  /** 1–100; 30 when left out. */
  readonly limit?: number;
  readonly cursor?: string;
}
type Page<K extends string, A> = { readonly [P in K]: readonly A[] } & {
  /** Null on the last page. */
  readonly cursor: string | null;
  /** Whether following `cursor` to its end reaches everything that matches. */
  readonly complete: boolean;
};
type All<K extends string, A> = { readonly [P in K]: readonly A[] } & {
  /** Whether everything that matches is here. */
  readonly complete: boolean;
};

export interface GithubClient {
  readonly repos: {
    /** The repositories the connection reaches now. */
    list(): Promise<All<"repositories", GithubRepo>>;
    get(repo: string): Promise<GithubRepo>;
  };
  readonly workflows: {
    list(repo: string): Promise<All<"workflows", GithubWorkflow>>;
  };
  readonly runs: {
    /**
     * Newest first. GitHub reaches only a listing's first 1,000 runs: past them `complete` is
     * false, so narrow by `created`.
     */
    list(
      options: Paging & {
        readonly repo: string;
        readonly branch?: string;
        /** A commit's full SHA. */
        readonly sha?: string;
        /** A workflow by its id or its file's name, such as `ci.yml`. */
        readonly workflow?: number | string;
        readonly event?: string;
        readonly status?: GithubRunStatus;
        /** Runs created on or after `from` and on or before `to`, either left open. */
        readonly created?: { readonly from?: GithubTime; readonly to?: GithubTime };
      }
    ): Promise<Page<"runs", GithubRun>>;
    get(options: { readonly repo: string; readonly runId: number }): Promise<GithubRun>;
    /** The jobs of the run's latest attempt, with their steps. */
    jobs(options: {
      readonly repo: string;
      readonly runId: number;
    }): Promise<All<"jobs", GithubJob>>;
  };
  readonly jobs: {
    /** The end of a job's log, at most 1 MiB. */
    log(options: { readonly repo: string; readonly jobId: number }): Promise<GithubLog>;
  };
  readonly commits: {
    /** A commit's check runs, by its SHA, a branch or a tag. */
    checks(options: {
      readonly repo: string;
      readonly ref: string;
    }): Promise<All<"checks", GithubCheck>>;
  };
  readonly pulls: {
    list(
      options: Paging & {
        readonly repo: string;
        /** `open` when left out. */
        readonly state?: "open" | "closed" | "all";
        /** The branch they merge into. */
        readonly base?: string;
        /** The branch they merge from: a branch on the connection's account, or `owner:branch`. */
        readonly head?: string;
        /** Newest created first when left out. */
        readonly orderBy?: {
          readonly field: "created" | "updated" | "popularity" | "long-running";
          readonly direction?: "asc" | "desc";
        };
      }
    ): Promise<Page<"pulls", GithubPull>>;
    get(options: { readonly repo: string; readonly number: number }): Promise<GithubPullDetail>;
    /** GitHub reaches a pull request's first 3,000 files: past them `complete` is false. */
    files(
      options: Paging & { readonly repo: string; readonly number: number }
    ): Promise<Page<"files", GithubFile>>;
    reviews(options: {
      readonly repo: string;
      readonly number: number;
    }): Promise<All<"reviews", GithubReview>>;
  };
}

type Operation =
  | "github.listRepos"
  | "github.getRepo"
  | "github.listWorkflows"
  | "github.listRuns"
  | "github.getRun"
  | "github.listJobs"
  | "github.getJobLog"
  | "github.listChecks"
  | "github.listPulls"
  | "github.getPull"
  | "github.listPullFiles"
  | "github.listPullReviews";
type Call = (op: Operation, args: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** The broker refuses an option set to undefined, so those are left out, as JSON would. */
const defined = (input: object) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

export function createGithubClient(connection: string, call: Call): GithubClient {
  const invoke = async <A>(op: Operation, args: object): Promise<A> => {
    let value: unknown;
    try {
      value = await call(op, { ...defined(args), connection });
    } catch (error) {
      throw decodeError(error, op) ?? error;
    }
    const error = decodeError(value, op);
    if (error) throw error;
    // The host encodes each result through its own wire schema; `ok` says nothing more here.
    const answer: Record<string, unknown> = { ...(value as object) };
    delete answer["ok"];
    return answer as A;
  };
  return {
    repos: {
      list: () => invoke("github.listRepos", {}),
      get: async (repo) =>
        (await invoke<{ readonly repository: GithubRepo }>("github.getRepo", { repo })).repository
    },
    workflows: { list: (repo) => invoke("github.listWorkflows", { repo }) },
    runs: {
      list: (options) => invoke("github.listRuns", options),
      get: async (options) =>
        (await invoke<{ readonly run: GithubRun }>("github.getRun", options)).run,
      jobs: (options) => invoke("github.listJobs", options)
    },
    jobs: { log: (options) => invoke("github.getJobLog", options) },
    commits: { checks: (options) => invoke("github.listChecks", options) },
    pulls: {
      list: (options) => invoke("github.listPulls", options),
      get: async (options) =>
        (await invoke<{ readonly pull: GithubPullDetail }>("github.getPull", options)).pull,
      files: (options) => invoke("github.listPullFiles", options),
      reviews: (options) => invoke("github.listPullReviews", options)
    }
  };
}
