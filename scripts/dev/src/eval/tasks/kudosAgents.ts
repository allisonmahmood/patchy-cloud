import { argsFor, entryWith, findTool, mentions } from "../agent.js";
import type { Agent, AgentCall, AgentTool, CheckContext, RunPerson, Task } from "../task.js";
import { around, shows } from "./page.js";

/** Most telling first: a tool named for giving or listing kudos, then for giving or listing, then kudos. */
export const GIVE = [
  /(give|send|thank|shout|praise)\w*kudo|kudo\w*(give|send)/i,
  /^(give|send|thank|shout|praise)/i,
  /kudo/i,
  /add|create/i
];
export const LIST = [
  /(list|recent|wall|feed)\w*kudo|kudo\w*(list|recent|wall|feed)/i,
  /^(list|recent|wall|feed)/i,
  /kudo/i
];

/**
 * Gives `to` a kudo saying `words` through `give`, naming them each way its
 * arguments allow until one isn't refused: the answer that worked, or every
 * way's refusal.
 */
const giveKudo = async (agent: Agent, give: AgentTool, to: RunPerson, words: string) => {
  const refused: Array<string> = [];
  for (const args of argsFor(give.args, { person: to, text: words })) {
    const answer = await agent.call(give, args);
    if (answer.ok) return answer;
    refused.push(refusal(answer));
  }
  return {
    ok: false,
    reason: `${give.name} was refused (${[...new Set(refused)].join("; ") || "no arguments to give"}).`
  } as const;
};

const refusal = (answer: Extract<AgentCall, { ok: false }>) =>
  `${answer.code}: ${answer.message.split("\n")[0]}`;

/** Jordan's agent and its tools to give and to list kudos, or the check's failure. */
const jordansTools = async (ctx: CheckContext) => {
  const agent = ctx.agent("jordan");
  const tools = await agent.tools();
  const give = findTool(tools, "change", GIVE);
  const list = findTool(tools, "read", LIST);
  if (give !== undefined && list !== undefined) return { ok: true, agent, give, list } as const;
  const named = tools.map((tool) => `${tool.name} (${tool.kind})`).join(", ") || "none";
  return {
    ok: false,
    reason: `Its tools are ${named}; it needs one to give kudos and one to list them.`
  } as const;
};

/**
 * Agent tools on brightline's Kudos, a live tier 2 wall with rules a page
 * keeps: the sender is whoever gives, the recipient an active colleague.
 * Jordan's agent has to find tools to give and list kudos, give Priya one
 * that Marcus sees on the wall from Jordan, and list one it gave.
 */
export default {
  id: "kudos-agents",
  scenario: "brightline",
  words: "Let people's agents give kudos and list them in our Kudos patch, then publish it.",
  target: { existing: "kudos" },
  minutes: 25,
  heldOut: false,
  rubric: [
    "An agent area (`agent/`) with a read tool listing kudos and a change tool giving one, each with a description an agent can act on, and arguments described where their names don't say enough.",
    "Giving keeps the page's rules by reusing them: the sender is the person the agent acts for (`ctx.viewer`), never an argument; the recipient must be an active colleague; the message is checked as the page's `give` checks it, refusing with declared errors. Re-exporting or sharing the page's `give` rather than copying it.",
    "An agent can name a colleague: a tool to look people up, or a recipient taken by name or email and resolved through the member directory. Listing returns people's names, not only ids, and is bounded (a limit, and a way to continue).",
    "Nothing else changes: the page, its `guest` marks and its tables stay as they were; published as a new version."
  ].join("\n"),
  checks: [
    {
      name: "Jordan's agent finds tools to give and to list kudos",
      agents: ["jordan"],
      run: async (ctx) => {
        const found = await jordansTools(ctx);
        return found.ok ? { ok: true, note: `${found.give.name} and ${found.list.name}` } : found;
      }
    },
    {
      name: "Jordan's agent gives Priya a kudo, and Marcus sees it on the wall from Jordan",
      agents: ["jordan"],
      run: async (ctx) => {
        const found = await jordansTools(ctx);
        if (!found.ok) return found;
        const words = `Thanks for rescuing the storyboard ${ctx.code}`;
        const given = await giveKudo(found.agent, found.give, ctx.person("priya"), words);
        if (!given.ok) return given;
        const marcus = await ctx.open("marcus");
        if (!(await shows(marcus, words)))
          return { ok: false, reason: "Marcus doesn't see the kudo on the wall." };
        const card = around(marcus.frame, words, { hasText: ctx.person("jordan").name }).filter({
          hasText: ctx.person("priya").name
        });
        return (await card.count()) > 0
          ? { ok: true }
          : { ok: false, reason: "Marcus sees the kudo, but not as Jordan's to Priya." };
      }
    },
    {
      name: "Jordan's agent lists a kudo it gave",
      agents: ["jordan"],
      run: async (ctx) => {
        const found = await jordansTools(ctx);
        if (!found.ok) return found;
        const words = `Great client call today ${ctx.code}`;
        const given = await giveKudo(found.agent, found.give, ctx.person("sofia"), words);
        if (!given.ok) return given;
        const listed = await found.agent.call(found.list, argsFor(found.list.args, {})[0] ?? {});
        if (!listed.ok)
          return { ok: false, reason: `${found.list.name} was refused (${refusal(listed)}).` };
        const entry = entryWith(listed.result, words);
        return entry === undefined
          ? { ok: false, reason: `${found.list.name} doesn't list the kudo it just gave.` }
          : mentions(entry, ctx.person("sofia"))
            ? { ok: true }
            : { ok: false, reason: `${found.list.name} lists the kudo without who it's for.` };
      }
    }
  ]
} satisfies Task;
