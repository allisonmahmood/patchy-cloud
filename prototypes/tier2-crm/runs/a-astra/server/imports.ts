import type { Insert } from "patchy/config";
import type config from "../patchy.config.js";
import { HandlerError, isHandlerError, mutation, t } from "../patchy/_generated/server.js";
import { CsvError, parseContactsCsv } from "../lib/csv.js";
import { emailAddress } from "../lib/records.js";
import type { Company } from "../lib/models.js";

export const importCsv = mutation({
  args: t.object({ csv: t.text() }),
  result: t.object({
    added: t.integer(),
    companiesCreated: t.integer(),
    issues: t.array(
      t.object({
        row: t.integer(),
        email: t.text(),
        reason: t.text(),
        status: t.enum(["rejected", "skipped"])
      })
    )
  }),
  errors: ["csv_too_large", "invalid_csv", "invalid_csv_header"],
  handler: async (ctx, { csv }) => {
    let rows;
    try {
      rows = parseContactsCsv(csv);
    } catch (error) {
      if (error instanceof CsvError) {
        throw new HandlerError(error.code, { row: error.row, message: error.message });
      }
      throw error;
    }

    const issues: { row: number; email: string; reason: string; status: "rejected" | "skipped" }[] =
      [];
    const emails = new Set<string>();
    const companyIds = new Map<string, Company["id"]>();
    const contacts: Insert<typeof config, "contacts">[] = [];
    let companiesCreated = 0;
    const ownerId = ctx.viewer.user.id;

    for (const row of rows) {
      let email: string;
      try {
        email = emailAddress(row.email);
      } catch (error) {
        if (!isHandlerError(error, "invalid_email")) throw error;
        issues.push({
          row: row.row,
          email: row.email,
          reason: "Invalid email address",
          status: "rejected"
        });
        continue;
      }
      if (!row.company) {
        issues.push({ row: row.row, email, reason: "Company is required", status: "rejected" });
        continue;
      }
      if (emails.has(email)) {
        issues.push({
          row: row.row,
          email,
          reason: "Duplicate email earlier in this file",
          status: "skipped"
        });
        continue;
      }
      const existingContact = await ctx.tables.contacts.list({
        index: "byEmail",
        eq: { email },
        limit: 1
      });
      if (existingContact.rows.length) {
        issues.push({ row: row.row, email, reason: "Email already exists", status: "skipped" });
        continue;
      }

      const nameKey = row.company.toLowerCase();
      let companyId = companyIds.get(nameKey);
      if (!companyId) {
        const existingCompany = await ctx.tables.companies.list({
          index: "byName",
          eq: { nameKey },
          limit: 1
        });
        const company =
          existingCompany.rows[0] ??
          (await ctx.tables.companies.insert({
            name: row.company,
            nameKey,
            ownerId
          }));
        if (!existingCompany.rows.length) companiesCreated++;
        companyId = company.id;
        companyIds.set(nameKey, companyId);
      }
      contacts.push({
        firstName: row.firstName,
        lastName: row.lastName,
        email,
        companyId,
        title: row.title,
        phone: row.phone,
        ownerId
      });
      emails.add(email);
    }

    if (contacts.length) await ctx.tables.contacts.insertMany(contacts);
    return { added: contacts.length, companiesCreated, issues };
  }
});
