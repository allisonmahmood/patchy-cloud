import type { GithubSnapshot } from "@patchy/api";
import {
  ago,
  button,
  checklist,
  checklistGroups,
  escapeAttribute,
  escapeHtml,
  linkButton,
  searchField
} from "@patchy/core";
import { registry } from "@patchy/limits/registry";
import type * as Redacted from "effect/Redacted";
import type * as ConnectFrame from "../ConnectFrame.js";
import type * as ConnectionStore from "../ConnectionStore.js";
import * as View from "../ConnectionsView.js";
import * as Connection from "./Connection.js";
import type * as Flows from "./Flows.js";

/**
 * What the connections pages say about GitHub, and its connect page in the shared frame: sign in
 * to GitHub, tick repositories you administer on one account, name it. Signing in is the step
 * other integrations paste a credential in; the repositories GitHub lists for the person are the
 * choosing step, drawn by the server once they're back from GitHub. Installing the App and adding
 * repositories to it happen on GitHub and prove nothing: only what the person's own listing shows
 * them administering can be ticked.
 */

type Connection = Extract<ConnectionStore.Connection, { readonly integration: "github" }>;
type Submitted = Readonly<Record<string, string | undefined>>;

export const integration = { key: "github", label: "GitHub", mark: { logo: "github" } } as const;
export const offer = { integration, line: "Code, pull requests and CI runs" };
/** What recent calls keep of a GitHub call. */
export const logged =
  "Each call keeps the repository it named and how many rows came back; code, logs and pull request text are never logged.";
export const actions: View.Actions = {
  refresh: "Refresh repositories",
  rotate: "Reconnect",
  access: "Change repositories"
};
export const results = {
  connect: "GitHub connected and its repositories discovered.",
  rotate:
    "Reconnected to the account's new installation, with every repository checked there again.",
  access:
    "Repositories changed. Calls reach the new set now; the next publish of a patch needs patchy refresh.",
  refresh:
    "Repositories refreshed. Existing patches keep their pinned snapshot; regenerate before publishing against the new one.",
  reconnect: "Checked and resumed.",
  delete:
    "Disconnected. Its name is free; its snapshots are kept. Patchy Cloud stays installed on GitHub."
};

/** Where the person signs in, for a new connection or a connection's Add or Reconnect. */
export const startPath = "/settings/integrations/connect/github/start";
/** Where GitHub sends the person back, which the App registers as its callback URL. */
export const callbackPath = "/settings/integrations/github/callback";
/** Where GitHub sends someone after installing or changing the App, the App's setup URL. */
export const setupPath = "/settings/integrations/github/setup";
export const connectPath = View.connectPath(integration.key);

const start = (purpose: Flows.Purpose, connectionId?: string, another = false) => {
  const query = new URLSearchParams({ purpose });
  if (connectionId !== undefined) query.set("connection", connectionId);
  if (another) query.set("account", "choose");
  return `${startPath}?${query.toString()}`;
};

const accountWord = (type: "User" | "Organization") =>
  type === "User" ? "a personal account" : "an organization";
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const listed = (items: ReadonlyArray<string>) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
/** Where an account's owner manages the App's installation, and removes it. */
const installationUrl = (connection: Connection) =>
  connection.display.account.type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(connection.display.account.login)}/settings/installations/${connection.display.installationId}`
    : `https://github.com/settings/installations/${connection.display.installationId}`;

const left = (connection: Connection) =>
  connection.display.repositories.filter((item) => item.left === true);

