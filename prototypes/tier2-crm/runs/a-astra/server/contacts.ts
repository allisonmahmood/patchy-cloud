import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import { company, owner, teammate, emailAddress } from "../lib/records.js";

const errors = [
  "not_found",
  "owner_only",
  "unknown_teammate",
  "invalid_email",
  "duplicate_email",
  "invalid_value"
] as const;
export const list = query({
  args: t.object({ companyId: t.ref("companies").optional(), cursor: t.text().optional() }),
  result: t.object({
    rows: t.array(t.row("contacts")),
    companies: t.array(t.row("companies")),
    cursor: t.nullable(t.text())
  }),
  handler: async (ctx, { companyId, cursor }) => {
    const window = { limit: 50, ...(cursor ? { cursor } : {}) };
    const page = await ctx.tables.contacts.list(
      companyId ? { ...window, index: "byCompany", eq: { companyId } } : window
    );
    const companies = (
      await ctx.tables.companies.getMany([...new Set(page.rows.map((row) => row.companyId))])
    ).filter((row) => row !== null);
    return { ...page, companies };
  }
});
export const save = mutation({
  args: t.object({
    id: t.ref("contacts").optional(),
    firstName: t.text(),
    lastName: t.text(),
    email: t.text(),
    companyId: t.ref("companies"),
    title: t.text(),
    phone: t.text(),
    ownerId: t.text().optional()
  }),
  result: t.row("contacts"),
  errors,
  handler: async (ctx, args) => {
    if (args.id) {
      const row = await ctx.tables.contacts.get(args.id);
      if (!row) throw new HandlerError("not_found");
      owner(ctx, row);
    }
    await company(ctx, args.companyId);
    const email = emailAddress(args.email);
    const duplicate = (
      await ctx.tables.contacts.list({ index: "byEmail", eq: { email }, limit: 1 })
    ).rows[0];
    if (duplicate && duplicate.id !== args.id) throw new HandlerError("duplicate_email");
    for (const value of [args.firstName, args.lastName, args.title, args.phone])
      if (value.length > 300) throw new HandlerError("invalid_value");
    const values = {
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      email,
      companyId: args.companyId,
      title: args.title.trim(),
      phone: args.phone.trim()
    };
    if (!args.id) return ctx.tables.contacts.insert({ ...values, ownerId: ctx.viewer.user.id });
    if (args.ownerId) await teammate(ctx, args.ownerId);
    return ctx.tables.contacts.update(args.id, {
      ...values,
      ...(args.ownerId ? { ownerId: args.ownerId } : {})
    });
  }
});
export const remove = mutation({
  args: t.object({ id: t.ref("contacts") }),
  result: t.boolean(),
  errors,
  handler: async (ctx, { id }) => {
    const row = await ctx.tables.contacts.get(id);
    if (!row) throw new HandlerError("not_found");
    owner(ctx, row);
    await ctx.tables.contacts.delete(id);
    return true;
  }
});
