/**
 * Your agents at `/agents`: what acts as the person, records first. Build patches lists their
 * machine tokens, the computers that publish as them; Use patches lists their agent connections.
 * Each section's way to add one is its own page: Add a computer at `/agents/computer`, and
 * Connect an app at `/agents/connect`, where `?app=` picks the app's steps. The links to them
 * keep the ids old `/machines#add-a-computer` and `#connect-an-agent` links name. Disconnect
 * everything confirms at `/agents/disconnect-all`. The app tabs are links, so the pages run no
 * script but the shell's copy buttons.
 */
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as UrlParams from "effect/http/UrlParams";
import type * as SqlClient from "effect/sql/SqlClient";
import { Companies, Users } from "@patchy/companies";
import {
  ago,
  copyLine,
  copyScriptPath,
  dateLabel,
  escapeAttribute,
  escapeHtml,
  sentenceList
} from "@patchy/core";
import * as AgentConnections from "./AgentConnections.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Receipt from "./Receipt.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse, type Page } from "./page.js";

const WEEK_MS = 7 * 86_400_000;
/** Disconnect everything's form carries one id. */
const MAX_FORM_BYTES = 1_024;

const styles = `
    .agents { max-width: 760px; }
    .agents-row { display: flex; align-items: center; gap: 16px; }
    .agents-row > div { flex: 1; min-width: 0; }
    .agents-row > div > * { margin: 0; }
    .agents-row > div > * + * { margin-top: 4px; }
    .agents-add { margin-top: 16px; }
    .agents-add-body { margin-top: 16px; }
    .agents-add-body > * + * { margin-top: 16px; }
    .agents-steps { margin-bottom: 0; padding-left: 1.4em; }
    .agents-steps > li + li { margin-top: 20px; }
    .agents-steps > li > * { margin: 0; }
    .agents-steps > li > * + * { margin-top: 8px; }
    .agents-foot { margin-top: 40px; }
`;

/** The agents with a tab, in tab order; `?app=` names one, and Claude's opens by default. */
const agents = {
  claude: "Claude",
  "claude-code": "Claude Code",
  codex: "Codex",
  chatgpt: "ChatGPT",
  another: "Another agent"
} as const;
type Agent = keyof typeof agents;
const isAgent = (value: string): value is Agent => Object.hasOwn(agents, value);

/** One numbered instruction: its title, then its body as HTML. */
interface Step {
  readonly title: string;
  readonly body: string;
}

const addressLine = (address: string) =>
  copyLine(address, "Patchy’s address, select to copy", "Patchy’s address");
const commandLine = (command: string, target: string) =>
  copyLine(command, "Command to run, select to copy", target);

/** One agent's instructions: what to paste, then the yes in the browser, then a first request. */
const steps = (agent: Agent, address: string, company: string): ReadonlyArray<Step> => {
  const name = agent === "another" ? "your agent" : agents[agent];
  const allow = `Patchy asks, signed in as you, whether ${name} may act as you. Allow it.`;
  const ask: Step = {
    title: "Ask for something",
    body: `<p>Ask ${name} what it can do at ${company}, or name a patch. It works in the patches you can open, as you.</p>`
  };
  switch (agent) {
    case "claude":
      return [
        {
          title: "Add Patchy as a connector",
          body: `<p>In Claude, open <strong>Settings › Connectors</strong> and choose <strong>Add custom connector</strong>. Name it Patchy and paste:</p>${addressLine(address)}<p class="supporting-text">Works in Claude on the web, the desktop app and your phone: they share connectors.</p>`
        },
        { title: "Say yes in your browser", body: `<p>Choose Connect. ${allow}</p>` },
        ask
      ];
    case "claude-code":
      return [
        {
          title: "Add Patchy to Claude Code",
          body: `<p>In a terminal, run:</p>${commandLine(`claude mcp add --transport http patchy ${address}`, "the command")}<p>Then, in Claude Code, run <code>/mcp</code> and choose patchy to sign in.</p>`
        },
        { title: "Say yes in your browser", body: `<p>Your browser opens. ${allow}</p>` },
        ask
      ];
    case "codex":
      return [
        {
          title: "Add Patchy to Codex",
          body: `<p>In a terminal, run:</p>${commandLine(`codex mcp add patchy --url ${address}`, "the add command")}<p>Then sign in:</p>${commandLine("codex mcp login patchy", "the sign-in command")}`
        },
        { title: "Say yes in your browser", body: `<p>Your browser opens. ${allow}</p>` },
        ask
      ];
    case "chatgpt":
      return [
        {
          title: "Add Patchy as a connector",
          body: `<p>In ChatGPT, add a custom connector named Patchy with this address:</p>${addressLine(address)}<p class="supporting-text">Only some ChatGPT plans can add custom connectors.</p>`
        },
        { title: "Say yes in your browser", body: `<p>Choose Connect. ${allow}</p>` },
        ask
      ];
    case "another":
      return [
        {
          title: "Give it Patchy’s address",
          body: `<p>Add Patchy to your agent as an MCP server with this address:</p>${addressLine(address)}<p class="supporting-text">Some agents, such as Cursor and Gemini CLI, can’t connect yet.</p>`
        },
        { title: "Say yes in your browser", body: `<p>When your agent signs in, ${allow}</p>` },
        ask
      ];
  }
};