export const source = (connection: Connection) => connection.display.account.login;
/** What it holds, as Settings names it: the App's installation on one account, never a token. */
export const credential = (connection: Connection) => ({
  label: "GitHub App installation",
  detail: `On ${connection.display.account.login}, ${accountWord(connection.display.account.type)}`
});
/** What patches may read, which Change repositories changes. */
export const allowed = (connection: Connection) => {
  const names = connection.display.repositories.map((item) => item.name);
  return `Read ${names.length <= 3 ? listed(names) : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`}`;
};
export const facts = (connection: Connection): ReadonlyArray<readonly [string, string]> => [
  [
    "Account",
    `${connection.display.account.login}, ${accountWord(connection.display.account.type)}`
  ],
  [
    "Repositories",
    connection.display.repositories
      .map((item) => `${item.name}${item.left === true ? " (left)" : ""}`)
      .join(", ")
  ],
  ["Reads", "Code, pull requests, CI runs and logs; nothing on GitHub changes"]
];

const checks = { call: "a patch's call", test: "Test", refresh: "Refresh", reconnect: "Resume" };

/**
 * Why a GitHub connection needs an admin, in its order of weight: the App uninstalled, or its
 * permissions changed, either of which Patchy paused it for; the App suspended on the account,
 * which isn't a pause and heals once it's unsuspended; repositories that left the installation.
 */
export const attention = (
  connection: Connection,
  people: ReadonlyMap<string, string>,
  now: number
): View.Attention | undefined => {
  const account = connection.display.account.login;
  const reason = connection.display.attention;
  if (reason !== undefined) {
    const who =
      reason.by === undefined
        ? checks[reason.during]
        : `${people.get(reason.by) ?? "An admin"}'s ${checks[reason.during]}`;
    const found = `${who.charAt(0).toUpperCase()}${who.slice(1)}, ${ago(reason.at, now)}, found`;
    return reason.reason === "uninstalled"
      ? {
          tone: "danger",
          title: "Patchy Cloud was uninstalled on GitHub",
          text: `${found} Patchy Cloud is no longer installed on ${account}, so Patchy paused the connection. An owner of ${account} installs it again on GitHub, which makes a new installation; then Reconnect here.`,
          paused: true,
          fixes: [
            {
              href: View.connectionPath(connection.id, "rotate"),
              label: "Reconnect…",
              primary: true
            }
          ]
        }
      : {
          tone: "danger",
          title: "The installation's permissions changed",
          text: `${found} Patchy Cloud's installation on ${account} no longer grants exactly what Patchy reads${(reason.missing ?? []).length === 0 ? "" : `: it lacks ${listed(reason.missing ?? [])}`}${(reason.above ?? []).length === 0 ? "" : `${(reason.missing ?? []).length === 0 ? ":" : ", and"} it grants more than read on ${listed(reason.above ?? [])}`}. Patchy paused the connection. An owner of ${account} accepts the App's permissions on GitHub, then Resume.`,
          paused: true,
          fixes: [
            {
              href: View.connectionPath(connection.id, "reconnect"),
              label: "Resume",
              primary: true,
              post: true
            }
          ]
        };
  }
  if (connection.suspendedAt !== null && connection.status === "connected")
    return {
      tone: "warning",
      badge: `Suspended on GitHub, last checked ${ago(connection.suspendedAt, now)}`,
      title: "Suspended on GitHub",
      text: `${account} suspended Patchy Cloud on GitHub, as Patchy last saw ${ago(connection.suspendedAt, now)}. Patches' calls are refused until it's unsuspended there, and then work again by themselves; nothing needs doing in Patchy.`,
      fixes: [
        {
          href: View.connectionPath(connection.id, "test"),
          label: "Test",
          primary: true,
          post: true
        }
      ]
    };
  const gone = left(connection);
  if (gone.length > 0)
    return {
      tone: "warning",
      title:
        gone.length === 1
          ? `${gone[0]!.name} left the installation`
          : `${gone.length} repositories left the installation`,
      text: `${listed(gone.map((item) => item.name))} ${gone.length === 1 ? "is" : "are"} no longer in Patchy Cloud's installation on ${account}, so calls to ${gone.length === 1 ? "it" : "them"} are refused. Refresh finds one that's back. To end its access for good, remove it from the connection.`,
      fixes: [
        {
          href: View.connectionPath(connection.id, "refresh"),
          label: "Refresh",
          primary: true,
          post: true
        },
        { href: View.connectionPath(connection.id, "access"), label: "Change repositories…" }
      ]
    };
  return undefined;
};

export const consequences = {
  delete:
    "No stored patch version declares it. Patchy forgets it and frees the name; the snapshots patches were published against are kept. This can't be undone. Patchy Cloud stays installed on GitHub.",
  disconnect:
    "Patches that declare it can't read it until an admin resumes it. Patchy keeps the connection and the account stays connected to this company; resuming checks the installation first."
};
/** Where the App is removed on GitHub, which Disconnect leaves installed. */
export const removal = (connection: ConnectionStore.Connection) =>
  connection.integration === "github"
    ? { href: installationUrl(connection), label: "Remove it on GitHub" }
    : undefined;

/** What its snapshot lets patches read: the repositories by name. */
export const reads = (snapshot: GithubSnapshot) => {
  const shown = 10;
  return {
    summary: `${plural(snapshot.repositories.length, "repository", "repositories")} on ${snapshot.account.login}: code, pull requests, CI runs and logs. Nothing on GitHub changes.`,
    items: snapshot.repositories
      .slice(0, shown)
      .map((item) => `${item.name}${item.left === true ? " (left the installation)" : ""}`),
    more: Math.max(0, snapshot.repositories.length - shown)
  };
};

