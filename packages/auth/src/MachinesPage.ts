/**
 * Your machines: how to connect an agent, the person's agent connections and machine tokens,
 * each ended on its own, and Disconnect everything for a lost laptop. The agent tabs are links,
 * so the page runs no script but the shell's copy buttons.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
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
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse, type Page } from "./page.js";

const WEEK_MS = 7 * 86_400_000;

/** The agents with a tab, in tab order; `?agent=` names one, and Claude's opens by default. */
const agents = {
  claude: "Claude",
  "claude-code": "Claude Code",
  codex: "Codex",
  chatgpt: "ChatGPT",
  another: "Another agent"
} as const;
type Agent = keyof typeof agents;
const isAgent = (value: string | null): value is Agent =>
  value !== null && Object.hasOwn(agents, value);

interface Step {
  readonly title: string;
  readonly body: string;
}

const addressLine = (address: string) => copyLine(address, "Patchy’s address, select to copy");
const commandLine = (command: string) => copyLine(command, "Command to run, select to copy");

/**
 * One agent's steps: the first holds what to paste, then the yes in the browser, then a first
 * request. The first step's body is HTML; the others are plain sentences.
 */
const steps = (agent: Agent, address: string, company: string): readonly [Step, Step, Step] => {
  const name = agent === "another" ? "your agent" : agents[agent];
  const allow = `Patchy asks, signed in as you, whether ${name} may act as you. Allow it.`;
  const ask: Step = {
    title: "Ask for something",
    body: `Ask ${name} what it can do at ${company}, or name a patch. It works in the patches you can open, as you.`
  };
  switch (agent) {
    case "claude":
      return [
        {
          title: "Add Patchy as a connector",
          body: `<p>In Claude, open <strong>Settings › Connectors</strong> and choose <strong>Add custom connector</strong>. Name it Patchy and paste:</p>${addressLine(address)}<p class="supporting-text">Works in Claude on the web, the desktop app and your phone: they share connectors.</p>`
        },
        { title: "Say yes in your browser", body: `Choose Connect. ${allow}` },
        ask
      ];
    case "claude-code":
      return [
        {
          title: "Add Patchy to Claude Code",
          body: `<p>In a terminal, run:</p>${commandLine(`claude mcp add --transport http patchy ${address}`)}<p>Then, in Claude Code, run <code>/mcp</code> and choose patchy to sign in.</p>`
        },
        { title: "Say yes in your browser", body: `Your browser opens. ${allow}` },
        ask
      ];
    case "codex":
      return [
        {
          title: "Add Patchy to Codex",
          body: `<p>In a terminal, run:</p>${commandLine(`codex mcp add patchy --url ${address}`)}<p>Then sign in:</p>${commandLine("codex mcp login patchy")}`
        },
        { title: "Say yes in your browser", body: `Your browser opens. ${allow}` },
        ask
      ];
    case "chatgpt":
      return [
        {
          title: "Add Patchy as a connector",
          body: `<p>In ChatGPT, add a custom connector named Patchy with this address:</p>${addressLine(address)}<p class="supporting-text">Only some ChatGPT plans can add custom connectors.</p>`
        },
        { title: "Say yes in your browser", body: `Choose Connect. ${allow}` },
        ask
      ];
    case "another":
      return [
        {
          title: "Give it Patchy’s address",
          body: `<p>Add Patchy to your agent as an MCP server with this address:</p>${addressLine(address)}<p class="supporting-text">Some agents, such as Cursor and Gemini CLI, can’t connect yet.</p>`
        },
        { title: "Say yes in your browser", body: `When your agent signs in, ${allow}` },
        ask
      ];
  }
};

/** Everything the page shows, gathered for one viewer. */
interface View {
  readonly viewer: RequireSession.Viewer["Service"];
  readonly agent: Agent;
  readonly address: string;
  /** `null` while agent access is on; otherwise the admins who can turn it on, by name. */
  readonly admins: ReadonlyArray<string> | null;
  readonly connections: ReadonlyArray<AgentConnections.Listed>;
  readonly machines: Effect.Success<ReturnType<MachineTokens.MachineTokens["Service"]["list"]>>;
  readonly now: number;
}

