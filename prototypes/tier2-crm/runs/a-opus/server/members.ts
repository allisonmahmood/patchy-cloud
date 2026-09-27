import { query, mutation, t } from "../patchy/_generated/server.js";

/** Everyone who has opened the CRM: the people a record can be handed to. */
export const list = query({
  args: t.object({}),
  result: t.array(t.row("members")),
  handler: async (ctx) => (await ctx.tables.members.list({ limit: 1000 })).rows
});

/** Registers the viewer as a teammate (or refreshes their name/email); the page calls it on load. */
export const hello = mutation({
  args: t.object({}),
  result: t.row("members"),
  handler: async (ctx) => {
    const { id: userId, name, email } = ctx.viewer.user;
    const [existing] = (
      await ctx.tables.members.list({ index: "byUser", eq: { userId }, limit: 1 })
    ).rows;
    if (!existing) return ctx.tables.members.insert({ userId, name, email });
    if (existing.name === name && existing.email === email) return existing;
    return ctx.tables.members.update(existing.id, { name, email });
  }
});
