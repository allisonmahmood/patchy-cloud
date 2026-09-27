import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import { keyOf, isEmail, requireOwner } from "../lib/rules.js";

const fields = {
  firstName: t.text(),
  lastName: t.text(),
  email: t.text(),
  company: t.ref("companies"),
  title: t.text().optional(),
  phone: t.text().optional()
};

/** Every contact, newest first (first 1,000). */
export const list = query({
  args: t.object({}),
  result: t.array(t.row("contacts")),
  handler: async (ctx) => (await ctx.tables.contacts.list({ limit: 1000 })).rows
});

/** Creates a contact owned by the viewer. Emails are unique ignoring case. */
export const create = mutation({
  args: t.object(fields),
  result: t.row("contacts"),
  errors: ["invalid_email", "empty_name", "no_company", "duplicate_email"],
  handler: async (ctx, input) => {
    const email = input.email.trim();
    if (!isEmail(email)) throw new HandlerError("invalid_email");
    if (input.firstName.trim() === "" && input.lastName.trim() === "")
      throw new HandlerError("empty_name");
    if (!(await ctx.tables.companies.get(input.company))) throw new HandlerError("no_company");
    const emailKey = keyOf(email);
    if (
      (await ctx.tables.contacts.list({ index: "byEmailKey", eq: { emailKey }, limit: 1 })).rows
        .length > 0
    )
      throw new HandlerError("duplicate_email");
    return ctx.tables.contacts.insert({
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      email,
      emailKey,
      company: input.company,
      title: input.title?.trim() || null,
      phone: input.phone?.trim() || null,
      ownerId: ctx.viewer.user.id
    });
  }
});

/** Owner-only edit. */
export const update = mutation({
  args: t.object({ id: t.ref("contacts"), ...fields }),
  result: t.row("contacts"),
  errors: [
    "not_found",
    "not_owner",
    "invalid_email",
    "empty_name",
    "no_company",
    "duplicate_email"
  ],
  handler: async (ctx, { id, ...input }) => {
    const contact = await ctx.tables.contacts.get(id);
    if (!contact) throw new HandlerError("not_found");
    requireOwner(contact, ctx.viewer.user.id);
    const email = input.email.trim();
    if (!isEmail(email)) throw new HandlerError("invalid_email");
    if (input.firstName.trim() === "" && input.lastName.trim() === "")
      throw new HandlerError("empty_name");
    if (!(await ctx.tables.companies.get(input.company))) throw new HandlerError("no_company");
    const emailKey = keyOf(email);
    const clash = await ctx.tables.contacts.list({
      index: "byEmailKey",
      eq: { emailKey },
      limit: 1
    });
    if (clash.rows.some((row) => row.id !== id)) throw new HandlerError("duplicate_email");
    return ctx.tables.contacts.update(id, {
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      email,
      emailKey,
      company: input.company,
      title: input.title?.trim() || null,
      phone: input.phone?.trim() || null
    });
  }
});

/** Owner-only delete. */
export const remove = mutation({
  args: t.object({ id: t.ref("contacts") }),
  result: t.nullable(t.text()),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { id }) => {
    const contact = await ctx.tables.contacts.get(id);
    if (!contact) throw new HandlerError("not_found");
    requireOwner(contact, ctx.viewer.user.id);
    await ctx.tables.contacts.delete(id);
    return null;
  }
});

/** Owner hands the contact to a teammate who has opened the CRM. */
export const transfer = mutation({
  args: t.object({ id: t.ref("contacts"), toUserId: t.text() }),
  result: t.row("contacts"),
  errors: ["not_found", "not_owner", "unknown_member"],
  handler: async (ctx, { id, toUserId }) => {
    const contact = await ctx.tables.contacts.get(id);
    if (!contact) throw new HandlerError("not_found");
    requireOwner(contact, ctx.viewer.user.id);
    const member = await ctx.tables.members.list({
      index: "byUser",
      eq: { userId: toUserId },
      limit: 1
    });
    if (member.rows.length === 0) throw new HandlerError("unknown_member");
    return ctx.tables.contacts.update(id, { ownerId: toUserId });
  }
});