const date = (iso: string) =>
  `<time datetime="${escapeAttribute(iso)}">${escapeHtml(dateLabel(iso))}</time>`;
const lastUsed = (iso: string, now: number) =>
  `<time datetime="${escapeAttribute(iso)}" title="${escapeAttribute(dateLabel(iso))}">${escapeHtml(ago(iso, now))}</time>`;

const connectSection = ({ viewer, agent, address, admins }: View) => {
  const company = escapeHtml(viewer.company.name);
  const heading = '<h2 class="section-heading" id="connect-an-agent-heading">Connect an agent</h2>';
  if (admins !== null) {
    const off =
      viewer.role === "admin"
        ? `No agent can connect until it’s turned on for everyone at ${company}.<div class="actions"><a class="btn" href="/company#agent-access">Turn it on at Company</a></div>`
        : `Agents can’t connect until an admin turns it on. At ${company} that’s ${sentenceList(admins)}.`;
    return `<section class="section" id="connect-an-agent" aria-labelledby="connect-an-agent-heading">${heading}<div class="note note-warn"><strong class="note-title">Agent access is off at ${company}</strong>${off}</div></section>`;
  }
  const tabs = Object.entries(agents)
    .map(
      ([key, label]) =>
        `<a href="/machines?agent=${key}#connect-an-agent"${key === agent ? ' aria-current="page"' : ""}>${label}</a>`
    )
    .join("");
  const [first, ...rest] = steps(agent, address, company);
  const later = rest
    .map(
      (step, index) =>
        `<li class="step"><span class="step-marker" aria-hidden="true">${index + 2}</span><div><h3 class="step-title">${step.title}</h3><p class="supporting-text">${step.body}</p></div></li>`
    )
    .join("");
  return `<section class="section" id="connect-an-agent" aria-labelledby="connect-an-agent-heading">${heading}<p>Your agent can use ${company}’s patches as you, through the agent tools their builders added. Which one do you use?</p><nav class="tabs" aria-label="Agent">${tabs}</nav><ol class="steps"><li class="step step-current" aria-current="step"><span class="step-marker" aria-hidden="true">1</span><div><h3 class="step-title">${first.title}</h3><div class="step-card">${first.body}</div></div></li>${later}</ol><script defer src="${copyScriptPath}"></script></section>`;
};

/** A connection unused for a week says when it ends, and that a reconnect leaves it behind. */
const connectionRow = (connection: AgentConnections.Listed, now: number) => {
  const name = escapeHtml(connection.clientName);
  const used = connection.lastUsedAt ?? connection.connectedAt;
  const leftover =
    now - Date.parse(used) >= WEEK_MS
      ? `<p class="supporting-text">Not used since ${date(used)}. If you reconnected ${name} since, this is the old one; it ends on its own on ${date(connection.endsAt)}.</p>`
      : "";
  return `<li class="list-row"><h3 class="section-heading">${name} <span class="tag">${escapeHtml(connection.clientSite)}</span></h3><dl class="facts"><dt>Connected</dt><dd>${date(connection.connectedAt)}</dd><dt>Last used</dt><dd>${connection.lastUsedAt === null ? "Not yet" : lastUsed(connection.lastUsedAt, now)}</dd></dl>${leftover}<form class="actions" method="post" action="/machines/agents/${encodeURIComponent(connection.id)}/disconnect"><button class="btn btn-danger" type="submit" aria-label="${escapeAttribute(`Disconnect ${connection.clientName}, connected ${dateLabel(connection.connectedAt)}`)}">Disconnect</button></form></li>`;
};

const machineRow = (machine: View["machines"][number], now: number) =>
  `<li class="list-row"><h3 class="section-heading">${escapeHtml(machine.name)}</h3><dl class="facts"><dt>Logged in</dt><dd>${date(machine.createdAt)}</dd><dt>Last used</dt><dd>${lastUsed(machine.lastUsedAt, now)}</dd><dt>Expires</dt><dd>${date(machine.expiresAt)}, or after 30 days unused</dd></dl><form class="actions" method="post" action="/machines/${encodeURIComponent(machine.id)}/revoke"><button class="btn btn-danger" type="submit" aria-label="Revoke ${escapeAttribute(machine.name)}">Revoke</button></form></li>`;

