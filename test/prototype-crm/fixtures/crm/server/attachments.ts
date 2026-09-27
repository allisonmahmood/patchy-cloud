// PROTOTYPE for #315: deal attachments through staged uploads and authorised handles.
import {
  query,
  mutation,
  action,
  t,
  HandlerError,
  isHandlerError
} from "../patchy/_generated/server";

const file = t.object({
  name: t.text(),
  size: t.number(),
  contentType: t.text(),
  handle: t.fileHandle()
});

/** Who can see the deal sees its attachments; the handles are that selection. */
export const list = query({
  args: t.object({ dealId: t.text() }),
  result: t.array(file),
  handler: async (ctx, { dealId }) => {
    const deal = await ctx.tables.deals.get(dealId);
    if (deal === null || (deal.private && deal.ownerId !== ctx.viewer.user.id)) return [];
    const rows = await ctx.tables.attachments.list({ index: "byDeal", eq: { dealId }, limit: 100 });
    const files = [];
    for (const row of rows.rows) {
      const entry = await ctx.files.dealFiles.stat(`${dealId}/${row.name}`);
      if (entry !== null)
        files.push({
          name: row.name,
          size: entry.size,
          contentType: entry.contentType,
          handle: entry.handle
        });
    }
    return files;
  }
});

/** The follow-up the action runs after adopting the file; `fail` simulates it failing. */
export const record = mutation({
  args: t.object({ dealId: t.text(), name: t.text(), fail: t.boolean() }),
  result: t.text(),
  errors: ["not_owner", "record_failed"],
  handler: async (ctx, args) => {
    const deal = await ctx.tables.deals.get(args.dealId);
    if (deal === null || deal.ownerId !== ctx.viewer.user.id) throw new HandlerError("not_owner");
    if (args.fail) throw new HandlerError("record_failed");
    return (
      await ctx.tables.attachments.insert({
        dealId: args.dealId,
        name: args.name,
        ownerId: ctx.viewer.user.id
      })
    ).id;
  }
});

/**
 * Adopts the upload, then records it. put-then-mutation is not atomic: when the record fails,
 * the stored file stays and the result says so, so the page can present the partial outcome.
 */
export const attach = action({
  args: t.object({ dealId: t.text(), name: t.text(), file: t.upload(), fail: t.boolean() }),
  result: t.object({
    stored: file,
    recorded: t.boolean(),
    reason: t.nullable(t.text()),
    measured: t.number(),
    claimed: t.text()
  }),
  errors: ["too_large"],
  handler: async (ctx, args) => {
    if (args.file.size > 2_000_000) throw new HandlerError("too_large");
    const entry = await ctx.files.dealFiles.put(`${args.dealId}/${args.name}`, args.file);
    const stored = {
      name: args.name,
      size: entry.size,
      contentType: entry.contentType,
      handle: entry.handle
    };
    const seen = { measured: args.file.size, claimed: args.file.contentType };
    try {
      await ctx.run.attachments.record({ dealId: args.dealId, name: args.name, fail: args.fail });
      return { stored, recorded: true, reason: null, ...seen };
    } catch (error) {
      if (isHandlerError(error)) return { stored, recorded: false, reason: error.code, ...seen };
      throw error;
    }
  }
});

/** The file itself, read back from the store (what a retry would find). */
export const stored = query({
  args: t.object({ dealId: t.text(), name: t.text() }),
  result: t.nullable(file),
  handler: async (ctx, { dealId, name }) => {
    const entry = await ctx.files.dealFiles.stat(`${dealId}/${name}`);
    return entry === null
      ? null
      : { name, size: entry.size, contentType: entry.contentType, handle: entry.handle };
  }
});
