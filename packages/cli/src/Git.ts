/**
 * Where a document came from, as far as `git` will say: the remote's org and
 * repo, the branch and the commit. Every field is `null` when there is no
 * repo, no remote or no git; nothing here can fail an upload.
 */
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface Metadata {
  readonly repoOrg: string | null;
  readonly repoName: string | null;
  readonly gitBranch: string | null;
  readonly gitCommitSha: string | null;
}

export const metadata = Effect.fn("Git.metadata")(function* (cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const git = (...args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make("git", args, { cwd, stderr: "ignore" })).pipe(
      Effect.map((output) => output.trim()),
      Effect.orElseSucceed(() => null)
    );

  const repoRoot = yield* git("rev-parse", "--show-toplevel");
  const remote = parseRemote(yield* git("config", "--get", "remote.origin.url"), path);
  return {
    repoOrg: remote.org ?? (repoRoot ? path.basename(path.dirname(repoRoot)) : null),
    repoName: remote.name ?? (repoRoot ? path.basename(repoRoot) : null),
    gitBranch: yield* git("rev-parse", "--abbrev-ref", "HEAD"),
    gitCommitSha: yield* git("rev-parse", "HEAD")
  } satisfies Metadata;
});

/** `git@host:org/name.git`, `https://host/org/name.git`, or a bare `org/name` path. */
const parseRemote = (remote: string | null, path: Path.Path): { org?: string; name?: string } => {
  if (!remote) return {};
  const cleaned = remote.replace(/\.git$/, "");
  const ssh = cleaned.match(/^[^@]+@[^:]+:([^/]+)\/(.+)$/);
  if (ssh?.[1] && ssh[2]) return { org: ssh[1], name: path.basename(ssh[2]) };

  const parts = (URL.canParse(cleaned) ? new URL(cleaned).pathname : cleaned)
    .split("/")
    .filter(Boolean);
  const org = URL.canParse(cleaned) ? parts[0] : parts.at(-2);
  const name = parts.at(-1);
  return parts.length >= 2 && org && name ? { org, name } : {};
};
