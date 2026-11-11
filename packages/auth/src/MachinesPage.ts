/**
 * Your agents at `/agents`: what acts as the person, records first. Use patches lists their
 * agent connections, the apps that use patches as them; Build patches lists their machine tokens,
 * the computers that publish as them. Each row says when it was last used, and a status only when
 * there is one: Expires soon, or Access ended for one that ended on its own in the last 30 days.
 * A live row's ⋯ holds Disconnect…, a dialog at the row's own `…/disconnect` that names what
 * stops; an ended row's holds Reconnect. The header says whether agent access is on at the company.
 *
 * Connect an app (`/agents/connect`, `?app=` picks the app) and Add a computer
 * (`/agents/computer`) are flows; Disconnect everything is a dialog at `/agents/disconnect-all`.
 * The links to the flows keep the ids old `/machines#add-a-computer` and `#connect-an-agent`
 * links name. Every dialog is a URL drawn over its page, and everything works without script but
 * the copy buttons. A missing computer or app, and a store that can't answer, say so inside the
 * app.
 */
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as UrlParams from "effect/http/UrlParams";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { Companies, Users } from "@patchy/companies";
import {
  ago,
  badge,
  button,
  canList,
  card,
  choiceLinks,
  computerMark,
  copyLine,
  copyScriptPath,
  dateLabel,
  dialog,
  dot,
  emptyState,
  escapeAttribute,
  escapeHtml,
  flowOutcome,
  flowPage,
  type FlowSection,
  idFor,
  linkButton,
  menu,
  notice,
  productMark,
  type ProductMark,
  row,
  rows,
  section,
  sentenceList,
  settingRow,
  settingsPage
} from "@patchy/core";
import * as AgentConnections from "./AgentConnections.js";
import { getAnAgent } from "./getAnAgent.js";
import * as MachineTokens from "./MachineTokens.js";
import * as Receipt from "./Receipt.js";
import * as RequireSession from "./RequireSession.js";
import * as Session from "./Session.js";
import { pageResponse } from "./page.js";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** Disconnect everything's form carries one id. */
const MAX_FORM_BYTES = 1_024;

/**
 * The apps Connect an app offers, in its order, each in its maker's logo; `?app=` names one, and
 * Claude's opens by default.
 */
const apps = {
  claude: { label: "Claude", mark: { logo: "claude" } },
  chatgpt: { label: "ChatGPT", mark: { logo: "openai" } },
  "claude-code": { label: "Claude Code", mark: { logo: "claude" } },
  codex: { label: "Codex", mark: { logo: "openai" } },
  cursor: { label: "Cursor", mark: { logo: "cursor" } },
  another: { label: "Another agent", mark: "+" }
} as const satisfies Record<string, { readonly label: string; readonly mark: ProductMark }>;
type App = keyof typeof apps;
const isApp = (value: string): value is App => Object.hasOwn(apps, value);

/** A name as `appNamed` compares it: lowercase letters and digits, so "Claude-Code" is "claudecode". */
const squashed = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** The apps a client's name can match, the longest name first, so Claude Code's wins over Claude's. */
const named = Object.keys(apps)
  .filter(isApp)
  .filter((key) => key !== "another")
  .sort((a, b) => squashed(apps[b].label).length - squashed(apps[a].label).length);

/**
 * The app a connection's client calls itself, or `another` for one Connect an app doesn't name.
 * Clients name themselves loosely, so a name holding an app's, whatever its case, spaces and
 * punctuation, is that app: "Claude Desktop" is Claude, "cursor-vscode" Cursor, "OpenAI Codex" Codex.
 */
export const appNamed = (name: string): App => {
  const said = squashed(name);
  return named.find((key) => said.includes(squashed(apps[key].label))) ?? "another";
};

/** A connection's mark: its app's, or its own initial for an app Patchy doesn't name. */
const appMark = (name: string) => {
  const app = appNamed(name);
  return productMark(
    app === "another" ? (Array.from(name.trim())[0]?.toUpperCase() ?? "?") : apps[app].mark
  );
};

