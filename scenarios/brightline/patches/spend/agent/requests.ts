// Tools for people's agents, used through Patchy MCP. Each runs as the person and keeps the
// spend rules: approving and rejecting are the page's own handlers, and an agent submits only
// what needs no receipt, since files don't cross to agents.
import { HandlerError, mutation, query, t } from "../patchy/_generated/server.js";
import { insertSubmitted } from "../helpers/requests.js";
import { categories, checkRequest, refusals, statuses } from "../helpers/spend.js";

export { approve as approveRequest, reject as rejectRequest } from "../server/requests.js";

/** At most this many requests per answer, so a read stays small; `next` continues the list. */
const LISTED = 50;

const listedRequest = t.object({
  id: t.text(),
  title: t.text(),
  project: t.text(),
  category: t.text(),
  amountCents: t.integer().describe("The amount in whole US cents."),
  status: t.text(),
  requester: t.text().describe("Who asked for the money."),
  approver: t.nullable(t.text()).describe("Who approved or rejected it."),
  decisionNote: t.nullable(t.text()),
  hasReceipt: t.boolean(),
  submittedAt: t.timestamp()
});

export const listRequests = query({
  description:
    `Lists spend requests, newest first, ${LISTED} at a time; total counts every match, and next, when ` +
    "there are more, is the from that continues the list. Names are people's names. The ids in the answer " +
    "are what approveRequest and rejectRequest take. Changes nothing.",
  args: {
    status: t.enum(statuses).optional().describe("Only requests with this status."),
    from: t.integer().optional().describe("Where to continue: the previous answer's next.")
  },
  result: t.object({
    requests: t.array(listedRequest),
    total: t.integer(),
    next: t.nullable(t.integer())
  }),
  handler: async (ctx, args) => {
    const rows = [];
    let cursor: string | null = null;
    do {
      const page = await ctx.tables.requests.list({
        index: "bySubmitted",
        order: "desc",
        limit: 1000,
        ...(cursor === null ? {} : { cursor })
      });
      rows.push(...page.rows);
      cursor = page.cursor;
    } while (cursor !== null);
    const from = Math.max(0, args.from ?? 0);
    const matches = rows.filter((row) => args.status === undefined || row.status === args.status);
    const listed = matches.slice(from, from + LISTED);
    const ids = new Set(
      listed.flatMap((row) =>
        row.approver === null ? [row.requester] : [row.requester, row.approver]
      )
    );
    const members = ids.size === 0 ? [] : await ctx.members.getMany([...ids]);
    const names = new Map(
      members.flatMap((member) => (member === null ? [] : [[member.id, member.name] as const]))
    );
    const name = (id: string) => names.get(id) ?? "Someone who left";
    return {
      total: matches.length,
      next: from + LISTED < matches.length ? from + LISTED : null,
      requests: listed.map((row) => ({
        id: row.id,
        title: row.title,
        project: row.project,
        category: row.category,
        amountCents: row.amountCents,
        status: row.status,
        requester: name(row.requester),
        approver: row.approver === null ? null : name(row.approver),
        decisionNote: row.decisionNote,
        hasReceipt: row.receipt !== null,
        submittedAt: row.submittedAt
      }))
    };
  }
});

export const submitRequest = mutation({
  description:
    "Submits a spend request as the person and returns it. Requests of $500 or more need a receipt or quote, " +
    "which only the page can attach, so those are refused receipt_required: the person submits them on the " +
    "page. Also refused missing_title (3 to 120 characters), missing_project (a client name, or Studio for " +
    "internal spend) and invalid_amount (above $0 and below $1,000,000).",
  args: {
    title: t.text().describe("What the money is for, such as Figma seats for Q1."),
    project: t.text().describe("The client it's for, or Studio for internal spend."),
    category: t.enum(categories).describe("The kind of spend."),
    amountCents: t.integer().describe("The amount in whole US cents: $120.50 is 12050.")
  },
  errors: ["missing_title", "missing_project", "invalid_amount", "receipt_required"],
  result: t.row("requests"),
  handler: (ctx, args) => {
    const broken = checkRequest(args, false);
    if (broken !== null) throw new HandlerError(broken, { message: refusals[broken] });
    return insertSubmitted(ctx, args, null);
  }
});
