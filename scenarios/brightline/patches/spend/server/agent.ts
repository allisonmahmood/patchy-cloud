import { HandlerError, mutation, query, t } from "../patchy/_generated/server.js";
import {
  adminApprovalCents,
  categories,
  checkRequest,
  formatMoney,
  receiptRequiredCents,
  refusals,
  statuses,
  type Refusal
} from "../helpers/spend.js";

// The agent area: the tools people's own agents (Claude Code, Codex, …) call through Patchy's
// MCP, acting as the person they work for. Only these exports are offered to agents.
// Agents may read the person's requests and draft new ones, but spending stays a human act:
// a draft waits in the page for the person to check it, attach the receipt and submit it, and
// approving, rejecting and marking paid have no agent tools at all.

const refuse = (code: Refusal) => new HandlerError(code, { message: refusals[code] });

/** Who may approve a request of this size; nobody approves their own. */
const approvedBy = (cents: number) =>
  cents >= adminApprovalCents ? "a company admin" : "any teammate but the requester";

const MAX_LISTED = 50;

export const myRequests = query({
  description:
    "The spend requests of the person you act for, newest first (at most 50), with where each stands, " +
    "plus the drafts their agents made that they haven't submitted yet. Read-only. " +
    "Approving, rejecting and marking paid happen only in the Spend page, by people: no agent can do them.",
  args: {
    status: t
      .enum(statuses)
      .describe(
        "Only requests with this status: submitted (waiting for a decision), approved, rejected or paid."
      )
      .optional()
  },
  result: t.object({
    requests: t.array(
      t.object({
        title: t.text(),
        project: t.text().describe('The client it is for, or "Studio" for internal spend.'),
        category: t.text(),
        amount: t.text().describe('In US dollars, like "$1,264.80".'),
        status: t.text().describe("submitted, approved, rejected or paid."),
        submitted: t.timestamp(),
        waitingFor: t
          .nullable(t.text())
          .describe("Who can decide a submitted request; null once it is decided."),
        decidedBy: t.nullable(t.text()).describe("Who approved or rejected it."),
        decisionNote: t.nullable(t.text()).describe("Their note; a rejection always says why."),
        paid: t.nullable(t.timestamp()),
        receipt: t.boolean().describe("Whether a receipt or quote is attached.")
      })
    ),
    drafts: t.array(
      t.object({
        title: t.text(),
        project: t.text(),
        category: t.text(),
        amount: t.text(),
        draftedBy: t.text().describe("The agent that drafted it."),
        drafted: t.timestamp()
      })
    )
  }),
  handler: async (ctx, args) => {
    const me = ctx.viewer.user.id;
    const { rows } = await ctx.tables.requests.list({
      index: "bySubmitted",
      order: "desc",
      limit: 1000
    });
    const drafts = await ctx.tables.drafts.list({
      index: "byRequester",
      eq: { requester: me },
      limit: 100
    });
    const mine = rows
      .filter(
        (row) => row.requester === me && (args.status === undefined || row.status === args.status)
      )
      .slice(0, MAX_LISTED);
    const deciders = mine.flatMap((row) => (row.approver === null ? [] : [row.approver]));
    const names = new Map(
      (deciders.length === 0 ? [] : await ctx.members.getMany([...new Set(deciders)])).flatMap(
        (member) => (member === null ? [] : [[member.id, member.name] as const])
      )
    );
    return {
      requests: mine.map((row) => ({
        title: row.title,
        project: row.project,
        category: row.category,
        amount: formatMoney(row.amountCents),
        status: row.status,
        submitted: row.submittedAt,
        waitingFor: row.status === "submitted" ? approvedBy(row.amountCents) : null,
        decidedBy: row.approver === null ? null : (names.get(row.approver) ?? "A former member"),
        decisionNote: row.decisionNote,
        paid: row.paidAt,
        receipt: row.receipt !== null
      })),
      drafts: [...drafts.rows]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((draft) => ({
          title: draft.title,
          project: draft.project,
          category: draft.category,
          amount: formatMoney(draft.amountCents),
          draftedBy: draft.agent,
          drafted: draft.createdAt
        }))
    };
  }
});

export const draftRequest = mutation({
  description:
    "Draft a spend request for the person you act for. It is not submitted: it waits in their Spend page, " +
    "where they check it, attach the receipt or quote (required at $500 or more; agents can't send files) and submit it. " +
    "Tell them to do that. Once submitted, requests of $2,500 or more are approved by a company admin and smaller ones by any teammate, " +
    "never by the requester; approving, rejecting and paying happen only in the Spend page, by people. " +
    "A refusal says which detail to fix.",
  args: {
    title: t
      .text()
      .describe(
        'What the money is for, 3 to 120 characters, such as "Retoucher for the spring lookbook".'
      ),
    project: t.text().describe('The client the spend is for, or "Studio" for internal spend.'),
    category: t.enum(categories).describe("The kind of spend."),
    amount: t
      .number()
      .describe("The amount in US dollars, such as 1264.80: above 0 and below 1,000,000.")
  },
  errors: ["missing_title", "missing_project", "invalid_amount"],
  result: t.object({
    title: t.text(),
    project: t.text(),
    category: t.text(),
    amount: t.text(),
    receiptNeeded: t
      .boolean()
      .describe("Whether the person must attach a receipt or quote to submit it."),
    approvedBy: t.text().describe("Who can approve it once submitted."),
    nextStep: t.text().describe("What to tell the person.")
  }),
  handler: async (ctx, args) => {
    const fields = {
      title: args.title.trim(),
      project: args.project.trim(),
      amountCents: Math.round(args.amount * 100)
    };
    // The receipt comes later, in the page; every other rule applies now.
    const broken = checkRequest(fields, true);
    if (broken !== null) throw refuse(broken);
    await ctx.tables.drafts.insert({
      ...fields,
      category: args.category,
      requester: ctx.viewer.user.id,
      agent: ctx.agent?.name ?? "an agent"
    });
    const receiptNeeded = fields.amountCents >= receiptRequiredCents;
    return {
      title: fields.title,
      project: fields.project,
      category: args.category,
      amount: formatMoney(fields.amountCents),
      receiptNeeded,
      approvedBy: approvedBy(fields.amountCents),
      nextStep: `It's a draft until ${ctx.viewer.user.name.split(" ")[0]} opens Spend, checks it, ${
        receiptNeeded ? "attaches the receipt or quote " : ""
      }and submits it.`
    };
  }
});
