import { query, mutation } from "../patchy/_generated/server.js";
import { t } from "patchy/server";

export const total = query({
  description: "Read the shared launch cheer total.",
  args: {}, result: t.integer(),
  handler: async (ctx) => {
    const page = await ctx.tables.counter.list({ index: "byKey", eq: { key: "launch" }, limit: 1 });
    return page.rows[0]?.count ?? 0;
  }
});

export const cheer = mutation({
  description: "Add one cheer to the shared launch total.",
  args: {}, result: t.integer(),
  handler: async (ctx) => {
    const page = await ctx.tables.counter.list({ index: "byKey", eq: { key: "launch" }, limit: 1 });
    const row = page.rows[0];
    if (row) return (await ctx.tables.counter.update(row.id, { count: row.count + 1 })).count;
    return (await ctx.tables.counter.insert({ key: "launch", count: 1 })).count;
  }
});
