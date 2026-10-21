import { query, t } from "../patchy/_generated/server.js";

/** List blocked launch items from the published Tool's live table. No inputs or writes. */
export const blocked = query({
  args: {},
  result: t.object({
    blocked: t.array(t.object({ title: t.text(), owner: t.text(), blocker: t.text() })),
    total: t.integer()
  }),
  handler: async (ctx) => {
    const blocked: { title: string; owner: string; blocker: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await ctx.tables.items.list({
        index: "byStatus", eq: { status: "blocked" }, limit: 1000,
        ...(cursor === undefined ? {} : { cursor })
      });
      blocked.push(...page.rows.map(({ title, owner, blocker }) => ({ title, owner, blocker })));
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return { blocked, total: blocked.length };
  }
});