/** Where Reconnect sets up again an app whose access ended: Connect an app, its app chosen. */
const reconnectApp = (clientName: string) => `/agents/connect?app=${appNamed(clientName)}`;
/** Where Reconnect sets up again a computer whose access ended. */
const reconnectComputer = "/agents/computer";

/** An app or computer whose access ended on its own, and where Reconnect sets it up again. */
export interface EndedAccess {
  readonly kind: "app" | "computer";
  /** Its mark, as Your agents draws it: trusted HTML. */
  readonly mark: string;
  readonly name: string;
  readonly endedAt: string;
  readonly reconnect: string;
}

/**
 * The person's own apps and computers that ended on their own in the last 30 days, the rows Your
 * agents marks Access ended, apps first: Home's Needs attention offers Reconnect on each.
 */
export const endedAccess = Effect.fn("MachinesPage.endedAccess")(function* (userId: string) {
  const apps = yield* (yield* AgentConnections.AgentConnections).ended(userId);
  const computers = yield* (yield* MachineTokens.MachineTokens).ended(userId);
  return [
    ...apps.map((app): EndedAccess => ({
      kind: "app",
      mark: appMark(app.clientName),
      name: app.clientName,
      endedAt: app.endedAt,
      reconnect: reconnectApp(app.clientName)
    })),
    ...computers.map((computer): EndedAccess => ({
      kind: "computer",
      mark: computerMark,
      name: computer.name,
      endedAt: computer.endedAt,
      reconnect: reconnectComputer
    }))
  ];
});

type Viewer = RequireSession.Viewer["Service"];

/** The admins who can turn agent access on, by name, or `null` while it is on. */
const accessAdmins = Effect.fn("MachinesPage.accessAdmins")(function* (viewer: Viewer) {
  // The viewer's own company: it exists for as long as they can open this page.
  const access = yield* (yield* Companies.Companies)
    .agentAccess(viewer.company.id)
    .pipe(Effect.catchTags({ CompanyNotFound: Effect.die }));
  if (access.on) return null;
  return (yield* (yield* Users.Users).list(viewer.company.id))
    .filter((user) => user.role === "super_admin" && user.deactivatedAt === null)
    .map((user) => user.name.trim() || user.email)
    .sort((a, b) => a.localeCompare(b));
});

/** Everything Your agents shows, gathered for one viewer. */
const gather = Effect.fn("MachinesPage.gather")(function* (viewer: Viewer) {
  const tokens = yield* MachineTokens.MachineTokens;
  const connections = yield* AgentConnections.AgentConnections;
  return {
    viewer,
    admins: yield* accessAdmins(viewer),
    machines: yield* tokens.list(viewer.user.id),
    endedMachines: yield* tokens.ended(viewer.user.id),
    connections: yield* connections.list(viewer.user.id),
    endedConnections: yield* connections.ended(viewer.user.id),
    now: yield* Clock.currentTimeMillis
  };
});
type View = Effect.Success<ReturnType<typeof gather>>;

/** "2 apps and 1 computer": what Disconnect everything ends, without a kind there are none of. */
const ending = ({ connections, machines }: Pick<View, "connections" | "machines">) =>
  [[connections.length, "app"] as const, [machines.length, "computer"] as const]
    .flatMap(([count, noun]) => (count === 0 ? [] : [`${count} ${noun}${count === 1 ? "" : "s"}`]))
    .join(" and ");

/** Who can turn agent access on, in place of a way to connect an app while it is off. */
const accessOff = (viewer: Viewer, admins: ReadonlyArray<string>) =>
  notice({
    tone: "warning",
    title: `Agent access is off at ${viewer.company.name}`,
    body: `<p>${admins.length === 0 ? "A super admin" : sentenceList(admins)} can turn it on.</p>`,
    action:
      viewer.role === "super_admin"
        ? linkButton("Turn it on", "/settings/agent-access", { size: "sm" })
        : undefined
  });