/** What acts as the person now, which Disconnect everything would end. */
const holdings = Effect.fn("MachinesPage.holdings")(function* (userId: string) {
  return {
    machines: yield* (yield* MachineTokens.MachineTokens).list(userId),
    connections: yield* (yield* AgentConnections.AgentConnections).list(userId)
  };
});
type Holdings = Effect.Success<ReturnType<typeof holdings>>;

/** "2 computers and 1 agent", "1 computer": what ends, without a kind there are none of. */
const ending = ({ machines, connections }: Holdings) =>
  [[machines.length, "computer"] as const, [connections.length, "agent"] as const]
    .flatMap(([count, noun]) => (count === 0 ? [] : [`${count} ${noun}${count === 1 ? "" : "s"}`]))
    .join(" and ");

/** Everything Your agents shows, gathered for one viewer. */
interface View extends Holdings {
  readonly viewer: RequireSession.Viewer["Service"];
  /** `null` while agent access is on; otherwise the admins who can turn it on, by name. */
  readonly admins: ReadonlyArray<string> | null;
  readonly now: number;
}

const date = (iso: string) =>
  `<time datetime="${escapeAttribute(iso)}">${escapeHtml(dateLabel(iso))}</time>`;
const lastUsed = (iso: string, now: number) =>
  `<time datetime="${escapeAttribute(iso)}" title="${escapeAttribute(dateLabel(iso))}">${escapeHtml(ago(iso, now))}</time>`;

const machineRow = (machine: View["machines"][number], now: number) =>
  `<li class="list-row agents-row"><div><h3 class="section-heading">${escapeHtml(machine.name)}</h3><p class="supporting-text">Used ${lastUsed(machine.lastUsedAt, now)} · expires ${date(machine.expiresAt)} or after 30 days unused</p></div><form method="post" action="/agents/computers/${encodeURIComponent(machine.id)}/disconnect"><button class="btn btn-danger" type="submit" aria-label="Revoke ${escapeAttribute(machine.name)}">Revoke</button></form></li>`;

/**
 * A connection unused for a week says when it ends, and that a reconnect leaves it behind. Its
 * Disconnect names the date it connected too, since a reconnect lists two of the same name.
 */
const connectionRow = (connection: AgentConnections.Listed, now: number) => {
  const name = escapeHtml(connection.clientName);
  const used = connection.lastUsedAt ?? connection.connectedAt;
  const leftover =
    now - Date.parse(used) >= WEEK_MS
      ? `<p class="supporting-text">If you reconnected ${name} since, this is the old one; it ends on its own on ${date(connection.endsAt)}.</p>`
      : "";
  return `<li class="list-row agents-row"><div><h3 class="section-heading">${name}</h3><p class="supporting-text">${escapeHtml(connection.clientSite)} · connected ${date(connection.connectedAt)} · ${connection.lastUsedAt === null ? "no calls yet" : `last call ${lastUsed(connection.lastUsedAt, now)}`}</p>${leftover}</div><form method="post" action="/agents/apps/${encodeURIComponent(connection.id)}/disconnect"><button class="btn btn-danger" type="submit" aria-label="${escapeAttribute(`Disconnect ${connection.clientName}, connected ${dateLabel(connection.connectedAt)}`)}">Disconnect</button></form></li>`;
};

const buildSection = ({ machines, now }: View) =>
  `<section class="section" aria-labelledby="build-heading"><h2 class="section-heading" id="build-heading">Build patches</h2><p class="supporting-text">Computers that publish as you.</p>${machines.length === 0 ? "<p>No computer publishes as you yet.</p>" : `<ul class="list">${machines.map((machine) => machineRow(machine, now)).join("")}</ul>`}<p class="agents-add"><a class="btn" id="add-a-computer" href="/agents/computer">Add a computer</a></p></section>`;

/** With agent access off, who can turn it on, in place of a way to connect an app. */
const accessOff = (viewer: View["viewer"], admins: ReadonlyArray<string>) =>
  `<p class="note note-warn" id="connect-an-agent">Agent access is off at ${escapeHtml(viewer.company.name)}. ${sentenceList(admins)} can turn it on.${viewer.role === "admin" ? ' <a href="/settings/agent-access">Turn it on</a>' : ""}</p>`;

