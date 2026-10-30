import { action, mutation, query, t } from "../patchy/_generated/server.js";

export const list = query({
  guest: true,
  args: {},
  result: t.array(t.row("notes")),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows
});

export const add = mutation({
  guest: true,
  args: { text: t.text() },
  result: t.row("notes"),
  handler: (ctx, args) => ctx.tables.notes.insert({ text: args.text, author: ctx.viewer.user.id })
});

export const who = action({
  guest: true,
  args: {},
  result: t.object({ id: t.text(), guest: t.boolean() }),
  handler: async (ctx) => ({ id: ctx.viewer.user.id, guest: ctx.viewer.guest })
});

export const privateCount = query({
  args: {},
  result: t.integer(),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows.length
});
