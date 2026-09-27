import { query, mutation, action, t, HandlerError } from "../patchy/_generated/server.js";
import { assertOwner, member, visibleDeal } from "../shared/access.js";
import { STAGES } from "../shared/rules.js";

const stage = t.enum(STAGES);

/**
 * Every deal this viewer may see (all shared deals plus their own private ones), each with its
 * company's name. The pipeline board subscribes to it, so a move by anyone shows up live.
 */
export const pipeline = query({
  args: t.object({}),
  result: t.array(t.object({ deal: t.row("deals"), companyName: t.text() })),
  handler: async (ctx) => {
    const [shared, mine] = await Promise.all([
      ctx.tables.deals.list({ index: "byPrivate", eq: { private: false }, limit: 1000 }),
      ctx.tables.deals.list({
        index: "byOwnerPrivate",
        eq: { ownerId: ctx.viewer.user.id, private: true },
        limit: 1000
      })
    ]);
    const deals = [...shared.rows, ...mine.rows].sort((a, b) => b.valueCents - a.valueCents);
    const companies = await ctx.tables.companies.getMany([
      ...new Set(deals.map((deal) => deal.companyId))
    ]);
    const names = new Map(
      companies.flatMap((company) => (company ? [[company.id, company.name] as const] : []))
    );
    return deals.map((deal) => ({
      deal,
      companyName: names.get(deal.companyId) ?? "(deleted company)"
    }));
  }
});

/** One deal, or `not_found` if it does not exist or is someone else's private deal. */
export const get = query({
  args: t.object({ id: t.ref("deals") }),
  result: t.object({ deal: t.row("deals"), company: t.nullable(t.row("companies")) }),
  errors: ["not_found"],
  handler: async (ctx, { id }) => {
    const deal = await visibleDeal(ctx.tables, ctx.viewer, id);
    return { deal, company: await ctx.tables.companies.get(deal.companyId) };
  }
});

const editable = {
  title: t.text(),
  companyId: t.ref("companies"),
  valueCents: t.integer(),
  stage,
  private: t.boolean()
};

/** Title and company exist, value is a non-negative whole number of cents. */
function checkDeal(fields: { title: string; valueCents: number }) {
  if (fields.title.trim() === "") throw new HandlerError("empty_title");
  if (!Number.isSafeInteger(fields.valueCents) || fields.valueCents < 0)
    throw new HandlerError("invalid_value");
}

export const create = mutation({
  args: t.object(editable),
  result: t.row("deals"),
  errors: ["empty_title", "invalid_value", "not_found"],
  handler: async (ctx, args) => {
    checkDeal(args);
    if ((await ctx.tables.companies.get(args.companyId)) === null)
      throw new HandlerError("not_found");
    return ctx.tables.deals.insert({
      ...args,
      title: args.title.trim(),
      ownerId: ctx.viewer.user.id,
      ownerName: ctx.viewer.user.name
    });
  }
});

export const update = mutation({
  args: t.object({ id: t.ref("deals"), ...editable }),
  result: t.row("deals"),
  errors: ["empty_title", "invalid_value", "not_found", "not_owner"],
  handler: async (ctx, { id, ...args }) => {
    assertOwner(await visibleDeal(ctx.tables, ctx.viewer, id), ctx.viewer);
    checkDeal(args);
    if ((await ctx.tables.companies.get(args.companyId)) === null)
      throw new HandlerError("not_found");
    return ctx.tables.deals.update(id, { ...args, title: args.title.trim() });
  }
});

/** Moves a deal to another stage; the board's drag and drop calls this. */
export const move = mutation({
  args: t.object({ id: t.ref("deals"), stage }),
  result: t.row("deals"),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { id, stage }) => {
    assertOwner(await visibleDeal(ctx.tables, ctx.viewer, id), ctx.viewer);
    return ctx.tables.deals.update(id, { stage });
  }
});

/** Hands the deal to a teammate. A private deal stays private, now visible only to its new owner. */
export const handoff = mutation({
  args: t.object({ id: t.ref("deals"), userId: t.text() }),
  result: t.row("deals"),
  errors: ["not_found", "not_owner", "unknown_member"],
  handler: async (ctx, { id, userId }) => {
    assertOwner(await visibleDeal(ctx.tables, ctx.viewer, id), ctx.viewer);
    const to = await member(ctx.tables, userId);
    return ctx.tables.deals.update(id, { ownerId: to.userId, ownerName: to.name });
  }
});

/**
 * Deletes a deal with its attachments: files first, then their records, then the deal. It is an
 * action because file deletes are not transactional; the result says how far it got.
 */
export const remove = action({
  args: t.object({ id: t.ref("deals") }),
  result: t.object({ filesRemoved: t.integer(), dealRemoved: t.boolean() }),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { id }) => {
    assertOwner(await visibleDeal(ctx.tables, ctx.viewer, id), ctx.viewer);
    let filesRemoved = 0;
    try {
      const { files } = await ctx.files.dealFiles.list({ prefix: `${id}/`, limit: 1000 });
      for (const file of files) if (await ctx.files.dealFiles.delete(file.name)) filesRemoved++;
      const { rows } = await ctx.tables.attachments.list({
        index: "dealId",
        eq: { dealId: id },
        limit: 1000
      });
      for (const row of rows) await ctx.tables.attachments.delete(row.id);
      await ctx.tables.deals.delete(id);
    } catch (error) {
      ctx.log("deal delete stopped partway", { id, filesRemoved, error: String(error) });
      return { filesRemoved, dealRemoved: false };
    }
    return { filesRemoved, dealRemoved: true };
  }
});
