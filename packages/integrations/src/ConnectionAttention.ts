// What Home's Needs attention says about a company's connections, in the integrations' own
// words, so the portal never decides what a connection's state means.
import type { ProductMark } from "@patchy/core";
import * as Effect from "effect/Effect";
import { integrationOf } from "./ConnectionPage.js";
import * as ConnectionStore from "./ConnectionStore.js";
import { connectionPath, indexPath } from "./ConnectionsView.js";

/** A connection an admin has to act on: what's wrong, what it stops, and the one place that fixes it. */
export interface Attention {
  readonly id: string;
  /** `kind/handle`, as patches name it. */
  readonly name: string;
  /** Its integration's mark, as Integrations draws it. */
  readonly mark: ProductMark;
  /** What broke, in its integration's words. */
  readonly problem: string;
  /** What it stops, while patches that declare it can't read it: "2 patches can't read it". */
  readonly detail?: string;
  readonly fix: { readonly label: string; readonly href: string };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Why a GitHub connection needs an admin, as its page leads with it. */
const githubStop = (
  connection: Extract<ConnectionStore.Connection, { readonly integration: "github" }>
): Pick<Attention, "problem" | "fix"> | undefined => {
  const reason = connection.display.attention;
  if (reason?.reason === "uninstalled")
    return {
      problem: "Paused: Patchy Cloud was uninstalled on GitHub",
      fix: { label: "Reconnect…", href: connectionPath(connection.id, "rotate") }
    };
  if (reason?.reason === "permissions")
    return {
      problem: "Paused: the installation's permissions changed",
      fix: { label: "Resume…", href: connectionPath(connection.id) }
    };
  if (connection.status === "connected" && connection.suspendedAt !== null)
    return {
      problem: "Suspended on GitHub",
      fix: { label: "Test again…", href: connectionPath(connection.id) }
    };
  const left = connection.display.repositories.filter((item) => item.left === true).length;
  return left === 0
    ? undefined
    : {
        problem:
          left === 1
            ? "A repository left the installation"
            : `${left} repositories left the installation`,
        fix: { label: "Refresh…", href: connectionPath(connection.id) }
      };
};

/**
 * What a connection's provider did that only an admin can undo, as its page's notice says it, and
 * the fix that notice leads with: an Attio key a check found writable, an IMAP login the mail server
 * refused, or a GitHub App uninstalled, its permissions changed, suspended on its account or a
 * repository gone from it. Nothing for any other connection.
 */
const providerStop = (
  connection: ConnectionStore.Connection
): Pick<Attention, "problem" | "fix"> | undefined =>
  connection.integration === "attio" && connection.display.writable !== undefined
    ? {
        problem: "Disconnected: this key can now write",
        fix: { label: "Reconnect…", href: connectionPath(connection.id) }
      }
    : connection.integration === "imap" && connection.display.paused !== undefined
      ? {
          problem: "Paused: the mail server refused the password",
          fix: { label: "Replace password…", href: connectionPath(connection.id, "rotate") }
        }
      : connection.integration === "github"
        ? githubStop(connection)
        : undefined;

/** Whether patches that declare it can't read it now; a role, also while its provider is paused. */
const stops = (connection: ConnectionStore.Connection) =>
  !ConnectionStore.serving(connection) ||
  (connection.integration === "imap" && connection.display.paused !== undefined) ||
  (connection.integration === "github" && connection.suspendedAt !== null);

/** A Pidgeon connection on a test key, whose mail never leaves Pidgeon. */
const testMode = (connection: ConnectionStore.Connection) =>
  connection.integration === "pidgeon" &&
  connection.status === "connected" &&
  connection.display.test;

/**
 * The connections among `connections` that need an admin, given who declares each: one its
 * provider stopped, one an admin disconnected while live patches still declare it, a role whose
 * model provider an admin paused while live patches declare it, and a Pidgeon test key live
 * patches use, whose mail stays in Pidgeon. A disconnected connection or a test key nothing uses
 * was a choice, not a problem, so it isn't here. Names in order.
 */
export const attention = (
  connections: ReadonlyArray<ConnectionStore.Connection>,
  usage: ReadonlyMap<string, ConnectionStore.Usage>
): ReadonlyArray<Attention> =>
  connections
    .flatMap((connection): ReadonlyArray<Attention> => {
      const named = {
        id: connection.id,
        name: `${connection.integration}/${connection.handle}`,
        mark: integrationOf(connection).mark
      };
      const using = (usage.get(connection.id) ?? ConnectionStore.unused).usedBy.length;
      const detail =
        stops(connection) && using > 0
          ? { detail: plural(using, "patch can't read it", "patches can't read it") }
          : {};
      const provider = providerStop(connection);
      if (provider !== undefined) return [{ ...named, ...provider, ...detail }];
      if (testMode(connection))
        return using === 0
          ? []
          : [
              {
                ...named,
                problem: "Test key: mail stays in Pidgeon",
                detail: plural(using, "patch uses it", "patches use it"),
                fix: { label: "Replace key…", href: connectionPath(connection.id, "rotate") }
              }
            ];
      // A role is resumed, or its provider, where Models are, under Integrations.
      return !ConnectionStore.serving(connection) && using > 0
        ? [
            {
              ...named,
              problem:
                connection.status === "disconnected"
                  ? "Disconnected"
                  : connection.integration === "models" && connection.role.provider === null
                    ? "Its model provider isn't available"
                    : "Its model provider is paused",
              ...detail,
              fix:
                connection.integration === "models"
                  ? { label: "Resume…", href: indexPath }
                  : { label: "Reconnect…", href: connectionPath(connection.id) }
            }
          ]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * A company's connections that need an admin, for Home. Who declares each is read only when one
 * is stopped or on a test key, since only then does it matter; a store that can't say still names
 * what its providers stopped, without what that stops.
 */
export const needingAttention = Effect.fn("ConnectionAttention.needingAttention")(function* (
  companyId: string
) {
  const store = yield* ConnectionStore.ConnectionStore;
  const connections = yield* store.list(companyId);
  const none = new Map<string, ConnectionStore.Usage>();
  const usage = connections.some((connection) => stops(connection) || testMode(connection))
    ? yield* store.usage(companyId).pipe(Effect.catch(() => Effect.succeed(none)))
    : none;
  return attention(connections, usage);
});