/** The header's status line: whether agent access is on, and who can change it. */
const accessLine = ({ viewer, admins }: View) => {
  const company = viewer.company.name;
  const admin = viewer.role === "super_admin";
  return admins === null
    ? [
        dot(`Agent access is on at ${company}`, "success"),
        ...(admin ? ['<a href="/settings/agent-access">Change</a>'] : [])
      ]
    : [
        dot(`Agent access is off at ${company}`, "warning"),
        admin
          ? '<a href="/settings/agent-access">Turn it on</a>'
          : `${admins.length === 0 ? "A super admin" : sentenceList(admins)} can turn it on`
      ];
};

const disconnectComputer = (id: string) => `/agents/computers/${encodeURIComponent(id)}/disconnect`;
const disconnectApp = (id: string) => `/agents/apps/${encodeURIComponent(id)}/disconnect`;

/** A computer's key ends at its 90 days or 30 days after its last use, whichever is first. */
const computerRow = (machine: View["machines"][number], now: number) => {
  const idle = Date.parse(machine.lastUsedAt) + 30 * DAY_MS;
  const idleFirst = idle <= Date.parse(machine.expiresAt);
  const end = idleFirst ? DateTime.formatIso(DateTime.makeUnsafe(idle)) : machine.expiresAt;
  return row({
    lead: computerMark,
    name: machine.name,
    description: `Used ${ago(machine.lastUsedAt, now)} · expires ${dateLabel(end)}${idleFirst ? " unless used" : ""}`,
    end: `${Date.parse(end) - now < WEEK_MS ? badge("Expires soon", "warning") : ""}${menu({
      id: idFor("computer", machine.id),
      label: machine.name,
      items: [
        { kind: "link", label: "Disconnect…", href: disconnectComputer(machine.id), danger: true }
      ]
    })}`
  });
};

/**
 * A connection ends 30 days after its last call. One unused for a week says when, and its menu
 * names the day it connected, since a reconnect lists two of the same name.
 */
const appRow = (connection: AgentConnections.Listed, now: number) => {
  const used = connection.lastUsedAt ?? connection.connectedAt;
  const connected = `connected ${dateLabel(connection.connectedAt)}`;
  return row({
    lead: appMark(connection.clientName),
    name: connection.clientName,
    description: [
      connection.clientSite,
      connected,
      connection.lastUsedAt === null
        ? "no calls yet"
        : `last call ${ago(connection.lastUsedAt, now)}`,
      ...(now - Date.parse(used) >= WEEK_MS
        ? [`expires ${dateLabel(connection.endsAt)} unless used`]
        : [])
    ].join(" · "),
    end: `${Date.parse(connection.endsAt) - now < WEEK_MS ? badge("Expires soon", "warning") : ""}${menu(
      {
        id: idFor("app", connection.id),
        label: `${connection.clientName}, ${connected}`,
        items: [
          { kind: "link", label: "Disconnect…", href: disconnectApp(connection.id), danger: true }
        ]
      }
    )}`
  });
};

/**
 * A row whose access ended on its own: when, and in its menu Reconnect, which sets it up again.
 * `id` is its record's, for the menu's.
 */
const endedRow = (spec: {
  readonly id: string;
  readonly lead: string;
  readonly name: string;
  readonly description: ReadonlyArray<string>;
  readonly reconnect: string;
}) =>
  row({
    lead: spec.lead,
    name: spec.name,
    description: spec.description.join(" · "),
    end: `${badge("Access ended", "danger")}${menu({
      id: idFor("ended", spec.id),
      label: spec.name,
      items: [{ kind: "link", label: "Reconnect", href: spec.reconnect }]
    })}`
  });

