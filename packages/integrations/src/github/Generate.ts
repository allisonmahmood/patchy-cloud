import type { GithubDeclaration, GithubRepository, GithubSnapshot } from "@patchy/api";
import { registry } from "@patchy/limits/registry";

/** What generation writes for a GitHub declaration: the connection's client and its context. */
export interface Generated {
  readonly client: string;
  readonly context: string;
}

const markdown = (value: string): string =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("`", "&#96;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("|", "&#124;")}</code>`;

// Nothing is generated per repository: the client is the same whatever the connection holds, since
// what a call reaches is the connection's current set, never a snapshot's.
const client = `// Generated for a GitHub connection. Tier 2 handlers type ctx.connections with it; the host supplies the transport.
// Patchy builds every GitHub request from these typed arguments and reads only: nothing here can
// name a path, send a query or search, or change anything on GitHub.
import { createGithubClient } from "patchy/client";
import type { BoundaryError as ClientBoundaryError, Call, Errors, GithubClient } from "patchy/client";
export type { ErrorCode, ErrorDetails, Errors, GithubCheck as Check, GithubFile as File, GithubJob as Job, GithubLog as Log, GithubPull as Pull, GithubPullDetail as PullDetail, GithubRepo as Repo, GithubReview as Review, GithubRun as Run, GithubStep as Step, GithubUser as User, GithubWorkflow as Workflow } from "patchy/client";
export type BoundaryError = ClientBoundaryError | Errors<"connection_not_declared">;
// These unions describe known Patchy refusals, not checked or exhaustive TypeScript throws.
// GitHub's own details: narrow a caught error with isPatchyError(error, code, "github").
export type ReadError =
  | BoundaryError
  | Errors<"not_found" | "invalid_cursor" | "source_rate_limited", \`github.\${string}\`>;
export type Client = GithubClient;
export function createClient(connection: string, call: Call): Client {
  return createGithubClient(connection, call);
}
`;

const kib = (bytes: number) => `${bytes / 1024} KiB`;
const operations = `## Operations

Use the declared alias: \`ctx.connections.<alias>\` in an action; the page calls the action. Every call reads; none can change GitHub. \`repo\` is a repository's name below.

- \`repos.list()\`: the repositories the connection reaches now; \`repos.get(repo)\`: one.
- \`workflows.list(repo)\`; \`runs.list({ repo, branch, sha, workflow, event, status, created, limit, cursor })\`, newest first; \`runs.get({ repo, runId })\`; \`runs.jobs({ repo, runId })\`, the latest attempt's jobs and their steps; \`jobs.log({ repo, jobId })\`, the log's last ${kib(registry["github.log.bytes"].default)} with \`truncated\` true when its start was cut off; \`commits.checks({ repo, ref })\`.
- \`pulls.list({ repo, state, base, head, orderBy, limit, cursor })\`; \`pulls.get({ repo, number })\`, with a review summary that isn't GitHub's merge rule; \`pulls.files({ repo, number, limit, cursor })\`; \`pulls.reviews({ repo, number })\`.
- Every list answers \`complete\`. Run listings reach GitHub's first 1,000 runs: narrow by \`created: { from, to }\`. A pull request's files stop at 3,000. Lists without a cursor hold ${registry["github.list.items"].default}.
- \`limit\` is 1–100, 30 when left out; pass \`cursor\` back with the same arguments. Pages aren't a snapshot: a list that changes between pages can repeat or skip an item.

In \`patchy dev\`, reads are these repositories' real runs, logs and pull requests, read through Patchy as you.

Read \`.agents/skills/patchy-github/SKILL.md\` before building with it.`;

const repository = (item: GithubRepository) =>
  `- ${markdown(item.name)}: ${[
    item.private ? "private" : "public",
    `default branch ${markdown(item.defaultBranch || "unknown")}`,
    ...(item.archived ? ["archived"] : []),
    ...(item.disabled ? ["disabled"] : []),
    ...(item.left === true ? ["left the installation: refused until a Refresh finds it back"] : [])
  ].join(", ")}`;

/** The account and its repositories, as an agent building with the connection needs them. */
export const generate = (
  declaration: typeof GithubDeclaration.Type & { readonly description?: string },
  snapshot: GithubSnapshot
): Generated => ({
  client,
  context: `# GitHub connection

Handle: ${markdown(declaration.handle)}

Description: ${markdown(declaration.description ?? "")}

Snapshot revision: ${declaration.revision}

Account: ${markdown(snapshot.account.login)} (${snapshot.account.type === "User" ? "a personal account" : "an organization"})

Read only. Every member reads, through a patch that declares this connection, the code, pull requests and CI logs of these repositories, whatever their own access on GitHub; nothing Patchy sends can change GitHub, and no other repository can be reached. CI logs can hold secrets a workflow printed.

A call names a repository by its name here. What a call may reach is the connection's current set, which an admin changes on the connection's page: a repository added later is reachable without \`patchy refresh\`, and one removed is refused.

${operations}

## Repositories

${snapshot.repositories.map(repository).join("\n")}
`
});
