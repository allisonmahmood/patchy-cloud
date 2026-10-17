import { HandlerError, mutation, query, t } from "../patchy/_generated/server.js";
import type { Id } from "patchy/config";
import { refusals } from "../helpers/spend.js";

// The page's side of the requests people's agents draft (server/agent.ts writes them): the
// viewer's own drafts, and a way to throw one away. Finishing a draft goes through
// requests.submit, which deletes it once the request is in.

/** The viewer's drafts, newest first. Nobody else sees them. */
export const mine = query({
  args: {},
  result: t.array(t.row("drafts")),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.drafts.list({
      index: "byRequester",
      eq: { requester: ctx.viewer.user.id },
      limit: 100
    });
    return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
});

/** Deletes one of the viewer's drafts without submitting it. */
export const discard = mutation({
  args: { id: t.text() },
  result: t.boolean(),
  errors: ["draft_missing"],
  handler: async (ctx, args) => {
    const draft = await ctx.tables.drafts.get(args.id as Id<"drafts">);
    if (draft === null || draft.requester !== ctx.viewer.user.id)
      throw new HandlerError("draft_missing", { message: refusals.draft_missing });
    await ctx.tables.drafts.delete(draft.id);
    return true;
  }
});
