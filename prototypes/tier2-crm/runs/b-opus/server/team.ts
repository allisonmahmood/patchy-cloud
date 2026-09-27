import { query, mutation, t } from "../patchy/_generated/server.js";

/**
 * Records the viewer as a teammate so others can hand records to them. The page calls it once
 * on load; Patchy has no company directory a patch can read.
 */
export const join = mutation({
  args: t.object({}),
  result: t.row("members"),
  handler: async (ctx) => {
    const { id, name, email } = ctx.viewer.user;
    const { rows } = await ctx.tables.members.list({
      index: "byUser",
      eq: { userId: id },
      limit: 1
    });
    const existing = rows[0];
    if (existing === undefined) return ctx.tables.members.insert({ userId: id, name, email });
    if (existing.name === name && existing.email === email) return existing;
    return ctx.tables.members.update(existing.id, { name, email });
  }
});

/** Everyone who has opened the CRM, for the owner picker. */
export const list = query({
  args: t.object({}),
  result: t.array(t.row("members")),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.members.list({ limit: 500 });
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }
});
