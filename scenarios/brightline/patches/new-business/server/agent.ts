// The agent area: the tools people's own agents (Claude Code, Codex, …) call through Patchy's
// MCP, acting as the person they work for. Only these exports are offered to agents.
// Every change goes through the board's own rules (helpers/dealRules.ts), and agents are held
// to more than people: a person may add a deal with blanks to fill in later, an agent must give
// every field. Each change records the agent on the deal's timeline ("Allison's agent (Codex)").
import {
  HandlerError,
  mutation,
  query,
  t,
  type MutationContext
} from "../patchy/_generated/server.js";
import { checkDeal } from "../helpers/dealInput.js";
import { assigning, moveStage, writeNote } from "../helpers/dealRules.js";
import { resolvePeople } from "../helpers/people.js";
import { LOST_REASONS, MAX_IMPORT_ROWS, SERVICES, SOURCES, STAGES } from "../helpers/pipeline.js";

/** findDeals answers at most this many deals; narrower filters reach the rest. */
const MAX_FOUND = 50;

const dealSummary = t.object({
  id: t.text().describe("The deal's id, for moveDeal and addNote when a client has several deals."),
  client: t.text().describe("The prospect's company."),
  project: t.text().describe("The work being pitched."),
  service: t.text(),
  stage: t.text().describe("lead, discovery, proposal, negotiation, won or lost."),
  value: t
    .nullable(t.integer())
    .describe("Estimated fee in whole US dollars; null until estimated."),
  owner: t.nullable(t.text()).describe("The owner's name; null when nobody owns the deal."),
  source: t.text(),
  nextStep: t.nullable(t.text()),
  expectedClose: t.nullable(t.text()).describe("When it should be decided, YYYY-MM-DD."),
  lostReason: t.nullable(t.text()).describe("Why a lost deal was lost; null otherwise."),
  lastActivity: t.timestamp()
});

const dealRef = t
  .text()
  .describe(
    "The deal: its id from findDeals, or its client's company name when only one deal has that client."
  );

/** The deal fields a summary reads. */
interface DealRow {
  readonly id: string;
  readonly client: string;
  readonly title: string;
  readonly service: string;
  readonly stage: string;
  readonly value: number | null;
  readonly owner: string | null;
  readonly source: string;
  readonly nextStep: string | null;
  readonly expectedClose: string | null;
  readonly lostReason: string | null;
  readonly lastActivityAt: string;
}

const summarize = (deal: DealRow, names: ReadonlyMap<string, string>) => ({
  id: deal.id,
  client: deal.client,
  project: deal.title,
  service: deal.service,
  stage: deal.stage,
  value: deal.value,
  owner: deal.owner === null ? null : (names.get(deal.owner) ?? "A former member"),
  source: deal.source,
  nextStep: deal.nextStep,
  expectedClose: deal.expectedClose,
  lostReason: deal.lostReason,
  lastActivity: deal.lastActivityAt
});

const namesOf = async (ctx: Pick<MutationContext, "members">, ids: Iterable<string | null>) =>
  new Map((await resolvePeople(ctx.members, ids)).map((person) => [person.id, person.name]));

// ---------------------------------------------------------------------------------------------
// Reads