// ---------- signing in and choosing ----------

/** What the connect page and the Add and Reconnect dialogs know of the admin's sign-in. */
export type SignIn =
  | { readonly kind: "signed-out" }
  | {
      readonly kind: "signed-in";
      readonly login: string;
      /** What the person administers where the App is installed; none when it couldn't be read. */
      readonly listed: Flows.Listing | null;
      readonly installUrl: string;
    };

/** The connect page's state: the sign-in, the filter, and the boxes already ticked. */
export interface ConnectState {
  readonly signIn: SignIn;
  readonly query: string;
  readonly chosen: ReadonlyArray<string>;
}

/**
 * The form the sign-in buttons post, drawn outside the connection's own form: a button joins it
 * by its `form` attribute, so Enter in the name or filter field never starts a sign-in.
 */
const signInFormId = "github-sign-in";
export const signInForm = `<form id="${signInFormId}" method="post" hidden></form>`;

/** Section 1: Continue with GitHub, or who GitHub signed them in as and the way to switch. */
const signInBody = (signIn: SignIn, purpose: Flows.Purpose, connectionId?: string) =>
  signIn.kind === "signed-out"
    ? `<p class="prose">Patchy asks GitHub which repositories you administer.</p><div class="btn-group">${button("Continue with GitHub", { form: signInFormId, formAction: start(purpose, connectionId) })}</div>`
    : `<div class="cluster"><p class="prose">Signed in as <strong>${escapeHtml(signIn.login)}</strong>.</p>${button("Use another GitHub account", { kind: "quiet", size: "sm", form: signInFormId, formAction: start(purpose, connectionId, true) })}</div>`;

const describe = (item: { readonly private: boolean; readonly archived: boolean }) =>
  `${item.private ? "Private" : "Public"}${item.archived ? " · archived" : ""}`;

const notInstalled = (installUrl: string) =>
  `<p class="prose">Patchy Cloud isn't installed on an account where you administer a repository.</p><div class="btn-group">${linkButton("Install on GitHub", installUrl)}</div><p class="meta">On an organization you don't own, GitHub sends its owners a request.</p>`;
const notListed = (installUrl: string) =>
  `<p class="meta">Not listed? <a href="${escapeAttribute(installUrl)}">Add repositories on GitHub</a>, then come back.</p>`;

/**
 * Said when nothing is offered but GitHub listed more than Patchy read: the empty answer covers
 * only what was read, never passed off as everything.
 */
const unread = (listing: Flows.Listing) => {
  const accounts = registry["github.picker.installations"].default.toLocaleString("en-US");
  const repositories = registry["github.picker.repositories"].default.toLocaleString("en-US");
  if (!listing.complete)
    return `<p class="meta">${escapeHtml(`Patchy read only the first ${accounts} accounts GitHub listed for you.`)}</p>`;
  return listing.accounts.some((account) => !account.complete)
    ? `<p class="meta">${escapeHtml(`Patchy read only the first ${repositories} repositories of each account.`)}</p>`
    : "";
};

/** Whether the person administers any repository where the App is installed. */
const offered = (listing: Flows.Listing) =>
  listing.accounts.some((account) => account.repositories.length > 0);

const shownMax = registry["github.picker.shown"].default;
/**
 * Which repositories a list of them shows: every ticked one, and of the rest those whose name
 * holds `query`, until `github.picker.shown` have, counted across every list it's asked about.
 */
const showing = (query: string, chosen: ReadonlySet<string>) => {
  const wanted = query.trim().toLowerCase();
  let budget = shownMax;
  return (name: string, value: string) => {
    if (chosen.has(value)) return true;
    if (budget <= 0 || (wanted !== "" && !name.toLowerCase().includes(wanted))) return false;
    budget--;
    return true;
  };
};
/**
 * The filter by name over a list longer than it shows, a GET of the form to `get` that keeps its
 * text and ticks, and how many it shows of how many.
 */
const filterField = (input: {
  readonly id: string;
  readonly get: string;
  readonly query: string;
  readonly total: number;
  readonly shown: number;
}) =>
  input.total > shownMax || input.query.trim() !== ""
    ? `${searchField({ id: input.id, inForm: true, get: input.get, query: input.query, placeholder: "Filter by name", label: "Filter repositories" })}${input.shown < input.total ? `<p class="meta">${escapeHtml(`Showing ${input.shown} of ${input.total}.${input.query.trim() === "" ? " Filter by name to find the others." : ""}`)}</p>` : ""}`
    : "";