const useSection = (view: View) => {
  const on = view.admins === null;
  const connect = linkButton("Connect an app", "/agents/connect", { icon: "plus", size: "sm" });
  const listed = [
    ...view.connections.map((connection) => appRow(connection, view.now)),
    ...view.endedConnections.map((connection) =>
      endedRow({
        id: connection.id,
        lead: appMark(connection.clientName),
        name: connection.clientName,
        description: [
          connection.clientSite,
          connection.lastUsedAt === null
            ? `connected ${dateLabel(connection.connectedAt)}`
            : `last call ${ago(connection.lastUsedAt, view.now)}`,
          `ended ${dateLabel(connection.endedAt)}`
        ],
        reconnect: reconnectApp(connection.clientName)
      })
    )
  ];
  return section({
    title: "Use patches",
    description: "Apps that use the agent tools in patches, as you",
    // With agent access off there's no way to connect one; the section keeps the old link's id.
    ...(on
      ? {
          action: linkButton("Connect an app", "/agents/connect", {
            icon: "plus",
            size: "sm",
            id: "connect-an-agent"
          })
        }
      : { id: "connect-an-agent" }),
    body: rows(
      listed.length > 0
        ? listed
        : [
            on
              ? emptyState({
                  title: "No app uses patches as you yet",
                  body: "Connect Claude, ChatGPT or another agent to use patches’ agent tools.",
                  action: connect
                })
              : emptyState({ title: "No app uses patches as you yet" })
          ],
      true
    )
  });
};

const buildSection = (view: View) => {
  const add = linkButton("Add a computer", "/agents/computer", { icon: "plus", size: "sm" });
  const listed = [
    ...view.machines.map((machine) => computerRow(machine, view.now)),
    ...view.endedMachines.map((machine) =>
      endedRow({
        id: machine.id,
        lead: computerMark,
        name: machine.name,
        description: [
          `Used ${ago(machine.lastUsedAt, view.now)}`,
          `ended ${dateLabel(machine.endedAt)}`
        ],
        reconnect: reconnectComputer
      })
    )
  ];
  return section({
    title: "Build patches",
    description: "Computers whose agent publishes as you",
    action: linkButton("Add a computer", "/agents/computer", {
      icon: "plus",
      size: "sm",
      id: "add-a-computer"
    }),
    body: rows(
      listed.length > 0
        ? listed
        : [
            emptyState({
              title: "No computer builds as you yet",
              body: "Give your agent one line and it can build and publish patches.",
              action: add
            })
          ],
      true
    )
  });
};

/**
 * Your agents, with `refusal` above its sections when a form was refused. Disconnect everything
 * stays with nothing listed: it also cancels an approval not yet collected.
 */
const index = (view: View, refusal = "") =>
  settingsPage({
    title: "Your agents",
    meta: accessLine(view),
    cards: [refusal, useSection(view), buildSection(view)],
    danger: card({
      danger: true,
      rows: [
        settingRow({
          title: "Disconnect everything",
          description:
            "Ends every app and computer acting as you, and any approval not yet collected. Use it if a laptop goes missing.",
          control: linkButton("Disconnect everything…", "/agents/disconnect-all", {
            kind: "danger",
            size: "sm"
          })
        })
      ]
    })
  });

/** What Your agents shows over or above its sections, drawn from what it lists. */
interface Shown {
  /** The page's `<title>` heading, for a dialog. */
  readonly title?: string;
  readonly overlay?: string;
  readonly refusal?: string;
  readonly status?: number;
}

/** Your agents for the viewer, with what `show` puts over or above it. */
const agents = Effect.fn("MachinesPage.agents")(function* (
  show: (view: View) => Shown = () => ({})
) {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const view = yield* gather(viewer);
  const shown = show(view);
  return pageResponse(
    {
      title: shown.title ?? "Your agents",
      status: shown.status,
      app: { viewer, section: "agents", overlay: shown.overlay },
      ...index(view, shown.refusal)
    },
    session
  );
});

/** A refusal to disconnect: a missing computer or app answers as another person's does. */
const gone = (noun: "computer" | "app") =>
  notice({ tone: "warning", title: `That ${noun} isn’t on Your agents` });

