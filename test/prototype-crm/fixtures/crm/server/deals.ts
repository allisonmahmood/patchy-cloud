// PROTOTYPE for #315: the tiny consumer the boundary proofs run against (not the CRM).
import { query, mutation, t, HandlerError } from "../patchy/_generated/server";

const deal = t.object({
  id: t.text(),
  title: t.text(),
  stage: t.text(),
  private: t.boolean(),
  mine: t.boolean()
});

/** The patch's filter: team deals, plus the viewer's own private ones. */
export const pipeline = query({
  args: t.object({}),
  result: t.array(deal),
  handler: async (ctx) => {
    const page = await ctx.tables.deals.list({ limit: 500 });
    return page.rows
      .filter((row) => !row.private || row.ownerId === ctx.viewer.user.id)
      .map((row) => ({
        id: row.id,
        title: row.title,
        stage: row.stage,
        private: row.private,
        mine: row.ownerId === ctx.viewer.user.id
      }));
  }
});

export const create = mutation({
  args: t.object({ title: t.text(), stage: t.text(), private: t.boolean() }),
  result: t.text(),
  handler: async (ctx, args) =>
    (await ctx.tables.deals.insert({ ...args, ownerId: ctx.viewer.user.id })).id
});

export const move = mutation({
  args: t.object({ id: t.text(), stage: t.text() }),
  result: t.text(),
  errors: ["not_owner"],
  handler: async (ctx, { id, stage }) => {
    const row = await ctx.tables.deals.get(id);
    if (row === null || row.ownerId !== ctx.viewer.user.id) throw new HandlerError("not_owner");
    await ctx.tables.deals.update(id, { stage });
    return id;
  }
});
