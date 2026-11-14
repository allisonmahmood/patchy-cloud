/**
 * The refusals of GitHub reads that are their own: what wasn't found, a cursor from another call,
 * a connection Patchy paused, and a call through a version that doesn't declare the connection.
 * None carries a value patch code supplied beyond what it names, or anything GitHub answered.
 */
import * as Schema from "effect/Schema";

/**
 * What a 404 was of. `repository`: GitHub no longer lets the connection read it, as when a
 * private one left the installation. `log`: the job's log expired.
 */
export const notFoundResources = [
  "repository",
  "workflow",
  "run",
  "job",
  "log",
  "commit",
  "pull_request"
] as const;
export class NotFound extends Schema.TaggedError<NotFound>()("GithubNotFound", {
  resource: Schema.Literals(notFoundResources)
}) {
  readonly code = "not_found" as const;
  readonly status = 404;
  override get message() {
    switch (this.resource) {
      case "repository":
        return "GitHub doesn't let this connection read the repository now. An admin's Refresh on the connection's page says why.";
      case "workflow":
        return "The repository has no such workflow.";
      case "run":
        return "The repository has no such workflow run.";
      case "job":
        return "The repository has no such job.";
      case "log":
        return "The job's log is gone: GitHub keeps logs only for the repository's retention period.";
      case "commit":
        return "The repository has no commit by that SHA, branch or tag.";
      case "pull_request":
        return "The repository has no such pull request.";
    }
  }
  get details() {
    return { resource: this.resource };
  }
}

export class InvalidCursor extends Schema.TaggedError<InvalidCursor>()("GithubInvalidCursor", {}) {
  readonly code = "invalid_cursor" as const;
  readonly status = 400;
  override get message() {
    return "This cursor is from another call: it must come from the same repository, filters and limit.";
  }
}

/** Patchy paused the connection during this call, for a reason an admin fixes. */
export class NeedsAttention extends Schema.TaggedError<NeedsAttention>()("GithubNeedsAttention", {
  reason: Schema.Literals(["uninstalled", "permissions"]),
  account: Schema.String
}) {
  readonly code = "source_unavailable" as const;
  readonly status = 503;
  override get message() {
    return this.reason === "uninstalled"
      ? `Patchy Cloud is no longer installed on ${this.account}, so the connection is paused until an admin reinstalls it and reconnects.`
      : `Patchy Cloud's installation on ${this.account} no longer grants exactly what Patchy reads, so the connection is paused until an admin resumes it.`;
  }
  get details() {
    return { reason: this.reason };
  }
}

export class ConnectionNotDeclared extends Schema.TaggedError<ConnectionNotDeclared>()(
  "GithubConnectionNotDeclared",
  {}
) {
  readonly code = "connection_not_declared" as const;
  readonly status = 400;
  override get message() {
    return "This GitHub connection is not declared by this version.";
  }
}