/** A Disconnect dialog over Your agents: what stops, Cancel first, then the act it names. */
const disconnectDialog = (spec: {
  readonly id: string;
  readonly title: string;
  readonly action: string;
  /** Trusted HTML. */
  readonly consequence: string;
  readonly confirm: string;
  readonly fields?: string;
  /** A notice above the consequence, when an answer was refused and the dialog is drawn again. */
  readonly refusal?: string;
}) =>
  dialog({
    id: spec.id,
    title: spec.title,
    closeHref: "/agents",
    form: { action: spec.action, fields: spec.fields },
    body: `${spec.refusal ?? ""}<p class="prose">${spec.consequence}</p>`,
    foot: `${linkButton("Cancel", "/agents", { kind: "quiet", autofocus: true })}${button(spec.confirm, { kind: "danger-solid" })}`
  });

const confirmComputer = Effect.gen(function* () {
  const id = (yield* HttpRouter.params).id ?? "";
  return yield* agents((view): Shown => {
    const machine = view.machines.find((candidate) => candidate.id === id);
    return machine === undefined
      ? { refusal: gone("computer"), status: 404 }
      : {
          title: `Disconnect ${machine.name}`,
          overlay: disconnectDialog({
            id: "disconnect",
            title: `Disconnect ${machine.name}?`,
            action: disconnectComputer(machine.id),
            consequence: `The agents on ${escapeHtml(machine.name)} stop building and publishing patches as you now. Add it again to use it.`,
            confirm: "Disconnect"
          })
        };
  });
});

const confirmApp = Effect.gen(function* () {
  const id = (yield* HttpRouter.params).id ?? "";
  return yield* agents((view): Shown => {
    const connection = view.connections.find((candidate) => candidate.id === id);
    return connection === undefined
      ? { refusal: gone("app"), status: 404 }
      : {
          title: `Disconnect ${connection.clientName}`,
          overlay: disconnectDialog({
            id: "disconnect",
            title: `Disconnect ${connection.clientName}?`,
            action: disconnectApp(connection.id),
            consequence: `${escapeHtml(connection.clientName)}, connected ${escapeHtml(dateLabel(connection.connectedAt))}, stops using patches as you now. Connect it again to use it.`,
            confirm: "Disconnect"
          })
        };
  });
});

/**
 * Disconnect everything's dialog: what it ends, counted now. Its form carries the account it was
 * shown to, so an answer from a page left open across an account switch ends nothing; that answer
 * draws the dialog again for the account signed in now, with `refusal` saying so.
 */
const disconnectAllDialog = (view: View, refusal?: string) => {
  const ends = ending(view);
  return disconnectDialog({
    id: "disconnect-all",
    title: "Disconnect everything?",
    action: "/agents/disconnect-all",
    fields: `<input type="hidden" name="user" value="${escapeAttribute(view.viewer.user.id)}">`,
    consequence:
      ends === ""
        ? "No app or computer is connected, so this ends only approvals not yet collected. You stay signed in here."
        : `This ends ${ends}, and any approval not yet collected. You stay signed in here. Set each one up again when you need it.`,
    confirm: "Disconnect everything",
    refusal
  });
};

const confirmAll = agents((view): Shown => ({
  title: "Disconnect everything",
  overlay: disconnectAllDialog(view)
}));

const parent = { label: "Your agents", href: "/agents" };
const done = linkButton("Done", "/agents");

const addressLine = (address: string) =>
  copyLine(address, "Patchy’s address, select to copy", "Patchy’s address");
const commandLine = (command: string, target: string) =>
  copyLine(command, "Command to run, select to copy", target);

/** The last step for every app that connects: Patchy's consent page, in the browser. */
const sayYes = (opens: string, name: string): FlowSection => ({
  title: "Say yes in your browser",
  body: `<p>${opens} Patchy to ask whether ${name} may act as you. Choose <strong>Allow</strong>, and it shows up on Your agents.</p>`
});

/**
 * One app's steps after choosing it, the first keeping the id an old
 * `/machines?agent=…#connect-an-agent` link names. `connects` is false for one that can't yet.
 */
