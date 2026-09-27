import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import { company, owner, required, teammate } from "../lib/records.js";

const errors = [
  "not_found",
  "owner_only",
  "invalid_value",
  "unknown_teammate",
  "company_in_use",
  "duplicate_company"
] as const;
export const list = query({
  args: t.object({ search: t.text().optional(), cursor: t.text().optional() }),
  result: t.object({ rows: t.array(t.row("companies")), cursor: t.nullable(t.text()) }),
  handler: async (ctx, { search, cursor }) => {
    const prefix = (search ?? "").trim().toLowerCase();
    return ctx.tables.companies.list({
      index: "byName",
      order: "asc",
      limit: 50,
      ...(prefix ? { range: { column: "nameKey", gte: prefix, lt: prefix + "\uffff" } } : {}),
      ...(cursor ? { cursor } : {})
    });
  }
});
export const get = query({
  args: t.object({ id: t.ref("companies") }),
  result: t.row("companies"),
  errors,
  handler: (ctx, { id }) => company(ctx, id)
});
export const save = mutation({
  args: t.object({
    id: t.ref("companies").optional(),
    name: t.text(),
    ownerId: t.text().optional()
  }),
  result: t.row("companies"),
  errors,
  handler: async (ctx, args) => {
    const name = required(args.name, "name");
    const nameKey = name.toLowerCase();
    if (args.id) owner(ctx, await company(ctx, args.id));
    const duplicate = (
      await ctx.tables.companies.list({ index: "byName", eq: { nameKey }, limit: 1 })
    ).rows[0];
    if (duplicate && duplicate.id !== args.id) throw new HandlerError("duplicate_company");
    if (!args.id)
      return ctx.tables.companies.insert({ name, nameKey, ownerId: ctx.viewer.user.id });
    if (args.ownerId) await teammate(ctx, args.ownerId);
    return ctx.tables.companies.update(args.id, {
      name,
      nameKey,
      ...(args.ownerId ? { ownerId: args.ownerId } : {})
    });
  }
});
export const remove = mutation({
  args: t.object({ id: t.ref("companies") }),
  result: t.boolean(),
  errors,
  handler: async (ctx, { id }) => {
    owner(ctx, await company(ctx, id));
    const contacts = await ctx.tables.contacts.list({
      index: "byCompany",
      eq: { companyId: id },
      limit: 1
    });
    const deals = await ctx.tables.deals.list({
      index: "byCompany",
      eq: { companyId: id },
      limit: 1
    });
    if (contacts.rows.length || deals.rows.length) throw new HandlerError("company_in_use");
    await ctx.tables.companies.delete(id);
    return true;
  }
});
