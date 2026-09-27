import { query, mutation, t, HandlerError } from "../patchy/_generated/server.js";
import { all, assertOwner, member, type Tables } from "../shared/access.js";
import { companyKey, isValidEmail, normalizeEmail, parseCsv } from "../shared/rules.js";

const fields = {
  firstName: t.text(),
  lastName: t.text(),
  email: t.text(),
  companyId: t.ref("companies"),
  title: t.nullable(t.text()),
  phone: t.nullable(t.text())
};

/** One page of contacts, newest first, each with its company's name. */
export const list = query({
  args: t.object({ cursor: t.text().optional() }),
  result: t.object({
    rows: t.array(t.object({ contact: t.row("contacts"), companyName: t.text() })),
    cursor: t.nullable(t.text())
  }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.tables.contacts.list({
      limit: 50,
      ...(cursor === undefined ? {} : { cursor })
    });
    const companies = await ctx.tables.companies.getMany([
      ...new Set(page.rows.map((row) => row.companyId))
    ]);
    const names = new Map(
      companies.flatMap((company) => (company ? [[company.id, company.name] as const] : []))
    );
    return {
      rows: page.rows.map((contact) => ({
        contact,
        companyName: names.get(contact.companyId) ?? "(deleted company)"
      })),
      cursor: page.cursor
    };
  }
});

/** Trims names and optional fields, normalizes the email and checks it is new and valid. */
async function clean(
  tables: Tables,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    title: string | null;
    phone: string | null;
  },
  self?: string
) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new HandlerError("invalid_email");
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (firstName === "" && lastName === "") throw new HandlerError("empty_name");
  const { rows } = await tables.contacts.list({ index: "byEmail", eq: { email }, limit: 1 });
  if (rows.some((row) => row.id !== self)) throw new HandlerError("duplicate_email");
  const optional = (value: string | null) => (value?.trim() ? value.trim() : null);
  return { firstName, lastName, email, title: optional(input.title), phone: optional(input.phone) };
}

export const create = mutation({
  args: t.object(fields),
  result: t.row("contacts"),
  errors: ["invalid_email", "empty_name", "duplicate_email", "not_found"],
  handler: async (ctx, args) => {
    if ((await ctx.tables.companies.get(args.companyId)) === null)
      throw new HandlerError("not_found");
    const contact = await clean(ctx.tables, args);
    return ctx.tables.contacts.insert({
      ...contact,
      companyId: args.companyId,
      ownerId: ctx.viewer.user.id,
      ownerName: ctx.viewer.user.name
    });
  }
});

export const update = mutation({
  args: t.object({ id: t.ref("contacts"), ...fields }),
  result: t.row("contacts"),
  errors: ["invalid_email", "empty_name", "duplicate_email", "not_found", "not_owner"],
  handler: async (ctx, { id, ...args }) => {
    assertOwner(await ctx.tables.contacts.get(id), ctx.viewer);
    if ((await ctx.tables.companies.get(args.companyId)) === null)
      throw new HandlerError("not_found");
    const contact = await clean(ctx.tables, args, id);
    return ctx.tables.contacts.update(id, { ...contact, companyId: args.companyId });
  }
});

export const handoff = mutation({
  args: t.object({ id: t.ref("contacts"), userId: t.text() }),
  result: t.row("contacts"),
  errors: ["not_found", "not_owner", "unknown_member"],
  handler: async (ctx, { id, userId }) => {
    assertOwner(await ctx.tables.contacts.get(id), ctx.viewer);
    const to = await member(ctx.tables, userId);
    return ctx.tables.contacts.update(id, { ownerId: to.userId, ownerName: to.name });
  }
});

export const remove = mutation({
  args: t.object({ id: t.ref("contacts") }),
  result: t.nullable(t.text()),
  errors: ["not_found", "not_owner"],
  handler: async (ctx, { id }) => {
    assertOwner(await ctx.tables.contacts.get(id), ctx.viewer);
    await ctx.tables.contacts.delete(id);
    return null;
  }
});

const problem = t.object({
  line: t.integer(),
  email: t.text(),
  outcome: t.enum(["rejected", "skipped"]),
  reason: t.text()
});