const render = (view: View): Page => {
  const { viewer, connections, machines, now } = view;
  const company = escapeHtml(viewer.company.name);
  return {
    title: "Your machines",
    app: { viewer, section: "agents" },
    body: `<p>Machines publishing and agents using patches at <strong>${company}</strong> as <span class="auth-email">${escapeHtml(viewer.user.email)}</span>.</p>${connectSection(view)}<section class="section" aria-labelledby="agents-heading"><h2 class="section-heading" id="agents-heading">Agents</h2><p class="supporting-text">Agents using ${company}’s patches as you, through Patchy’s MCP. A disconnected agent can’t be brought back: connecting it again makes a new connection.</p>${connections.length === 0 ? "<p>No agents are connected.</p>" : `<ul class="list">${connections.map((connection) => connectionRow(connection, now)).join("")}</ul>`}</section><section class="section" aria-labelledby="machines-heading"><h2 class="section-heading" id="machines-heading">Machines</h2><p class="supporting-text">Computers publishing as you with <code>patchy</code>.</p>${machines.length === 0 ? "<p>No machines are logged in.</p>" : `<ul class="list">${machines.map((machine) => machineRow(machine, now)).join("")}</ul>`}</section><section class="section" aria-labelledby="lost-heading"><h2 class="section-heading" id="lost-heading">Lost a laptop?</h2><p>Disconnect everything ends every agent and machine above, and any approval not yet collected. Connect each one again afterwards.</p><form class="actions" method="post" action="/machines/revoke-all"><button class="btn btn-danger" type="submit">Disconnect everything</button></form></section>`
  };
};

const machines = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(request.url, session.publicBaseUrl);
  const asked = url.searchParams.get("agent");
  // The viewer's own company: it exists for as long as they can open this page.
  const access = yield* (yield* Companies.Companies)
    .agentAccess(viewer.company.id)
    .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
  const admins = access.on
    ? null
    : (yield* (yield* Users.Users).list(viewer.company.id))
        .filter((user) => user.role === "admin" && user.deactivatedAt === null)
        .map((user) => user.name.trim() || user.email)
        .sort((a, b) => a.localeCompare(b));
  return pageResponse(
    render({
      viewer,
      agent: isAgent(asked) ? asked : "claude",
      address: new URL("/mcp", session.publicBaseUrl).href,
      admins,
      connections: yield* (yield* AgentConnections.AgentConnections).list(viewer.user.id),
      machines: yield* (yield* MachineTokens.MachineTokens).list(viewer.user.id),
      now: yield* Clock.currentTimeMillis
    }),
    session
  );
});

const backToMachines = HttpServerResponse.redirect("/machines", {
  status: 303,
  headers: { "cache-control": "private, no-store" }
});

const revoke = Effect.fn("MachinesPage.revoke")(function* (all: boolean) {
  const viewer = yield* RequireSession.Viewer;
  const tokens = yield* MachineTokens.MachineTokens;
  // Disconnect everything: the stamp it records also ends every agent connection and approval.
  if (all) yield* tokens.revokeAll(viewer.user.id);
  else {
    const params = yield* HttpRouter.params;
    yield* tokens.revokeOwned({ id: params.id ?? "", userId: viewer.user.id });
  }
  return backToMachines;
});

const disconnect = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const params = yield* HttpRouter.params;
  yield* (yield* AgentConnections.AgentConnections).disconnect({
    id: params.id ?? "",
    userId: viewer.user.id
  });
  return backToMachines;
});

type PageError =
  | Effect.Error<typeof machines | typeof disconnect | ReturnType<typeof revoke>>
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
              '<p>This machine is not on <a href="/machines">Your machines</a>.</p>',
              404
            )
          ),
        AgentConnectionNotFound: () =>
          reply(
            message(
              "Agent not found",
              '<p>This agent is not on <a href="/machines">Your machines</a>.</p>',
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
    yield* router.add("GET", "/machines", errors(RequireSession.withViewer(machines)));
    yield* router.add(
      "POST",
      "/machines/:id/revoke",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(revoke(false))))
    );
    yield* router.add(
      "POST",
      "/machines/revoke-all",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(revoke(true))))
    );
    yield* router.add(
      "POST",
      "/machines/agents/:id/disconnect",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(disconnect)))
    );
  })
);
