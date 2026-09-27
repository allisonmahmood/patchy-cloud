import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import { required, owner, targetOwner, companyExists, emailAddress } from "../lib/records.js";

const paging = { search: t.text().optional(), cursor: t.text().optional() };
const companyFields = { name: t.text(), website: t.text(), notes: t.text() };
const contactFields = {
  firstName: t.text(),
  lastName: t.text(),
  email: t.text(),
  title: t.text(),
  phone: t.text(),
  companyId: t.ref("companies")
};
const writeErrors = [
  "not_found",
  "not_owner",
  "invalid_input",
  "unknown_teammate",
  "company_not_found",
  "invalid_email",
  "duplicate_email",
  "duplicate_company"
] as const;

export const join = mutation({
  args: t.object({}),
  result: t.row("members"),
  handler: async (ctx) => {
    const user = ctx.viewer.user;
    const found = (
      await ctx.tables.members.list({ index: "byUser", eq: { userId: user.id }, limit: 1 })
    ).rows[0];
    if (found && found.name === user.name && found.email === user.email) return found;
    return found
      ? ctx.tables.members.update(found.id, { name: user.name, email: user.email })
      : ctx.tables.members.insert({ userId: user.id, name: user.name, email: user.email });
  }
});
export const team = query({
  args: t.object({}),
  result: t.object({ viewerId: t.text(), members: t.array(t.row("members")) }),
  handler: async (ctx) => ({
    viewerId: ctx.viewer.user.id,
    members: (await ctx.tables.members.list({ limit: 1000 })).rows
  })
});
export const companies = query({
  args: t.object(paging),
  result: t.object({ rows: t.array(t.row("companies")), cursor: t.nullable(t.text()) }),
  handler: async (ctx, { search = "", cursor }) => {
    const key = search.trim().toLowerCase();
    return ctx.tables.companies.list({
      index: "byName",
      ...(key ? { range: { column: "nameKey", gte: key, lt: key + "\uffff" } } : {}),
      order: "asc",
      limit: 50,
      ...(cursor ? { cursor } : {})
    });
  }
});
export const company = query({
  args: t.object({ id: t.ref("companies") }),
  result: t.nullable(t.row("companies")),
  handler: (ctx, { id }) => ctx.tables.companies.get(id)
});
export const createCompany = mutation({
  args: t.object(companyFields),
  result: t.row("companies"),
  errors: writeErrors,
  handler: async (ctx, args) => {
    const name = required(args.name, "name");
    const nameKey = name.toLowerCase();
    if (
      (await ctx.tables.companies.list({ index: "byName", eq: { nameKey }, limit: 1 })).rows.length
    )
      throw new HandlerError("duplicate_company");
    return ctx.tables.companies.insert({ ...args, name, nameKey, ownerId: ctx.viewer.user.id });
  }
});
export const updateCompany = mutation({
  args: t.object({ id: t.ref("companies"), ...companyFields }),
  result: t.row("companies"),
  errors: writeErrors,
  handler: async (ctx, { id, ...args }) => {
    owner(await ctx.tables.companies.get(id), ctx.viewer.user.id);
    const name = required(args.name, "name");
    const nameKey = name.toLowerCase();
    const match = (await ctx.tables.companies.list({ index: "byName", eq: { nameKey }, limit: 1 }))
      .rows[0];
    if (match && match.id !== id) throw new HandlerError("duplicate_company");
    return ctx.tables.companies.update(id, { ...args, name, nameKey });
  }
});
export const reassignCompany = mutation({
  args: t.object({ id: t.ref("companies"), ownerId: t.text() }),
  result: t.row("companies"),
  errors: writeErrors,
  handler: async (ctx, args) => {
    owner(await ctx.tables.companies.get(args.id), ctx.viewer.user.id);
    return ctx.tables.companies.update(args.id, {
      ownerId: await targetOwner(ctx.tables, args.ownerId)
    });
  }
});
export const deleteCompany = mutation({
  args: t.object({ id: t.ref("companies") }),
  result: t.boolean(),
  errors: [...writeErrors, "company_in_use"],
  handler: async (ctx, { id }) => {
    owner(await ctx.tables.companies.get(id), ctx.viewer.user.id);
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
export const contacts = query({
  args: t.object({ ...paging, companyId: t.ref("companies").optional() }),
  result: t.object({
    rows: t.array(t.object({ contact: t.row("contacts"), companyName: t.text() })),
    cursor: t.nullable(t.text())
  }),
  handler: async (ctx, { search = "", cursor, companyId }) => {
    const key = search.trim().toLowerCase();
    const page = await ctx.tables.contacts.list({
      ...(companyId
        ? { index: "byCompany" as const, eq: { companyId } }
        : {
            index: "byEmail" as const,
            ...(key ? { range: { column: "email" as const, gte: key, lt: key + "\uffff" } } : {})
          }),
      order: "asc",
      limit: 50,
      ...(cursor ? { cursor } : {})
    });
    const companies = await ctx.tables.companies.getMany(page.rows.map((row) => row.companyId));
    return {
      rows: page.rows.map((contact, i) => ({
        contact,
        companyName: companies[i]?.name ?? "Company unavailable"
      })),
      cursor: page.cursor
    };
  }
});
export const createContact = mutation({
  args: t.object(contactFields),
  result: t.row("contacts"),
  errors: writeErrors,
  handler: async (ctx, args) => {
    const email = emailAddress(args.email);
    if (!args.firstName.trim() && !args.lastName.trim())
      throw new HandlerError("invalid_input", { field: "name" });
    await companyExists(ctx.tables, args.companyId);
    if ((await ctx.tables.contacts.list({ index: "byEmail", eq: { email }, limit: 1 })).rows.length)
      throw new HandlerError("duplicate_email");
    return ctx.tables.contacts.insert({
      ...args,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      email,
      ownerId: ctx.viewer.user.id
    });
  }
});
export const updateContact = mutation({
  args: t.object({ id: t.ref("contacts"), ...contactFields }),
  result: t.row("contacts"),
  errors: writeErrors,
  handler: async (ctx, { id, ...args }) => {
    owner(await ctx.tables.contacts.get(id), ctx.viewer.user.id);
    const email = emailAddress(args.email);
    if (!args.firstName.trim() && !args.lastName.trim())
      throw new HandlerError("invalid_input", { field: "name" });
    await companyExists(ctx.tables, args.companyId);
    const found = (await ctx.tables.contacts.list({ index: "byEmail", eq: { email }, limit: 1 }))
      .rows[0];
    if (found && found.id !== id) throw new HandlerError("duplicate_email");
    return ctx.tables.contacts.update(id, {
      ...args,
      firstName: args.firstName.trim(),
      lastName: args.lastName.trim(),
      email
    });
  }
});
export const reassignContact = mutation({
  args: t.object({ id: t.ref("contacts"), ownerId: t.text() }),
  result: t.row("contacts"),
  errors: writeErrors,
  handler: async (ctx, args) => {
    owner(await ctx.tables.contacts.get(args.id), ctx.viewer.user.id);
    return ctx.tables.contacts.update(args.id, {
      ownerId: await targetOwner(ctx.tables, args.ownerId)
    });
  }
});
export const deleteContact = mutation({
  args: t.object({ id: t.ref("contacts") }),
  result: t.boolean(),
  errors: writeErrors,
  handler: async (ctx, { id }) => {
    owner(await ctx.tables.contacts.get(id), ctx.viewer.user.id);
    await ctx.tables.contacts.delete(id);
    return true;
  }
});
