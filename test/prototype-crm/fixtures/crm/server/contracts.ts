// PROTOTYPE for #315: the shared contracts store, re-authorised on every read.
import { query, t } from "../patchy/_generated/server";

export const list = query({
  args: t.object({}),
  result: t.array(
    t.object({ name: t.text(), size: t.number(), contentType: t.text(), handle: t.fileHandle() })
  ),
  handler: async (ctx) =>
    (await ctx.shared.contracts.list({ limit: 100 })).files.map((entry) => ({
      name: entry.name,
      size: entry.size,
      contentType: entry.contentType,
      handle: entry.handle
    }))
});
