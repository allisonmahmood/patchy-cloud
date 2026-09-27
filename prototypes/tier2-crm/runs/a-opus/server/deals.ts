import { query, mutation, action, t, HandlerError } from "../patchy/_generated/server.js";
import { STAGES, OPEN_STAGES, requireOwner, canSee } from "../lib/rules.js";

const stage = t.enum(STAGES);

/** Open deals (Lead, Qualified, Proposal) the viewer may see; the page subscribes for the live board. */
export const pipeline = query({
  args: t.object({}),
  result: t.array(t.row("deals")),
  handler: async (ctx) => {
    const pages = await Promise.all(
      OPEN_STAGES.map((stage) =>
        ctx.tables.deals.list({ index: "byStage", eq: { stage }, limit: 1000 })
      )
    );
    return pages.flatMap((page) => page.rows).filter((deal) => canSee(deal, ctx.viewer.user.id));
  }
});

/** Every deal the viewer may see, open or closed, newest first. */
export const list = query({
  args: t.object({}),
  result: t.array(t.row("deals")),
  handler: async (ctx) =>
    (await ctx.tables.deals.list({ limit: 1000 })).rows.filter((deal) =>
      canSee(deal, ctx.viewer.user.id)
    )
});

/** One deal, or null when it does not exist or is someone else's private deal. */
export const get = query({
  args: t.object({ id: t.ref("deals") }),
  result: t.nullable(t.row("deals")),
  handler: async (ctx, { id }) => {
    const deal = await ctx.tables.deals.get(id);
    return deal && canSee(deal, ctx.viewer.user.id) ? deal : null;
  }
});

const fields = {
  title: t.text(),
  company: t.ref("companies"),
  valueCents: t.integer(),
  stage,
  private: t.boolean()
};

function validate(input: { readonly title: string; readonly valueCents: number }) {
  if (input.title.trim() === "") throw new HandlerError("empty_title");
  if (!Number.isSafeInteger(input.valueCents) || input.valueCents < 0)
    throw new HandlerError("invalid_value");
}

/** Creates a deal owned by the viewer. */
export const create = mutation({
  args: t.object(fields),
  result: t.row("deals"),
  errors: ["empty_title", "invalid_value", "no_company"],
  handler: async (ctx, input) => {
    validate(input);
    if (!(await ctx.tables.companies.get(input.company))) throw new HandlerError("no_company");
    return ctx.tables.deals.insert({
      ...input,
      title: input.title.trim(),
      ownerId: ctx.viewer.user.id
    });
  }
});

/** Owner-only edit of every field. */
export const update = mutation({
  args: t.object({ id: t.ref("deals"), ...fields }),
  result: t.row("deals"),
  errors: ["not_found", "not_owner", "empty_title", "invalid_value", "no_company"],
  handler: async (ctx, { id, ...input }) => {
    const deal = await ctx.tables.deals.get(id);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    validate(input);
    if (!(await ctx.tables.companies.get(input.company))) throw new HandlerError("no_company");
    return ctx.tables.deals.update(id, { ...input, title: input.title.trim() });
  }
});

/** Owner moves a deal to another stage; subscribed boards update for everyone who can see it. */
export const move = mutation({
  args: t.object({ id: t.ref("deals"), stage }),
  result: t.row("deals"),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { id, stage }) => {
    const deal = await ctx.tables.deals.get(id);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    return ctx.tables.deals.update(id, { stage });
  }
});

/** Owner hands the deal to a teammate who has opened the CRM (a private deal goes private to them). */
export const transfer = mutation({
  args: t.object({ id: t.ref("deals"), toUserId: t.text() }),
  result: t.row("deals"),
  errors: ["not_found", "not_owner", "unknown_member"],
  handler: async (ctx, { id, toUserId }) => {
    const deal = await ctx.tables.deals.get(id);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    const member = await ctx.tables.members.list({
      index: "byUser",
      eq: { userId: toUserId },
      limit: 1
    });
    if (member.rows.length === 0) throw new HandlerError("unknown_member");
    return ctx.tables.deals.update(id, { ownerId: toUserId });
  }
});

/** Deletes the deal row and its attachment records; `remove` calls it after deleting the files. */
export const destroy = mutation({
  args: t.object({ id: t.ref("deals") }),
  result: t.nullable(t.text()),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { id }) => {
    const deal = await ctx.tables.deals.get(id);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    const records = await ctx.tables.dealFiles.list({
      index: "deal",
      eq: { deal: id },
      limit: 1000
    });
    for (const record of records.rows) await ctx.tables.dealFiles.delete(record.id);
    await ctx.tables.deals.delete(id);
    return null;
  }
});

/**
 * Owner deletes a deal: first its attachment files, then (one transaction) its records and the row.
 * Files and rows cannot share a transaction, so the result says how far it got.
 */
export const remove = action({
  args: t.object({ id: t.ref("deals") }),
  result: t.object({ filesRemoved: t.integer(), filesLeft: t.integer(), dealRemoved: t.boolean() }),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { id }) => {
    const deal = await ctx.tables.deals.get(id);
    if (!deal || !canSee(deal, ctx.viewer.user.id)) throw new HandlerError("not_found");
    requireOwner(deal, ctx.viewer.user.id);
    const { files } = await ctx.files.attachments.list({ prefix: `${id}/`, limit: 1000 });
    let filesRemoved = 0;
    for (const file of files) {
      try {
        await ctx.files.attachments.delete(file.name);
        filesRemoved++;
      } catch (cause) {
        ctx.log("attachment delete failed", { name: file.name, cause: String(cause) });
      }
    }
    const filesLeft = files.length - filesRemoved;
    if (filesLeft > 0) return { filesRemoved, filesLeft, dealRemoved: false };
    try {
      await ctx.run.deals!.destroy!({ id });
      return { filesRemoved, filesLeft, dealRemoved: true };
    } catch (cause) {
      ctx.log("deal row delete failed after its files were removed", { id, cause: String(cause) });
      return { filesRemoved, filesLeft, dealRemoved: false };
    }
  }
});