const steps = (
  app: App,
  address: string
): { readonly sections: ReadonlyArray<FlowSection>; readonly connects: boolean } => {
  const id = "connect-an-agent";
  const connector = `<p>Add a custom connector named <strong>Patchy</strong> with this address.</p>${addressLine(address)}`;
  switch (app) {
    case "claude":
      return {
        connects: true,
        sections: [
          {
            id,
            title: "In Claude",
            body: `${connector}<p class="meta">One connector works in Claude on the web, the desktop app and your phone.</p>`
          },
          sayYes("Claude opens", "it")
        ]
      };
    case "chatgpt":
      return {
        connects: true,
        sections: [
          {
            id,
            title: "In ChatGPT",
            body: `${connector}<p class="meta">Only some ChatGPT plans can add custom connectors.</p>`
          },
          sayYes("ChatGPT opens", "it")
        ]
      };
    case "claude-code":
      return {
        connects: true,
        sections: [
          {
            id,
            title: "In a terminal",
            body: `<p>Run:</p>${commandLine(`claude mcp add --transport http patchy ${address}`, "the command")}<p>Then, in Claude Code, run <code>/mcp</code> and choose patchy to sign in.</p>`
          },
          sayYes("Your browser opens", "Claude Code")
        ]
      };
    case "codex":
      return {
        connects: true,
        sections: [
          {
            id,
            title: "In a terminal",
            body: `<p>Run:</p>${commandLine(`codex mcp add patchy --url ${address}`, "the add command")}<p>Then sign in:</p>${commandLine("codex mcp login patchy", "the sign-in command")}`
          },
          sayYes("Your browser opens", "Codex")
        ]
      };
    case "cursor":
      // Cursor still signs in to MCP servers by registering itself, which Patchy doesn't offer.
      return {
        connects: false,
        sections: [
          {
            id,
            title: "In Cursor",
            body: notice({
              tone: "info",
              title: "Cursor can’t connect yet",
              body: "<p>It signs in to MCP servers in a way Patchy doesn’t offer yet.</p>"
            })
          }
        ]
      };
    case "another":
      return {
        connects: true,
        sections: [
          {
            id,
            title: "In your agent",
            body: `<p>Add Patchy as an MCP server with this address.</p>${addressLine(address)}<p class="meta">Some agents, such as Cursor and Gemini CLI, can’t connect yet.</p>`
          },
          sayYes("Your agent opens", "it")
        ]
      };
  }
};

/** What an app can and can't do once connected, the block that closes every connect flow. */
const onceConnected = (app: App) => {
  const name = app === "another" ? "Your agent" : apps[app].label;
  const via = app === "another" ? "your agent" : apps[app].label;
  return flowOutcome({
    title: "Once connected",
    body: canList([
      { can: true, text: `${name} uses the agent tools in patches you can open, as you` },
      { can: true, text: `Every change it makes is logged under your name, via ${via}` },
      { can: false, text: "It can’t open patches you can’t" },
      { can: false, text: "It can’t publish or change a patch’s code" }
    ])
  });
};

/**
 * Connect an app: choose the app, then only its steps, Claude's unless `?app=` names another
 * and for one it doesn't know. With agent access off, who can turn it on instead.
 */
const connectApp = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const asked = new URL(request.url, session.publicBaseUrl).searchParams.get("app");
  const shown: App = asked !== null && isApp(asked) ? asked : "claude";
  const admins = yield* accessAdmins(viewer);
  const flow =
    admins === null
      ? (() => {
          const chosen = steps(shown, new URL("/mcp", session.publicBaseUrl).href);
          return flowPage({
            parent,
            title: "Connect an app",
            sections: [
              {
                title: "Choose your app",
                body: choiceLinks({
                  label: "App",
                  current: apps[shown].label,
                  items: Object.keys(apps)
                    .filter(isApp)
                    .map((key) => ({
                      label: apps[key].label,
                      href: `/agents/connect?app=${key}`,
                      mark: productMark(apps[key].mark, { dashed: key === "another" }),
                      dashed: key === "another"
                    }))
                })
              },
              ...chosen.sections
            ],
            outcome: chosen.connects ? onceConnected(shown) : undefined,
            submit: done
          });
        })()
      : flowPage({
          parent,
          title: "Connect an app",
          sections: [],
          outcome: section({ id: "connect-an-agent", body: accessOff(viewer, admins) }),
          submit: done
        });
  return pageResponse(
    {
      title: "Connect an app",
      app: { viewer, section: "agents" },
      heading: flow.heading,
      body: `${flow.body}<script defer src="${copyScriptPath}"></script>`
    },
    session
  );
});

