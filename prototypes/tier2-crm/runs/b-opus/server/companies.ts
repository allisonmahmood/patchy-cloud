import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import { assertOwner, canSee, member } from "../shared/access.js";
import { companyKey } from "../shared/rules.js";

/** Every company, by name. Everyone on the team sees all of them. */
export const list = query({
  args: t.object({}),
  result: t.array(t.row("companies")),
  handler: async (ctx) => {
    const { rows } = await ctx.tables.companies.list({ limit: 1000 });
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }
});

/** One company's page: its contacts and the deals this viewer may see. */
export const get = query({
  args: t.object({ id: t.ref("companies") }),
  result: t.object({
    company: t.row("companies"),
    contacts: t.array(t.row("contacts")),
    deals: t.array(t.row("deals"))
  }),
  errors: ["not_found"],
  handler: async (ctx, { id }) => {
    const company = await ctx.tables.companies.get(id);
    if (company === null) throw new HandlerError("not_found");
    const [contacts, deals] = await Promise.all([
      ctx.tables.contacts.list({ index: "companyId", eq: { companyId: id }, limit: 1000 }),
      ctx.tables.deals.list({ index: "companyId", eq: { companyId: id }, limit: 1000 })
    ]);
    return {
      company,
      contacts: [...contacts.rows].sort((a, b) => a.lastName.localeCompare(b.lastName)),
      deals: deals.rows.filter((deal) => canSee(deal, ctx.viewer))
    };
  }
});

export const create = mutation({
  args: t.object({ name: t.text() }),
  result: t.row("companies"),
  errors: ["empty_name", "duplicate_name"],
  handler: async (ctx, { name }) => {
    const nameKey = companyKey(name);
    if (nameKey === "") throw new HandlerError("empty_name");
    const { rows } = await ctx.tables.companies.list({
      index: "byNameKey",
      eq: { nameKey },
      limit: 1
    });
    if (rows.length > 0) throw new HandlerError("duplicate_name");
    const { id, name: ownerName } = ctx.viewer.user;
    return ctx.tables.companies.insert({
      name: name.trim().replace(/\s+/g, " "),
      nameKey,
      ownerId: id,
      ownerName
    });
  }
});

export const rename = mutation({
  args: t.object({ id: t.ref("companies"), name: t.text() }),
  result: t.row("companies"),
  errors: ["not_found", "not_owner", "empty_name", "duplicate_name"],
  handler: async (ctx, { id, name }) => {
    assertOwner(await ctx.tables.companies.get(id), ctx.viewer);
    const nameKey = companyKey(name);
    if (nameKey === "") throw new HandlerError("empty_name");
    const { rows } = await ctx.tables.companies.list({
      index: "byNameKey",
      eq: { nameKey },
      limit: 1
    });
    if (rows.some((row) => row.id !== id)) throw new HandlerError("duplicate_name");
    return ctx.tables.companies.update(id, { name: name.trim().replace(/\s+/g, " "), nameKey });
  }
});

export const handoff = mutation({
  args: t.object({ id: t.ref("companies"), userId: t.text() }),
  result: t.row("companies"),
  errors: ["not_found", "not_owner", "unknown_member"],
  handler: async (ctx, { id, userId }) => {
    assertOwner(await ctx.tables.companies.get(id), ctx.viewer);
    const to = await member(ctx.tables, userId);
    return ctx.tables.companies.update(id, { ownerId: to.userId, ownerName: to.name });
  }
});

/** Deletes an empty company; one that still has contacts or deals (anyone's) is refused. */
export const remove = mutation({
  args: t.object({ id: t.ref("companies") }),
  result: t.nullable(t.text()),
  errors: ["not_found", "not_owner", "in_use"],
  handler: async (ctx, { id }) => {
    assertOwner(await ctx.tables.companies.get(id), ctx.viewer);
    const [contacts, deals] = await Promise.all([
      ctx.tables.contacts.list({ index: "companyId", eq: { companyId: id }, limit: 1 }),
      ctx.tables.deals.list({ index: "companyId", eq: { companyId: id }, limit: 1 })
    ]);
    if (contacts.rows.length > 0 || deals.rows.length > 0) throw new HandlerError("in_use");
    await ctx.tables.companies.delete(id);
    return null;
  }
});