export const findDeals = query({
  description:
    "Search New Business, Brightline's pipeline of pitches from first lead to signed or lost work. " +
    "Returns up to 50 deals, most recently active first, with owners by name. Read-only. " +
    "Stages run lead → discovery → proposal → negotiation → won, with lost apart; values are estimated fees in whole US dollars. " +
    "With no arguments it lists the whole board.",
  args: {
    search: t
      .text()
      .describe(
        "Words that must all appear in the client, project, service, owner's name or next step; case doesn't matter."
      )
      .optional(),
    stage: t.enum(STAGES).describe("Only deals in this stage.").optional(),
    owner: t
      .text()
      .describe(
        'Only deals owned by this person: part of a name, an email, "me" for the person you act for, or "nobody" for deals without an owner.'
      )
      .optional()
  },
  result: t.object({
    deals: t.array(dealSummary),
    total: t
      .integer()
      .describe("How many deals matched; above the number returned when the list was cut at 50.")
  }),
  handler: async (ctx, args) => {
    const { rows } = await ctx.tables.deals.list({ limit: 1000 });
    const owners = await resolvePeople(
      ctx.members,
      rows.map((deal) => deal.owner)
    );
    const people = new Map(owners.map((person) => [person.id, person]));
    const names = new Map(owners.map((person) => [person.id, person.name]));
    const owner = args.owner?.trim().toLowerCase() ?? "";
    const words = (args.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const ownedAsAsked = (deal: DealRow) => {
      if (owner === "") return true;
      if (owner === "me") return deal.owner === ctx.viewer.user.id;
      if (owner === "nobody") return deal.owner === null;
      const person = deal.owner === null ? undefined : people.get(deal.owner);
      return (
        person !== undefined &&
        (person.name.toLowerCase().includes(owner) || person.email.toLowerCase() === owner)
      );
    };
    const matches = rows
      .filter((deal) => args.stage === undefined || deal.stage === args.stage)
      .filter(ownedAsAsked)
      .filter((deal) => {
        const text = [
          deal.client,
          deal.title,
          deal.service,
          deal.nextStep ?? "",
          names.get(deal.owner ?? "") ?? ""
        ]
          .join(" ")
          .toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return {
      deals: matches.slice(0, MAX_FOUND).map((deal) => summarize(deal, names)),
      total: matches.length
    };
  }
});

// ---------------------------------------------------------------------------------------------
// Writes

const lead = t.object({
  client: t.text().describe("The prospect's company name."),
  project: t
    .text()
    .describe('A short title for the work being pitched, such as "Spring campaign".')
    .optional(),
  service: t.enum(SERVICES).describe("What Brightline would do for them.").optional(),
  value: t.integer().describe("The estimated fee in whole US dollars, above zero.").optional(),
  source: t.enum(SOURCES).describe("How the lead came to Brightline.").optional(),
  owner: t
    .text()
    .describe(
      'Who at Brightline owns the pitch: a member\'s full name or email, or "me" for the person you act for.'
    )
    .optional(),
  nextStep: t
    .text()
    .describe('The next concrete action, such as "Intro call on Tuesday".')
    .optional(),
  expectedClose: t.text().describe("When the pitch should be decided, as YYYY-MM-DD.").optional()
});

/** Every field an agent must give; people on the board may leave value, owner, next step and close blank. */
const LEAD_FIELDS = [
  "client",
  "project",
  "service",
  "value",
  "source",
  "owner",
  "nextStep",
  "expectedClose"
] as const;

/** One lead addLeads refused: the fields it lacks and those that don't check out. */
type LeadProblem = {
  readonly lead: number;
  readonly client: string;
  readonly missing: readonly string[];
  readonly problems: readonly string[];
};

/** A member by full name, email, unique name prefix, or "me"; a sentence when none or several match. */
async function findOwner(ctx: MutationContext, text: string) {
  const wanted = text.trim().toLowerCase();
  if (wanted === "me") return { id: ctx.viewer.user.id, name: ctx.viewer.user.name };
  const { rows } = await ctx.members.search(text.trim());
  const active = rows.filter((member) => member.active);
  const exact = active.filter(
    (member) => member.email.toLowerCase() === wanted || member.name.toLowerCase() === wanted
  );
  const [only, ...others] = exact.length > 0 ? exact : active;
  if (only === undefined) return `No active member matches "${text}".`;
  if (others.length > 0)
    return `"${text}" matches ${[only, ...others].map((member) => member.name).join(", ")}; give a full name or email.`;
  return { id: only.id, name: only.name };
}

export const addLeads = mutation({
  description:
    "Add new leads to the New Business pipeline as the person you act for, all or nothing. " +
    "Each lead starts in Lead, owned by the member you name, and its timeline says the person's agent added it. " +
    "Agents must give every field for every lead (client, project, service, value, source, owner, nextStep, expectedClose), " +
    "even though people on the board may leave some blank. If any lead is missing a field or has one that doesn't check out, " +
    "nothing is added and the refusal lists each lead's problems: ask the person for what's missing instead of guessing, then send all the leads again. " +
    "Use findDeals first so you don't add a deal that is already on the board.",
  args: {
    leads: t
      .array(lead)
      .describe(`The leads to add, at most ${MAX_IMPORT_ROWS}; each needs every field.`)
  },
  errors: ["incomplete_leads", "not_a_member"],
  result: t.object({
    added: t.array(
      t.object({
        id: t.text(),
        client: t.text(),
        project: t.text(),
        owner: t.nullable(t.text())
      })
    )
  }),
  handler: async (ctx, args) => {
    if (args.leads.length === 0 || args.leads.length > MAX_IMPORT_ROWS)
      throw new HandlerError("incomplete_leads", {
        leads: [],
        message: `Send between 1 and ${MAX_IMPORT_ROWS} leads.`
      });

    const owners = new Map<string, Awaited<ReturnType<typeof findOwner>>>();
    for (const { owner } of args.leads)
      if (owner !== undefined && owner.trim() !== "" && !owners.has(owner))
        owners.set(owner, await findOwner(ctx, owner));

    const refused: LeadProblem[] = [];
    const ready = args.leads.flatMap((lead, index) => {
      const missing = LEAD_FIELDS.filter((field) => {
        const value = lead[field];
        return (
          value === undefined || value === 0 || (typeof value === "string" && value.trim() === "")
        );
      });
      const checked = checkDeal({
        client: lead.client,
        title: lead.project ?? "",
        service: lead.service ?? "",
        value: lead.value ?? null,
        source: lead.source ?? "",
        nextStep: lead.nextStep ?? null,
        expectedClose: lead.expectedClose ?? null
      });
      const owner = owners.get(lead.owner ?? "");
      if (checked.ok && typeof owner === "object" && missing.length === 0)
        return [{ fields: checked.fields, owner }];
      // Everything wrong with the lead at once, so one more round with the person fixes it.
      const field = checked.ok ? null : checked.field === "title" ? "project" : checked.field;
      const problems = [
        ...(checked.ok || missing.some((name) => name === field)
          ? []
          : [`${field}: ${checked.message}`]),
        ...(typeof owner === "string" ? [`owner: ${owner}`] : [])
      ];
      refused.push({ lead: index + 1, client: lead.client, missing, problems });
      return [];
    });
    if (refused.length > 0)
      throw new HandlerError("incomplete_leads", {
        leads: refused,
        message: `Nothing was added: ${refused.length} of ${args.leads.length} leads need more. Ask the person for what's missing, then send all the leads again.`
      });

    const now = new Date().toISOString();
    const agent = ctx.agent?.name ?? null;
    const names = new Map(ready.map(({ owner }) => [owner.id, owner.name]));
    return assigning(async () => {
      const deals = await ctx.tables.deals.insertMany(
        ready.map(({ fields, owner }) => ({
          ...fields,
          stage: "lead",
          owner: owner.id,
          openedAt: now,
          stageEnteredAt: now,
          lastActivityAt: now
        }))
      );
      await ctx.tables.activity.insertMany(
        deals.map((deal) => ({
          deal: deal.id,
          kind: "created",
          actor: ctx.viewer.user.id,
          agent,
          toStage: "lead",
          assignee: deal.owner,
          at: now
        }))
      );
      return {
        added: deals.map((deal) => ({
          id: deal.id,
          client: deal.client,
          project: deal.title,
          owner: deal.owner === null ? null : (names.get(deal.owner) ?? null)
        }))
      };
    });
  }
});

/** One deal by id, or by client name when exactly one deal has it. */
async function findDeal(ctx: MutationContext, ref: string) {
  const wanted = ref.trim().toLowerCase();
  const { rows } = await ctx.tables.deals.list({ limit: 1000 });
  const byId = rows.find((deal) => deal.id === ref.trim());
  if (byId !== undefined) return byId;
  const exact = rows.filter((deal) => deal.client.toLowerCase() === wanted);
  const matches =
    exact.length > 0 ? exact : rows.filter((deal) => deal.client.toLowerCase().includes(wanted));
  const [only, ...others] = matches;
  if (only === undefined)
    throw new HandlerError("not_found", {
      deal: ref,
      message: `No deal matches "${ref}". Use findDeals to look it up.`
    });
  if (others.length > 0)
    throw new HandlerError("ambiguous_deal", {
      message: `"${ref}" matches ${matches.length} deals; pass the id of the one you mean.`,
      deals: matches.slice(0, 10).map((deal) => ({
        id: deal.id,
        client: deal.client,
        project: deal.title,
        stage: deal.stage
      }))
    });
  return only;
}

export const moveDeal = mutation({
  description:
    "Move one deal to another stage as the person you act for, under the same rules people follow on the board: " +
    "Proposal, Negotiation and Won need a value and an owner; only the deal's owner or an admin may mark a deal won or lost, or reopen it; " +
    "lost needs a reason. A refusal names the rule and what would allow the move. You can't set a deal's value or owner here, " +
    "so pass that on to the person. The deal's timeline records that their agent moved it.",
  args: {
    deal: dealRef,
    stage: t.enum(STAGES).describe("The stage to move the deal to."),
    reason: t
      .enum(LOST_REASONS)
      .describe("Why the deal was lost. Required when stage is lost; ignored otherwise.")
      .optional()
  },
  errors: [
    "not_found",
    "ambiguous_deal",
    "owner_or_admin_only",
    "needs_value_and_owner",
    "reason_required"
  ],
  result: dealSummary,
  handler: async (ctx, args) => {
    const moved = await moveStage(
      ctx,
      await findDeal(ctx, args.deal),
      args.stage,
      args.reason ?? null
    );
    return summarize(moved, await namesOf(ctx, [moved.owner]));
  }
});

export const addNote = mutation({
  description:
    "Add a note to a deal's timeline as the person you act for; the whole studio sees it, marked as written by their agent. " +
    "Use it to record what happened, such as a call, an email or a decision, in a sentence or two.",
  args: {
    deal: dealRef,
    note: t.text().describe("The note, up to 2,000 characters, written for colleagues.")
  },
  errors: ["not_found", "ambiguous_deal", "invalid_input"],
  result: t.object({ deal: t.text(), client: t.text(), project: t.text(), note: t.text() }),
  handler: async (ctx, args) => {
    const deal = await findDeal(ctx, args.deal);
    const event = await writeNote(ctx, deal.id, args.note);
    return { deal: deal.id, client: deal.client, project: deal.title, note: event.note ?? "" };
  }
});
