import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import { keyOf, requireOwner, canSee } from "../lib/rules.js";

/** Every company, by name. Everyone on the team sees all companies. */
export const list = query({
  args: t.object({}),
  result: t.array(t.row("companies")),
  handler: async (ctx) =>
    (await ctx.tables.companies.list({ index: "byName", order: "asc", limit: 1000 })).rows
});

/** One company with its contacts and the deals the viewer may see; null when it does not exist. */
export const get = query({
  args: t.object({ id: t.ref("companies") }),
  result: t.nullable(
    t.object({
      company: t.row("companies"),
      contacts: t.array(t.row("contacts")),
      deals: t.array(t.row("deals"))
    })
  ),
  handler: async (ctx, { id }) => {
    const company = await ctx.tables.companies.get(id);
    if (!company) return null;
    const [contacts, deals] = await Promise.all([
      ctx.tables.contacts.list({ index: "company", eq: { company: company.id }, limit: 1000 }),
      ctx.tables.deals.list({ index: "company", eq: { company: company.id }, limit: 1000 })
    ]);
    return {
      company,
      contacts: contacts.rows,
      deals: deals.rows.filter((deal) => canSee(deal, ctx.viewer.user.id))
    };
  }
});

/** Creates a company owned by the viewer; names are unique ignoring case. */
export const create = mutation({
  args: t.object({ name: t.text(), website: t.text().optional() }),
  result: t.row("companies"),
  errors: ["empty_name", "duplicate_name"],
  handler: async (ctx, { name, website }) => {
    if (name.trim() === "") throw new HandlerError("empty_name");
    const nameKey = keyOf(name);
    const clash = await ctx.tables.companies.list({
      index: "byNameKey",
      eq: { nameKey },
      limit: 1
    });
    if (clash.rows.length > 0) throw new HandlerError("duplicate_name");
    return ctx.tables.companies.insert({
      name: name.trim(),
      nameKey,
      website: website?.trim() || null,
      ownerId: ctx.viewer.user.id
    });
  }
});

/** Owner-only edit of name and website. */
export const update = mutation({
  args: t.object({ id: t.ref("companies"), name: t.text(), website: t.text().optional() }),
  result: t.row("companies"),
  errors: ["not_found", "not_owner", "empty_name", "duplicate_name"],
  handler: async (ctx, { id, name, website }) => {
    const company = await ctx.tables.companies.get(id);
    if (!company) throw new HandlerError("not_found");
    requireOwner(company, ctx.viewer.user.id);
    if (name.trim() === "") throw new HandlerError("empty_name");
    const nameKey = keyOf(name);
    const clash = await ctx.tables.companies.list({
      index: "byNameKey",
      eq: { nameKey },
      limit: 1
    });
    if (clash.rows.some((row) => row.id !== id)) throw new HandlerError("duplicate_name");
    return ctx.tables.companies.update(id, {
      name: name.trim(),
      nameKey,
      website: website?.trim() || null
    });
  }
});

/** Owner-only delete; refused while any contact or deal (including others' private deals) points at it. */
export const remove = mutation({
  args: t.object({ id: t.ref("companies") }),
  result: t.nullable(t.text()),
  errors: ["not_found", "not_owner", "in_use"],
  handler: async (ctx, { id }) => {
    const company = await ctx.tables.companies.get(id);
    if (!company) throw new HandlerError("not_found");
    requireOwner(company, ctx.viewer.user.id);
    const [contacts, deals] = await Promise.all([
      ctx.tables.contacts.list({ index: "company", eq: { company: id }, limit: 1 }),
      ctx.tables.deals.list({ index: "company", eq: { company: id }, limit: 1 })
    ]);
    if (contacts.rows.length + deals.rows.length > 0) throw new HandlerError("in_use");
    await ctx.tables.companies.delete(id);
    return null;
  }
});

/** Owner hands the company to a teammate who has opened the CRM. */
export const transfer = mutation({
  args: t.object({ id: t.ref("companies"), toUserId: t.text() }),
  result: t.row("companies"),
  errors: ["not_found", "not_owner", "unknown_member"],
  handler: async (ctx, { id, toUserId }) => {
    const company = await ctx.tables.companies.get(id);
    if (!company) throw new HandlerError("not_found");
    requireOwner(company, ctx.viewer.user.id);
    const member = await ctx.tables.members.list({
      index: "byUser",
      eq: { userId: toUserId },
      limit: 1
    });
    if (member.rows.length === 0) throw new HandlerError("unknown_member");
    return ctx.tables.companies.update(id, { ownerId: toUserId });
  }
});