const noMatch = `<p class="meta">Nothing matches that filter.</p>`;

/**
 * Section 2: the repositories the person administers, one list per account, the ticked account's
 * setting back the others. At most `github.picker.shown` show at once, ticked ones always; a
 * filter by name finds the rest.
 */
const chooseBody = (state: ConnectState) => {
  const { signIn } = state;
  if (signIn.kind === "signed-out")
    return `<p class="meta">They appear here once you've signed in.</p>`;
  if (signIn.listed === null)
    return `<p class="meta">Patchy couldn't read them from GitHub. Press Use another GitHub account, or reload the page, to try again.</p>`;
  if (!offered(signIn.listed)) return `${notInstalled(signIn.installUrl)}${unread(signIn.listed)}`;
  const chosen = new Set(state.chosen);
  const accounts = signIn.listed.accounts;
  const total = accounts.reduce((sum, account) => sum + account.repositories.length, 0);
  const shows = showing(state.query, chosen);
  const groups = accounts
    .filter((account) => account.repositories.length > 0)
    .map((account) => {
      const items = account.repositories.flatMap((repository) => {
        const value = Connection.choiceValue(account.installationId, repository.id);
        if (!shows(repository.name, value)) return [];
        return [
          {
            value,
            label: repository.name,
            description: describe(repository),
            checked: chosen.has(value) && !account.suspended,
            disabled: account.suspended
          }
        ];
      });
      return { account, items };
    })
    .filter((group) => group.items.length > 0);
  const filter = filterField({
    id: "github-filter",
    get: connectPath,
    query: state.query,
    total,
    shown: groups.reduce((sum, group) => sum + group.items.length, 0)
  });
  // Past the installations Patchy reads, the rest aren't listed: said, never passed off as all.
  const more = signIn.listed.complete
    ? ""
    : `<p class="meta">${escapeHtml(`Showing what you administer on the first ${registry["github.picker.installations"].default.toLocaleString("en-US")} accounts GitHub listed for you.`)}</p>`;
  return `<p class="meta">Repositories you administer where Patchy Cloud is installed. One account per connection.</p>${filter}${
    groups.length === 0
      ? noMatch
      : checklistGroups(
          groups.map(({ account, items }) => ({
            id: `github-${account.installationId}`,
            legend: account.account.login,
            name: "repository",
            items,
            ...(account.suspended
              ? { hint: "Suspended on GitHub: it can be connected once it's unsuspended there." }
              : account.complete
                ? {}
                : {
                    hint: `Showing the first ${registry["github.picker.repositories"].default.toLocaleString("en-US")} repositories GitHub listed here.`
                  })
          }))
        )
  }${more}${notListed(signIn.installUrl)}`;
};

/** The connect page in the shared frame, as the admin's sign-in leaves it. */
export const connectSpec = (state: ConnectState): ConnectFrame.ConnectSpec => ({
  paste: {
    title: "Sign in to GitHub",
    fields: [],
    after: () => signInBody(state.signIn, "connect")
  },
  choose: () => [
    {
      title: "Choose repositories",
      body: chooseBody(state),
      locked: state.signIn.kind === "signed-out"
    }
  ],
  ready:
    state.signIn.kind === "signed-in" &&
    state.signIn.listed !== null &&
    offered(state.signIn.listed),
  outside: signInForm,
  name: { example: "platform", describe: "The platform team's repositories" },
  once: {
    reads: "the code, pull requests and CI logs of these repositories",
    devReads: true,
    cannot: ["Nothing on GitHub can be changed", "No other repository can be reached"],
    caveat: "CI logs can hold secrets a workflow printed."
  }
});

/** The frame's spec before anything is known: what the shared page list reads for GitHub. */
export const connect = connectSpec({ signIn: { kind: "signed-out" }, query: "", chosen: [] });

/** Refusals about the repositories read above Test and connect, where the list is. */
export const credentialRefusals: ReadonlyMap<string, View.Field> = new Map();
/** A refusal's bold first line, where the message reads as its explanation. */
export const refusalTitles: ReadonlyMap<string, string> = new Map([
  ["github_installation_claimed", "This account is connected to another Patchy company"],
  ["github_not_admin", "GitHub doesn't show you as an admin"],
  ["github_sign_in_required", "Sign in to GitHub again"]
]);

/** A connection's ticked boxes, as the page joined them: values separated by commas. */
const values = (joined: string | undefined) =>
  (joined ?? "").split(",").filter((value) => value !== "");

