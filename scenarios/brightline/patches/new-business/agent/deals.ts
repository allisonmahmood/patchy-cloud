// Tools for people's agents, used through Patchy MCP. Each runs as the person and keeps the
// board's rules: moving deals, notes and finding people are the page's own handlers, and a lead
// an agent adds must also say what happens next, which the page leaves optional.
import { HandlerError, mutation, query, t } from "../patchy/_generated/server.js";
import { addLead as addCheckedLead } from "../helpers/leads.js";
import { resolvePeople } from "../helpers/people.js";
import { SERVICES, SOURCES, STAGES } from "../helpers/pipeline.js";

export { move as moveDeal, addNote } from "../server/deals.js";
export { people as findPeople } from "../server/team.js";

/** At most this many deals per answer, so a read stays small; `total` says how many matched. */
const LISTED = 50;

const listedDeal = t.object({
  id: t.text(),
  client: t.text(),
  title: t.text(),
  service: t.text(),
  stage: t.text(),
  value: t.nullable(t.integer()).describe("Estimated fee in whole USD; null until estimated."),
  owner: t.nullable(t.object({ id: t.text(), name: t.text() })),
  nextStep: t.nullable(t.text()),
  expectedClose: t.nullable(t.text()).describe("A YYYY-MM-DD date."),
  lostReason: t.nullable(t.text()),
  lastActivityAt: t.timestamp()
});

export const listDeals = query({
  description:
    `Lists the pipeline's deals with their owners, most recently active first, at most ${LISTED} at a time; ` +
    "total counts every match. Narrow it by stage, or by words that must all appear in the client or project. " +
    "The ids in the answer are what moveDeal and addNote take. Changes nothing.",
  args: {
    stage: t.enum(STAGES).optional().describe("Only deals in this stage."),
    search: t
      .text()
      .optional()
      .describe("Words that must all appear in the client or project title, in any case.")
  },
  result: t.object({ deals: t.array(listedDeal), total: t.integer() }),
  handler: async (ctx, args) => {
    const words = (args.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const { rows } = await ctx.tables.deals.list({ limit: 1000 });
    const matches = rows
      .filter((deal) => args.stage === undefined || deal.stage === args.stage)
      .filter((deal) => {
        const text = `${deal.client} ${deal.title}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const listed = matches.slice(0, LISTED);
    const people = await resolvePeople(
      ctx.members,
      listed.map((deal) => deal.owner)
    );
    const names = new Map(people.map((person) => [person.id, person.name]));
    return {
      total: matches.length,
      deals: listed.map((deal) => ({
        id: deal.id,
        client: deal.client,
        title: deal.title,
        service: deal.service,
        stage: deal.stage,
        value: deal.value,
        owner: deal.owner === null ? null : { id: deal.owner, name: names.get(deal.owner) ?? "" },
        nextStep: deal.nextStep,
        expectedClose: deal.expectedClose,
        lostReason: deal.lostReason,
        lastActivityAt: deal.lastActivityAt
      }))
    };
  }
});

export const addLead = mutation({
  description:
    "Adds a new pitch to the Lead column, as the person, and returns the deal. A lead an agent adds must say " +
    "what happens next. Leave value out until there's an estimate, and owner out to leave the lead for someone " +
    "to pick up. Refused invalid_input, naming the field and why, or not_a_member when the owner isn't an " +
    "active member.",
  args: {
    client: t.text().describe("The client company, such as Harbor & Pine Coffee."),
    title: t.text().describe("The project, such as Spring campaign."),
    service: t.enum(SERVICES).describe("What Brightline would do for them."),
    source: t.enum(SOURCES).describe("How the lead came in."),
    nextStep: t.text().describe("What happens next, such as Intro call on Tuesday."),
    value: t.integer().optional().describe("The estimated fee in whole USD."),
    expectedClose: t.text().optional().describe("When it should close, as YYYY-MM-DD."),
    owner: t.text().optional().describe("The member id of who owns it, from findPeople.")
  },
  errors: ["invalid_input", "not_a_member"],
  result: t.row("deals"),
  handler: (ctx, { owner, value, expectedClose, ...draft }) => {
    if (draft.nextStep.trim() === "")
      throw new HandlerError("invalid_input", {
        field: "nextStep",
        message: "Say what happens next."
      });
    return addCheckedLead(
      ctx,
      { ...draft, value: value ?? null, expectedClose: expectedClose ?? null },
      owner ?? null
    );
  }
});
