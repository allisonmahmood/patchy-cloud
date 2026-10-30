import { mutation, query, t } from "../patchy/_generated/server.js";

/** Everyone who opens the log reads it, the patch's guests too. */
export const list = query({
  guest: true,
  args: {},
  result: t.array(t.row("notes")),
  handler: async (ctx) => (await ctx.tables.notes.list({ limit: 100 })).rows
});

/** Anyone logs a visit, signed by who they really are. */
export const create = mutation({
  guest: true,
  args: { title: t.text() },
  result: t.row("notes"),
  handler: (ctx, args) => ctx.tables.notes.insert({ title: args.title, by: ctx.viewer.user.name })
});

/** Only Harbor Works clears the log: unmarked, so a guest can't start it. */
export const clear = mutation({
  args: {},
  result: t.integer(),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.notes.list({ limit: 100 });
    for (const row of rows) await ctx.tables.notes.delete(row.id);
    return rows.length;
  }
});
