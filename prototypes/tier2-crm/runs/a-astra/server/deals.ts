import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import { company, deal, owner, required, stages, teammate } from "../lib/records.js";
import type { Company } from "../lib/models.js";

const errors = ["not_found", "owner_only", "unknown_teammate", "invalid_value"] as const;
export const list = query({
  args: t.object({
    stage: t.enum(stages).optional(),
    companyId: t.ref("companies").optional(),
    cursor: t.text().optional()
  }),
  result: t.object({
    rows: t.array(t.row("deals")),
    companies: t.array(t.row("companies")),
    cursor: t.nullable(t.text())
  }),
  handler: async (ctx, { stage, companyId, cursor }) => {
    const page = await ctx.tables.deals.list({
      limit: 50,
      ...(companyId
        ? { index: "byCompany", eq: { companyId } }
        : stage
          ? { index: "byStage", eq: { stage } }
          : {}),
      ...(cursor ? { cursor } : {})
    });
    const rows = page.rows.filter(
      (row) =>
        (!row.private || row.ownerId === ctx.viewer.user.id) && (!stage || row.stage === stage)
    );
    const companies = (
      await ctx.tables.companies.getMany([...new Set(rows.map((row) => row.companyId))])
    ).filter((row) => row !== null);
    return { rows, companies, cursor: page.cursor };
  }
});

export const pipeline = query({
  args: t.object({
    view: t.enum(["open", "closed"]),
    cursors: t.object({
      Lead: t.text().optional(),
      Qualified: t.text().optional(),
      Proposal: t.text().optional(),
      Won: t.text().optional(),
      Lost: t.text().optional()
    })
  }),
  result: t.object({
    lanes: t.array(
      t.object({
        stage: t.enum(stages),
        rows: t.array(t.row("deals")),
        cursor: t.nullable(t.text())
      })
    ),
    companies: t.array(t.row("companies"))
  }),
  handler: async (ctx, { view, cursors }) => {
    // One snapshot prevents cards appearing in both lanes during a move.
    const lanes = [];
    const companyIds = new Set<Company["id"]>();
    for (const stage of view === "open" ? stages.slice(0, 3) : stages.slice(3)) {
      const cursor = cursors[stage];
      const page = await ctx.tables.deals.list({
        index: "byStage",
        eq: { stage },
        limit: 50,
        ...(cursor ? { cursor } : {})
      });
      const rows = page.rows.filter((row) => !row.private || row.ownerId === ctx.viewer.user.id);
      for (const row of rows) companyIds.add(row.companyId);
      lanes.push({ stage, rows, cursor: page.cursor });
    }
    const companies = (await ctx.tables.companies.getMany([...companyIds])).filter(
      (row) => row !== null
    );
    return { lanes, companies };
  }
});
export const get = query({
  args: t.object({ id: t.ref("deals") }),
  result: t.row("deals"),
  errors,
  handler: (ctx, { id }) => deal(ctx, id)
});
export const save = mutation({
  args: t.object({
    id: t.ref("deals").optional(),
    title: t.text(),
    companyId: t.ref("companies"),
    valueCents: t.integer(),
    stage: t.enum(stages),
    private: t.boolean(),
    ownerId: t.text().optional()
  }),
  result: t.row("deals"),
  errors,
  handler: async (ctx, args) => {
    if (args.id) owner(ctx, await deal(ctx, args.id));
    await company(ctx, args.companyId);
    if (
      !Number.isSafeInteger(args.valueCents) ||
      args.valueCents < 0 ||
      args.valueCents > 2_000_000_000
    )
      throw new HandlerError("invalid_value", { field: "value" });
    const values = {
      title: required(args.title, "title"),
      companyId: args.companyId,
      valueCents: args.valueCents,
      stage: args.stage,
      private: args.private
    };
    if (!args.id) return ctx.tables.deals.insert({ ...values, ownerId: ctx.viewer.user.id });
    if (args.ownerId) await teammate(ctx, args.ownerId);
    return ctx.tables.deals.update(args.id, {
      ...values,
      ...(args.ownerId ? { ownerId: args.ownerId } : {})
    });
  }
});
export const move = mutation({
  args: t.object({ id: t.ref("deals"), stage: t.enum(stages) }),
  result: t.row("deals"),
  errors,
  handler: async (ctx, { id, stage }) => {
    owner(ctx, await deal(ctx, id));
    return ctx.tables.deals.update(id, { stage });
  }
});
export const remove = mutation({
  args: t.object({ id: t.ref("deals") }),
  result: t.boolean(),
  errors,
  handler: async (ctx, { id }) => {
    owner(ctx, await deal(ctx, id));
    await ctx.tables.deals.delete(id);
    return true;
  }
});
