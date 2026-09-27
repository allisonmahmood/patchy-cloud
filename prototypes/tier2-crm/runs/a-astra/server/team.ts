import { mutation, query, t } from "../patchy/_generated/server.js";

export const join = mutation({
  args: t.object({}),
  result: t.row("members"),
  handler: async (ctx) => {
    const { id: userId, name, email } = ctx.viewer.user;
    const existing = (await ctx.tables.members.list({ index: "byUser", eq: { userId }, limit: 1 }))
      .rows[0];
    return existing
      ? ctx.tables.members.update(existing.id, { name, email })
      : ctx.tables.members.insert({ userId, name, email });
  }
});
export const list = query({
  args: t.object({}),
  result: t.object({ viewerId: t.text(), members: t.array(t.row("members")) }),
  handler: async (ctx) => ({
    viewerId: ctx.viewer.user.id,
    members: (await ctx.tables.members.list({ limit: 1000 })).rows
  })
});
