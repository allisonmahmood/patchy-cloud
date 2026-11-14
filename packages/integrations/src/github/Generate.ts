import type { GithubDeclaration, GithubRepository, GithubSnapshot } from "@patchy/api";

/** What generation writes for a GitHub declaration: the connection's client and its context. */
export interface Generated {
  readonly client: string;
  readonly context: string;
}

const markdown = (value: string): string =>
  `<code>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;").replaceAll("`", "&#96;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;").replaceAll("|", "&#124;")}</code>`;

// Nothing is generated per repository: the client is the same whatever the connection holds.
const client = `// Generated for a GitHub connection. Browser-only; transport is supplied by the host.
import type { Call } from "patchy/client";
export type Client = Readonly<Record<never, never>>;
export function createClient(_connection: string, _call: Call): Client {
  return {};
}
`;

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

## Repositories

${snapshot.repositories.map(repository).join("\n")}
`
});