/** Get an agent, over Add a computer: the common agents and where to get them. */
const getAnAgentDialog = dialog({
  id: "get-an-agent",
  title: "Get an agent",
  closeHref: "/agents/computer",
  size: "lg",
  body: getAnAgent,
  foot: linkButton("Back to setup", "/agents/computer")
});

/**
 * Add a computer: the setup line the person's agent runs there, then the code it asks them to
 * confirm here. Nothing here follows the agent, so no step is marked done. `noAgent` draws Get an
 * agent over it.
 */
const addComputer = (noAgent: boolean) =>
  Effect.gen(function* () {
    const viewer = yield* RequireSession.Viewer;
    const session = yield* Session.Session;
    const setupLine = `Set up Patchy using ${new URL("/llms.txt", session.publicBaseUrl).href}`;
    const flow = flowPage({
      parent,
      title: "Add a computer",
      sections: [
        {
          id: "add-a-computer",
          title: "Give your agent this line",
          body: `${copyLine(setupLine, "Setup line, select to copy", "the setup line")}<p class="meta">Works in Claude Code, Codex, Cursor or any agent that runs commands on your computer. <a href="/agents/computer/no-agent">No agent yet?</a></p>`
        },
        {
          title: "Confirm it’s you",
          body: "<p>Your agent opens a page here with a code. Check it matches, then Confirm.</p>"
        }
      ],
      outcome: flowOutcome({
        title: "Once connected",
        body: canList([
          { can: true, text: "Your agent builds and publishes patches as you" },
          { can: true, text: "It reads your company’s integrations while it builds, as you" },
          { can: false, text: "It can’t do what you can’t" },
          {
            can: false,
            text: "It stops after 30 days unused, 90 days at most, or when you disconnect it"
          }
        ])
      }),
      submit: done
    });
    return pageResponse(
      {
        title: noAgent ? "Get an agent" : "Add a computer",
        app: { viewer, section: "agents", overlay: noAgent ? getAnAgentDialog : undefined },
        heading: flow.heading,
        body: `${flow.body}<script defer src="${copyScriptPath}"></script>`
      },
      session
    );
  });

const backToAgents = HttpServerResponse.redirect("/agents", {
  status: 303,
  headers: { "cache-control": "private, no-store" }
});

/** Back to Your agents, with a receipt naming what changed when there is a name to give. */
const finished = Effect.fn("MachinesPage.finished")(function* (text: string | undefined) {
  if (text === undefined) return backToAgents;
  const viewer = yield* RequireSession.Viewer;
  const session = yield* Session.Session;
  return Receipt.set(backToAgents, {
    userId: viewer.user.id,
    text,
    publicBaseUrl: session.publicBaseUrl
  });
});

const revoke = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const tokens = yield* MachineTokens.MachineTokens;
  const id = (yield* HttpRouter.params).id ?? "";
  // Its name before it goes; one no longer listed, such as one already disconnected, gets no receipt.
  const machine = (yield* tokens.list(viewer.user.id)).find((machine) => machine.id === id);
  yield* tokens.revokeOwned({ id, userId: viewer.user.id });
  return yield* finished(machine && `Disconnected ${machine.name}`);
});

const disconnectAll = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const user = yield* request.urlParamsBody.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_FORM_BYTES)),
    Effect.option,
    Effect.map(Option.flatMap(UrlParams.getFirst("user")))
  );
  if (Option.getOrUndefined(user) !== viewer.user.id)
    return yield* agents((view): Shown => ({
      title: "Disconnect everything",
      overlay: disconnectAllDialog(
        view,
        notice({
          tone: "danger",
          title: "Nothing was disconnected",
          body: "<p>You’re signed in as someone else now. This is what the account signed in now would end.</p>"
        })
      ),
      status: 409
    }));
  const ends = ending({
    machines: yield* (yield* MachineTokens.MachineTokens).list(viewer.user.id),
    connections: yield* (yield* AgentConnections.AgentConnections).list(viewer.user.id)
  });
  // The stamp it records also ends every agent connection and approval not yet collected.
  yield* (yield* MachineTokens.MachineTokens).revokeAll(viewer.user.id);
  return yield* finished(
    ends === "" ? "Disconnected everything" : `Disconnected everything: ${ends}`
  );
});