const useSection = ({ viewer, admins, connections, now }: View) =>
  `<section class="section" aria-labelledby="use-heading"><h2 class="section-heading" id="use-heading">Use patches</h2><p class="supporting-text">Apps that act as you, through the agent tools patches offer.</p>${connections.length === 0 ? "<p>No app uses patches as you yet.</p>" : `<ul class="list">${connections.map((connection) => connectionRow(connection, now)).join("")}</ul>`}${admins === null ? '<p class="agents-add"><a class="btn" id="connect-an-agent" href="/agents/connect">Connect an app</a></p>' : accessOff(viewer, admins)}</section>`;

const render = (view: View): Page => ({
  title: "Your agents",
  app: { viewer: view.viewer, section: "agents" },
  styles,
  body: `<div class="agents">${buildSection(view)}${useSection(view)}<p class="agents-foot"><a class="btn btn-quiet btn-danger" href="/agents/disconnect-all">Disconnect everything…</a></p></div>`
});

/** One of Your agents' own pages: its way back, its heading, then what it holds. */
const subpage = (viewer: View["viewer"], title: string, body: string): Page => ({
  title,
  app: { viewer, section: "agents" },
  styles,
  heading: "",
  body: `<article class="agents"><p><a href="/agents">Back to Your agents</a></p><h1 class="page-heading">${escapeHtml(title)}</h1>${body}</article><script defer src="${copyScriptPath}"></script>`
});

/** The admins who can turn agent access on, by name, or `null` while it is on. */
const accessAdmins = Effect.fn("MachinesPage.accessAdmins")(function* (viewer: View["viewer"]) {
  // The viewer's own company: it exists for as long as they can open this page.
  const access = yield* (yield* Companies.Companies)
    .agentAccess(viewer.company.id)
    .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
  if (access.on) return null;
  return (yield* (yield* Users.Users).list(viewer.company.id))
    .filter((user) => user.role === "admin" && user.deactivatedAt === null)
    .map((user) => user.name.trim() || user.email)
    .sort((a, b) => a.localeCompare(b));
});

const machines = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  return pageResponse(
    render({
      viewer,
      admins: yield* accessAdmins(viewer),
      ...(yield* holdings(viewer.user.id)),
      now: yield* Clock.currentTimeMillis
    }),
    session
  );
});

/**
 * Connect an app: each app's steps behind its tab, Claude's unless `?app=` names another, and
 * Claude's for one it doesn't know. With agent access off, who can turn it on instead.
 */
const connectApp = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const asked = new URL(request.url, session.publicBaseUrl).searchParams.get("app");
  const shown: Agent = asked !== null && isAgent(asked) ? asked : "claude";
  const admins = yield* accessAdmins(viewer);
  if (admins !== null)
    return pageResponse(subpage(viewer, "Connect an app", accessOff(viewer, admins)), session);
  const tabs = Object.entries(agents)
    .map(
      ([key, label]) =>
        `<a href="/agents/connect?app=${key}"${key === shown ? ' aria-current="page"' : ""}>${label}</a>`
    )
    .join("");
  const list = steps(
    shown,
    new URL("/mcp", session.publicBaseUrl).href,
    escapeHtml(viewer.company.name)
  )
    .map((step) => `<li><p><strong>${step.title}</strong></p>${step.body}</li>`)
    .join("");
  return pageResponse(
    subpage(
      viewer,
      "Connect an app",
      `<div class="agents-add-body" id="connect-an-agent"><nav class="tabs" aria-label="Agent">${tabs}</nav><ol class="agents-steps">${list}</ol></div>`
    ),
    session
  );
});

/** Add a computer: the setup line the person's agent runs there. */
const addComputer = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const setupLine = `Set up Patchy using ${new URL("/llms.txt", session.publicBaseUrl).href}`;
  return pageResponse(
    subpage(
      viewer,
      "Add a computer",
      `<div class="agents-add-body" id="add-a-computer">${copyLine(setupLine, "Setup line, select to copy", "the setup line")}<p>Your agent installs Patchy, then asks you to confirm in this browser.</p></div>`
    ),
    session
  );
});

/**
 * Disconnect everything's confirmation: what it ends, counted now. Its form carries the account
 * it was shown to, so an answer from a page left open across an account switch ends nothing.
 */
