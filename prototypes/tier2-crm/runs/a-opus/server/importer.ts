import { mutation, t, HandlerError } from "../patchy/_generated/server.js";
import type { Id } from "patchy/config";
import { parseCsv } from "../lib/csv.js";
import { keyOf, isEmail } from "../lib/rules.js";

const MAX_ROWS = 1000;
const COLUMNS = ["first_name", "last_name", "email", "company", "title", "phone"] as const;

/**
 * Imports contacts from CSV text with a header row (first_name,last_name,email,company,title,phone).
 * Rejects rows with an invalid email or no company, skips emails already saved or earlier in the file,
 * creates missing companies, and makes the viewer the owner of everything it creates. All or nothing.
 */
export const contacts = mutation({
  args: t.object({ csv: t.text() }),
  result: t.object({
    added: t.integer(),
    companiesCreated: t.integer(),
    problems: t.array(
      t.object({
        line: t.integer(),
        name: t.text(),
        email: t.text(),
        outcome: t.enum(["rejected", "skipped"]),
        reason: t.text()
      })
    )
  }),
  errors: ["missing_columns", "too_many_rows"],
  handler: async (ctx, { csv }) => {
    const [header = [], ...records] = parseCsv(csv.replace(/^﻿/, ""));
    const at = Object.fromEntries(
      COLUMNS.map((column) => [column, header.map(keyOf).indexOf(column)])
    ) as Record<(typeof COLUMNS)[number], number>;
    const missing = (["email", "company"] as const).filter((column) => at[column] < 0);
    if (missing.length > 0) throw new HandlerError("missing_columns", { missing });
    if (records.length > MAX_ROWS) throw new HandlerError("too_many_rows", { max: MAX_ROWS });

    const ownerId = ctx.viewer.user.id;
    const companyIds = new Map<string, Id<"companies">>();
    const seen = new Set<string>();
    const problems: {
      line: number;
      name: string;
      email: string;
      outcome: "rejected" | "skipped";
      reason: string;
    }[] = [];
    let added = 0;
    let companiesCreated = 0;

    for (const [index, record] of records.entries()) {
      const cell = (column: (typeof COLUMNS)[number]) =>
        at[column] < 0 ? "" : (record[at[column]] ?? "").trim();
      const line = index + 2; // 1-based, after the header
      const email = cell("email");
      const companyName = cell("company");
      const name = `${cell("first_name")} ${cell("last_name")}`.trim();
      const problem = (outcome: "rejected" | "skipped", reason: string) =>
        problems.push({ line, name, email, outcome, reason });

      if (!isEmail(email)) {
        problem("rejected", email === "" ? "No email" : "Invalid email");
        continue;
      }
      if (companyName === "") {
        problem("rejected", "No company");
        continue;
      }
      const emailKey = keyOf(email);
      if (seen.has(emailKey)) {
        problem("skipped", "Duplicate of an earlier row in this file");
        continue;
      }
      seen.add(emailKey);
      if (
        (await ctx.tables.contacts.list({ index: "byEmailKey", eq: { emailKey }, limit: 1 })).rows
          .length > 0
      ) {
        problem("skipped", "A contact with this email already exists");
        continue;
      }

      const nameKey = keyOf(companyName);
      let company = companyIds.get(nameKey);
      if (!company) {
        const [existing] = (
          await ctx.tables.companies.list({ index: "byNameKey", eq: { nameKey }, limit: 1 })
        ).rows;
        company =
          existing?.id ??
          (await ctx.tables.companies.insert({ name: companyName, nameKey, ownerId })).id;
        if (!existing) companiesCreated++;
        companyIds.set(nameKey, company);
      }
      await ctx.tables.contacts.insert({
        firstName: cell("first_name"),
        lastName: cell("last_name"),
        email,
        emailKey,
        company,
        title: cell("title") || null,
        phone: cell("phone") || null,
        ownerId
      });
      added++;
    }
    return { added, companiesCreated, problems };
  }
});
