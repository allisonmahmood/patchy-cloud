import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import {
  stages,
  required,
  owner,
  visibleDeal,
  targetOwner,
  companyExists
} from "../lib/records.js";
import type { Row } from "patchy/config";
import type config from "../patchy.config.js";

export interface PipelineColumnData {
  readonly stage: (typeof stages)[number];
  readonly rows: readonly {
    readonly deal: Row<typeof config, "deals">;
    readonly companyName: string;
  }[];
  readonly publicCursor: string | null;
  readonly privateCursor: string | null;
}

const fields = {
  title: t.text(),
  companyId: t.ref("companies"),
  valueCents: t.integer(),
  stage: t.enum(stages),
  private: t.boolean(),
  notes: t.text()
};
const errors = [
  "not_found",
  "not_owner",
  "invalid_input",
  "unknown_teammate",
  "company_not_found"
] as const;
const listedDeal = t.object({ deal: t.row("deals"), companyName: t.text() });

export const pipeline = query({
  args: t.object({
    pages: t.array(
      t.object({
        stage: t.enum(stages),
        publicCursor: t.nullable(t.text()).optional(),
        privateCursor: t.nullable(t.text()).optional()
      })
    )
  }),
  result: t.array(
    t.object({
      stage: t.enum(stages),
      rows: t.array(listedDeal),
      publicCursor: t.nullable(t.text()),
      privateCursor: t.nullable(t.text())
    })
  ),
  errors,
  handler: async (ctx, { pages }) => {
    if (pages.length > 5 || new Set(pages.map((page) => page.stage)).size !== pages.length)
      throw new HandlerError("invalid_input");
    // One snapshot keeps all displayed stages consistent and uses one live invocation per board.
    return Promise.all(
      pages.map(async (args) => {
        const publicPage =
          args.publicCursor === null
            ? { rows: [], cursor: null }
            : await ctx.tables.deals.list({
                index: "byPublicStage",
                eq: { private: false, stage: args.stage },
                limit: 50,
                ...(args.publicCursor ? { cursor: args.publicCursor } : {})
              });
        const ownedPage =
          args.privateCursor === null
            ? { rows: [], cursor: null }
            : await ctx.tables.deals.list({
                index: "byOwnerStage",
                eq: { ownerId: ctx.viewer.user.id, stage: args.stage },
                limit: 50,
                ...(args.privateCursor ? { cursor: args.privateCursor } : {})
              });
        const rows = [...publicPage.rows, ...ownedPage.rows.filter((deal) => deal.private)].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt)
        );
        const companies = await ctx.tables.companies.getMany(rows.map((row) => row.companyId));
        return {
          stage: args.stage,
          rows: rows.map((deal, i) => ({
            deal,
            companyName: companies[i]?.name ?? "Company unavailable"
          })),
          publicCursor: publicPage.cursor,
          privateCursor: ownedPage.cursor
        };
      })
    );
  }
});
export const detail = query({
  args: t.object({ id: t.ref("deals") }),
  result: listedDeal,
  errors,
  handler: async (ctx, { id }) => {
    const deal = await visibleDeal(ctx.tables, id, ctx.viewer.user.id);
    return {
      deal,
      companyName: (await ctx.tables.companies.get(deal.companyId))?.name ?? "Company unavailable"
    };
  }
});
export const forCompany = query({
  args: t.object({ companyId: t.ref("companies"), cursor: t.text().optional() }),
  result: t.object({ rows: t.array(t.row("deals")), cursor: t.nullable(t.text()) }),
  handler: async (ctx, { companyId, cursor }) => {
    const page = await ctx.tables.deals.list({
      index: "byCompany",
      eq: { companyId },
      limit: 50,
      ...(cursor ? { cursor } : {})
    });
    return {
      rows: page.rows.filter((deal) => !deal.private || deal.ownerId === ctx.viewer.user.id),
      cursor: page.cursor
    };
  }
});
export const create = mutation({
  args: t.object(fields),
  result: t.row("deals"),
  errors,
  handler: async (ctx, args) => {
    await companyExists(ctx.tables, args.companyId);
    if (!Number.isSafeInteger(args.valueCents) || args.valueCents < 0)
      throw new HandlerError("invalid_input", { field: "value" });
    return ctx.tables.deals.insert({
      ...args,
      title: required(args.title, "title"),
      ownerId: ctx.viewer.user.id
    });
  }
});
export const update = mutation({
  args: t.object({ id: t.ref("deals"), ...fields }),
  result: t.row("deals"),
  errors,
  handler: async (ctx, { id, ...args }) => {
    owner(await visibleDeal(ctx.tables, id, ctx.viewer.user.id), ctx.viewer.user.id);
    await companyExists(ctx.tables, args.companyId);
    if (!Number.isSafeInteger(args.valueCents) || args.valueCents < 0)
      throw new HandlerError("invalid_input", { field: "value" });
    return ctx.tables.deals.update(id, { ...args, title: required(args.title, "title") });
  }
});
export const move = mutation({
  args: t.object({ id: t.ref("deals"), stage: t.enum(stages) }),
  result: t.row("deals"),
  errors,
  handler: async (ctx, { id, stage }) => {
    owner(await visibleDeal(ctx.tables, id, ctx.viewer.user.id), ctx.viewer.user.id);
    return ctx.tables.deals.update(id, { stage });
  }
});
export const reassign = mutation({
  args: t.object({ id: t.ref("deals"), ownerId: t.text() }),
  result: t.row("deals"),
  errors,
  handler: async (ctx, args) => {
    owner(await visibleDeal(ctx.tables, args.id, ctx.viewer.user.id), ctx.viewer.user.id);
    return ctx.tables.deals.update(args.id, {
      ownerId: await targetOwner(ctx.tables, args.ownerId)
    });
  }
});
export const remove = mutation({
  args: t.object({ id: t.ref("deals") }),
  result: t.boolean(),
  errors,
  handler: async (ctx, { id }) => {
    owner(await visibleDeal(ctx.tables, id, ctx.viewer.user.id), ctx.viewer.user.id);
    await ctx.tables.deals.delete(id);
    return true;
  }
});