const disconnect = Effect.gen(function* () {
  const viewer = yield* RequireSession.Viewer;
  const id = (yield* HttpRouter.params).id ?? "";
  const { clientName } = yield* (yield* AgentConnections.AgentConnections).disconnect({
    id,
    userId: viewer.user.id
  });
  return yield* finished(`Disconnected ${clientName}`);
});

/**
 * Failures once the viewer is known, inside the app: a computer or app that isn't theirs, or
 * isn't there, answers the same refusal over their own list; a store that can't answer says so.
 */
const inApp = <R>(
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    MachineTokens.MachineTokenNotFound | AgentConnections.AgentConnectionNotFound | SqlError,
    R
  >
) =>
  app.pipe(
    Effect.catchTags({
      MachineTokenNotFound: () => agents((): Shown => ({ refusal: gone("computer"), status: 404 })),
      AgentConnectionNotFound: () => agents((): Shown => ({ refusal: gone("app"), status: 404 }))
    }),
    Effect.catchTags({
      SqlError: () =>
        Effect.gen(function* () {
          const viewer = yield* RequireSession.Viewer;
          const session = yield* Session.Session;
          return pageResponse(
            {
              title: "Your agents",
              status: 503,
              app: { viewer, section: "agents" },
              ...settingsPage({
                title: "Your agents",
                cards: [
                  notice({
                    tone: "danger",
                    title: "Your agents is unavailable",
                    body: "<p>Try again in a moment.</p>"
                  })
                ]
              })
            },
            session
          );
        })
    })
  );

/** Failures before there is a viewer to show the app to: the door says so. */
const errors = <R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, SqlError | Session.SessionError, R>
) =>
  Effect.gen(function* () {
    const session = yield* Session.Session;
    return yield* app.pipe(
      Effect.catchTags({
        SqlError: () =>
          Effect.succeed(
            pageResponse(
              {
                title: "Your agents is unavailable",
                body: "<p>Try again in a moment.</p>",
                status: 503
              },
              session
            )
          ),
        SessionError: () =>
          Effect.succeed(
            pageResponse(
              {
                title: "Sign-in service unavailable",
                body: "<p>Please try again.</p>",
                status: 502
              },
              session
            )
          )
      })
    );
  });

/** A page of Your agents: signed in, failures in the app once the viewer is known. */
const page = <R>(
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    MachineTokens.MachineTokenNotFound | AgentConnections.AgentConnectionNotFound | SqlError,
    R
  >
) => errors(RequireSession.withViewer(inApp(app)));

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
    yield* router.add("GET", "/agents", page(agents()));
    yield* router.add("GET", "/agents/connect", page(connectApp));
    yield* router.add("GET", "/agents/computer", page(addComputer(false)));
    yield* router.add("GET", "/agents/computer/no-agent", page(addComputer(true)));
    yield* router.add("GET", "/agents/disconnect-all", page(confirmAll));
    yield* router.add("GET", "/agents/computers/:id/disconnect", page(confirmComputer));
    yield* router.add("GET", "/agents/apps/:id/disconnect", page(confirmApp));
    yield* router.add(
      "POST",
      "/agents/computers/:id/disconnect",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(inApp(revoke))))
    );
    yield* router.add(
      "POST",
      "/agents/disconnect-all",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(inApp(disconnectAll))))
    );
    yield* router.add(
      "POST",
      "/agents/apps/:id/disconnect",
      errors(RequireSession.sameOrigin(RequireSession.withViewer(inApp(disconnect))))
    );
  })
);