/**
 * Imports contacts from CSV text with a header row naming first_name, last_name, email and
 * company (title and phone optional). Rows with an invalid email or no company are rejected;
 * rows whose email is already saved or appeared earlier in the file are skipped. Companies named
 * in accepted rows are created when missing. Everything created is owned by the importer, and the
 * whole import is one transaction.
 */
export const importCsv = mutation({
  args: t.object({ csv: t.text() }),
  result: t.object({
    added: t.integer(),
    companiesCreated: t.array(t.text()),
    problems: t.array(problem)
  }),
  errors: ["bad_header", "too_many_rows"],
  handler: async (ctx, { csv }) => {
    const [header, ...records] = parseCsv(csv.replace(/^﻿/, ""));
    const columns = (header?.fields ?? []).map((name) => name.trim().toLowerCase());
    const at = (name: string) => columns.indexOf(name);
    const missing = ["first_name", "last_name", "email", "company"].filter((name) => at(name) < 0);
    if (missing.length > 0) throw new HandlerError("bad_header", { missing });
    if (records.length > 1000) throw new HandlerError("too_many_rows", { max: 1000 });

    const { id: ownerId, name: ownerName } = ctx.viewer.user;
    const saved = await all((cursor) =>
      ctx.tables.contacts.list({ limit: 1000, ...(cursor ? { cursor } : {}) })
    );
    const seen = new Map(saved.map((row) => [row.email, "already saved"]));
    const companies = await all((cursor) =>
      ctx.tables.companies.list({ limit: 1000, ...(cursor ? { cursor } : {}) })
    );
    const companyIds = new Map(companies.map((row) => [row.nameKey, row.id]));

    const problems: {
      line: number;
      email: string;
      outcome: "rejected" | "skipped";
      reason: string;
    }[] = [];
    const accepted: { line: number; fields: string[]; email: string; companyName: string }[] = [];
    for (const { line, fields } of records) {
      const value = (name: string) => (fields[at(name)] ?? "").trim();
      const rawEmail = value("email");
      const email = normalizeEmail(rawEmail);
      const companyName = value("company").replace(/\s+/g, " ");
      if (!isValidEmail(email))
        problems.push({
          line,
          email: rawEmail,
          outcome: "rejected",
          reason: rawEmail === "" ? "No email" : "Invalid email"
        });
      else if (companyName === "")
        problems.push({ line, email: rawEmail, outcome: "rejected", reason: "No company" });
      else if (seen.has(email))
        problems.push({
          line,
          email: rawEmail,
          outcome: "skipped",
          reason: `Duplicate email (${seen.get(email)})`
        });
      else {
        seen.set(email, `same as line ${line}`);
        accepted.push({ line, fields, email, companyName });
      }
    }

    const newCompanies = new Map<string, string>();
    for (const { companyName } of accepted) {
      const key = companyKey(companyName);
      if (!companyIds.has(key) && !newCompanies.has(key)) newCompanies.set(key, companyName);
    }
    const created = await ctx.tables.companies.insertMany(
      [...newCompanies].map(([nameKey, name]) => ({ name, nameKey, ownerId, ownerName }))
    );
    for (const company of created) companyIds.set(company.nameKey, company.id);

    const optional = (fields: string[], name: string) =>
      at(name) >= 0 && fields[at(name)]?.trim() ? fields[at(name)]!.trim() : null;
    const inserted = await ctx.tables.contacts.insertMany(
      accepted.map(({ fields, email, companyName }) => ({
        firstName: (fields[at("first_name")] ?? "").trim(),
        lastName: (fields[at("last_name")] ?? "").trim(),
        email,
        companyId: companyIds.get(companyKey(companyName))!,
        title: optional(fields, "title"),
        phone: optional(fields, "phone"),
        ownerId,
        ownerName
      }))
    );
    ctx.log("imported contacts", {
      added: inserted.length,
      problems: problems.length,
      by: ctx.viewer.user.email
    });
    return {
      added: inserted.length,
      companiesCreated: created.map((company) => company.name),
      problems
    };
  }
});