/**
 * What an admin submitted, as the secret the store reads: the ticked repositories to connect, or
 * for a connection, the repositories it keeps and any to add, or a Reconnect.
 */
export const credentials = (
  form: Submitted,
  current?: ConnectionStore.Connection
): Redacted.Redacted<string> | View.Notice => {
  if (current === undefined) {
    const request = Connection.requestOf(values(form.repository));
    if (request.repositories.length === 0)
      return {
        message: new Connection.NoRepositories({}).message,
        code: "github_no_repositories",
        status: 422
      };
    return Connection.request(request);
  }
  if (form.action === "reconnect") return Connection.change({ action: "reconnect" });
  const keep = values(form.keep).flatMap((value) =>
    /^\d{1,15}$/.test(value) ? [Number(value)] : []
  );
  return Connection.change({
    action: "repositories",
    keep,
    add: Connection.requestOf(values(form.repository)).repositories
  });
};

/** Reconnect, over a connection's Settings: sign in, then move it to the account's new installation. */
export const reconnectDialog = (connection: Connection, signIn: SignIn) => ({
  title: (name: string) => `Reconnect ${name}`,
  consequence: `Use this after Patchy Cloud was installed on ${connection.display.account.login} again, which GitHub counts as a new installation. Sign in as someone GitHub shows administering every repository here; Patchy checks each one on the new installation before switching.`,
  submit: "Reconnect",
  fields: () =>
    `<input type="hidden" name="action" value="reconnect">${signInBody(signIn, "reconnect", connection.id)}`,
  outside: signInForm,
  shows: [] as ReadonlyArray<View.Field>
});

/**
 * Change repositories, over a connection's Settings: untick to remove, which needs no sign-in;
 * sign in to add ones GitHub shows you administering on the connection's account, at most
 * `github.picker.shown` at once with a filter by name for the rest, as on the connect page.
 * The filter is a GET of the dialog, and it and a refused save draw the boxes as they were
 * ticked; opened afresh, every repository it holds is kept.
 */
export const repositoriesDialog = (connection: Connection, signIn: SignIn) => {
  const known = new Set(connection.display.repositories.map((item) => item.id));
  const here =
    signIn.kind === "signed-in"
      ? signIn.listed?.accounts.find(
          (account) => account.installationId === connection.display.installationId
        )
      : undefined;
  const addable = (here?.repositories ?? []).filter((item) => !known.has(item.id));
  const add = (query: string, chosen: ReadonlySet<string>) => {
    if (signIn.kind === "signed-out")
      return `<p class="meta">To add repositories, sign in to GitHub as someone who administers them.</p>${signInBody(signIn, "add", connection.id)}`;
    const shows = showing(query, chosen);
    const items = addable.flatMap((item) => {
      const value = Connection.choiceValue(connection.display.installationId, item.id);
      return shows(item.name, value)
        ? [{ value, label: item.name, description: describe(item), checked: chosen.has(value) }]
        : [];
    });
    return `${signInBody(signIn, "add", connection.id)}${
      addable.length === 0
        ? `<p class="meta">${escapeHtml(`GitHub shows you administering nothing more on ${connection.display.account.login} where Patchy Cloud is installed.`)}</p>`
        : `${filterField({
            id: "github-add-filter",
            get: View.connectionPath(connection.id, "access"),
            query,
            total: addable.length,
            shown: items.length
          })}${items.length === 0 ? noMatch : checklist({ id: "github-add", legend: "Add", name: "repository", items })}`
    }${signIn.listed === null ? "" : notListed(signIn.installUrl)}`;
  };
  return {
    title: (name: string) => `Change the repositories of ${name}`,
    consequence:
      "Calls reach the new set at once. Published patches keep the snapshot they were published with; the next publish needs patchy refresh.",
    submit: "Save repositories",
    fields: (submitted: Submitted) => {
      const kept = submitted.keep === undefined ? undefined : new Set(values(submitted.keep));
      return `<input type="hidden" name="action" value="repositories">${checklist({
        id: "github-keep",
        legend: "Keep",
        name: "keep",
        items: connection.display.repositories.map((item) => ({
          value: String(item.id),
          label: item.name,
          description: `${item.private ? "Private" : "Public"}${item.left === true ? " · left the installation" : ""}`,
          checked: kept?.has(String(item.id)) ?? true
        }))
      })}${add(submitted.q ?? "", new Set(values(submitted.repository)))}`;
    },
    outside: signInForm,
    shows: [] as ReadonlyArray<View.Field>
  };
};