const confirmAll = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const held = yield* holdings(viewer.user.id);
  const ends = ending(held);
  const consequence =
    ends === ""
      ? "No computer or agent is connected, so this ends only approvals not yet collected."
      : `This ends ${ends}, and any approval not yet collected. Each one has to be connected again afterwards.`;
  return pageResponse(
    {
      title: "Disconnect everything?",
      app: { viewer, section: "agents" },
      styles,
      heading: "",
      body: `<article class="agents"><p><a href="/agents">Back to Your agents</a></p><h1 class="page-heading">Disconnect everything?</h1><form class="confirmation-form" method="post" action="/agents/disconnect-all"><input type="hidden" name="user" value="${escapeAttribute(viewer.user.id)}"><p class="confirmation-consequence">${consequence}</p><div class="confirmation-actions"><button class="btn btn-danger" type="submit">Disconnect everything</button><a class="btn btn-quiet" href="/agents">Cancel</a></div></form></article>`
    },
    session
  );
});

const backToMachines = HttpServerResponse.redirect("/agents", {
  status: 303,
  headers: { "cache-control": "private, no-store" }
});

/** Back to Your agents, with a receipt naming what changed when there is a name to give. */
const done = Effect.fn("MachinesPage.done")(function* (text: string | undefined) {
  if (text === undefined) return backToMachines;
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  return Receipt.set(backToMachines, {
    userId: viewer.user.id,
    text,
    publicBaseUrl: session.publicBaseUrl
  });
});

const revoke = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const tokens = yield* MachineTokens.MachineTokens;
  const id = (yield* HttpRouter.params).id ?? "";
  // Its name before it goes; one no longer listed, such as one already revoked, gets no receipt.
  const machine = (yield* tokens.list(viewer.user.id)).find((machine) => machine.id === id);
  yield* tokens.revokeOwned({ id, userId: viewer.user.id });
  return yield* done(machine && `Revoked ${machine.name}`);
});

const disconnectAll = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const user = yield* request.urlParamsBody.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_FORM_BYTES)),
    Effect.option,
    Effect.map(Option.flatMap(UrlParams.getFirst("user")))
  );
  if (Option.getOrUndefined(user) !== viewer.user.id)
    return pageResponse(
      {
        title: "Nothing was disconnected",
        app: { viewer, section: "agents" },
        status: 409,
        body: '<p class="note note-refused" role="alert">You’re signed in as someone else now. Open <a href="/agents">Your agents</a> and try again.</p>'
      },
      session
    );
  const ends = ending(yield* holdings(viewer.user.id));
  // The stamp it records also ends every agent connection and approval not yet collected.
  yield* (yield* MachineTokens.MachineTokens).revokeAll(viewer.user.id);
  return yield* done(ends === "" ? "Disconnected everything" : `Disconnected everything: ${ends}`);
});

const disconnect = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const id = (yield* HttpRouter.params).id ?? "";
  const { clientName } = yield* (yield* AgentConnections.AgentConnections).disconnect({
    id,
    userId: viewer.user.id
  });
  return yield* done(`Disconnected ${clientName}`);
});

type PageError =
  | Effect.Error<
      | typeof machines
      | typeof connectApp
      | typeof addComputer
      | typeof confirmAll
      | typeof revoke
      | typeof disconnectAll
      | typeof disconnect
    >
  | Session.SessionError;

const message = (title: string, body: string, status: number): Page => ({ title, body, status });

const errors = <R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, PageError, R>) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    const reply = (page: Page) => Effect.succeed(pageResponse(page, session));
    return yield* app.pipe(
      Effect.catchTags({
        MachineTokenNotFound: () =>
          reply(
            message(
              "Machine not found",
              '<p>This machine is not on <a href="/agents">Your agents</a>.</p>',
              404
            )
          ),
        AgentConnectionNotFound: () =>
          reply(
            message(
              "Agent not found",
              '<p>This agent is not on <a href="/agents">Your agents</a>.</p>',
              404
            )
          ),
        SqlError: () =>
          reply(message("Machine service unavailable", "<p>Please try again.</p>", 503)),
        SessionError: () =>
          reply(message("Sign-in service unavailable", "<p>Please try again.</p>", 502))
      })
    );
  });

export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      | Session.Session
      | Companies.Companies
      | Users.Users
      | SqlClient.SqlClient
      | MachineTokens.MachineTokens
      | AgentConnections.AgentConnections
    >
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/agents", errors(RequireSession.withViewer(machines)));
    yield* router.add("GET", "/agents/connect", errors(RequireSession.withViewer(connectApp)));
    yield* router.add("GET", "/agents/computer", errors(RequireSession.withViewer(addComputer)));
    yield* router.add(
      "GET",
      "/agents/disconnect-all",
      errors(RequireSession.withViewer(confirmAll))
    );
    yield* router.add(
      "POST",
      "/agents/computers/:id/disconnect",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(revoke)))
    );
    yield* router.add(
      "POST",
      "/agents/disconnect-all",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(disconnectAll)))
    );
    yield* router.add(
      "POST",
      "/agents/apps/:id/disconnect",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(disconnect)))
    );
  })
);
