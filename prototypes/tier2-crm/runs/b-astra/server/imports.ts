import { mutation, query, t, HandlerError } from "../patchy/_generated/server.js";
import type { Id } from "patchy/config";
import { CsvError, parseContactsCsv } from "../lib/csv.js";
import type { ContactCsvRow } from "../lib/csv.js";

type Issue = { row: number; email: string; status: "rejected" | "skipped"; reason: string };
export type ContactImportResult = {
  readonly added: number;
  readonly companiesCreated: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly total: number;
  readonly issues: readonly Issue[];
};
export type ImportReconciliation = { readonly saved: number; readonly missing: number };
type Candidate = ContactCsvRow & { companyKey: string };
type ContactReader = {
  list(options: {
    index: "byEmail";
    eq: { email: string };
    limit: number;
  }): Promise<{ rows: readonly { email: string }[] }>;
};

function validEmail(email: string): boolean {
  if (email.length > 254) return false;
  const parts = email.split("@");
  if (parts.length !== 2 || parts[0].length > 64) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(parts[0]))
    return false;
  const domain = parts[1].split(".");
  return (
    domain.length >= 2 &&
    domain.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  );
}

function prepare(csv: string): { candidates: Candidate[]; issues: Issue[]; total: number } {
  let rows: ContactCsvRow[];
  try {
    rows = parseContactsCsv(csv);
  } catch (cause) {
    if (cause instanceof CsvError)
      throw new HandlerError("invalid_csv", { message: cause.message });
    throw cause;
  }

  const candidates: Candidate[] = [];
  const issues: Issue[] = [];
  const seen = new Map<string, number>();
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    const company = row.company.trim();
    const reasons: string[] = [];
    if (!validEmail(email)) reasons.push("Invalid email address");
    if (!company) reasons.push("Company is required");
    if (reasons.length > 0) {
      issues.push({ row: row.row, email, status: "rejected", reason: reasons.join("; ") });
      continue;
    }
    const earlier = seen.get(email);
    if (earlier !== undefined) {
      issues.push({
        row: row.row,
        email,
        status: "skipped",
        reason: `Duplicate email from CSV row ${earlier}`
      });
      continue;
    }
    seen.set(email, row.row);
    candidates.push({
      row: row.row,
      firstName: row.firstName.trim(),
      lastName: row.lastName.trim(),
      email,
      company,
      companyKey: company.toLowerCase(),
      title: row.title.trim(),
      phone: row.phone.trim()
    });
  }
  return { candidates, issues, total: rows.length };
}

async function savedEmails(
  table: ContactReader,
  candidates: readonly Candidate[]
): Promise<Set<string>> {
  const saved = new Set<string>();
  for (let offset = 0; offset < candidates.length; offset += 16) {
    const pages = await Promise.all(
      candidates
        .slice(offset, offset + 16)
        .map(({ email }) => table.list({ index: "byEmail", eq: { email }, limit: 1 }))
    );
    for (const page of pages) {
      if (page.rows[0]) saved.add(page.rows[0].email);
    }
  }
  return saved;
}

export const contacts = mutation({
  args: t.object({ csv: t.text() }),
  result: t.object({
    added: t.integer(),
    companiesCreated: t.integer(),
    rejected: t.integer(),
    skipped: t.integer(),
    total: t.integer(),
    issues: t.array(
      t.object({
        row: t.integer(),
        email: t.text(),
        status: t.enum(["rejected", "skipped"]),
        reason: t.text()
      })
    )
  }),
  errors: ["invalid_csv"],
  handler: async (ctx, { csv }): Promise<ContactImportResult> => {
    const { candidates, issues, total } = prepare(csv);
    const saved = await savedEmails(ctx.tables.contacts, candidates);
    const accepted = candidates.filter(({ row, email }) => {
      if (!saved.has(email)) return true;
      issues.push({
        row,
        email,
        status: "skipped",
        reason: "Email already exists in saved contacts"
      });
      return false;
    });

    const companyNames = new Map<string, string>();
    for (const row of accepted) {
      if (!companyNames.has(row.companyKey)) companyNames.set(row.companyKey, row.company);
    }
    const companyIds = new Map<string, Id<"companies">>();
    const missing: { name: string; nameKey: string; ownerId: string }[] = [];
    const names = [...companyNames];
    for (let offset = 0; offset < names.length; offset += 16) {
      const batch = names.slice(offset, offset + 16);
      const pages = await Promise.all(
        batch.map(([nameKey]) =>
          ctx.tables.companies.list({ index: "byName", eq: { nameKey }, limit: 1 })
        )
      );
      for (let index = 0; index < batch.length; index++) {
        const [nameKey, name] = batch[index];
        const company = pages[index].rows[0];
        if (company) companyIds.set(nameKey, company.id);
        else missing.push({ name, nameKey, ownerId: ctx.viewer.user.id });
      }
    }

    if (missing.length > 0) {
      const created = await ctx.tables.companies.insertMany(missing);
      for (const company of created) companyIds.set(company.nameKey, company.id);
    }
    if (accepted.length > 0) {
      await ctx.tables.contacts.insertMany(
        accepted.map((row) => ({
          firstName: row.firstName,
          lastName: row.lastName,
          email: row.email,
          companyId: companyIds.get(row.companyKey)!,
          title: row.title,
          phone: row.phone,
          ownerId: ctx.viewer.user.id
        }))
      );
    }

    issues.sort((a, b) => a.row - b.row);
    return {
      added: accepted.length,
      companiesCreated: missing.length,
      rejected: issues.filter((issue) => issue.status === "rejected").length,
      skipped: issues.filter((issue) => issue.status === "skipped").length,
      total,
      issues
    };
  }
});

/** A lost reply must be reconciled by reading before a person chooses to retry. */
export const check = query({
  args: t.object({ csv: t.text() }),
  result: t.object({ saved: t.integer(), missing: t.integer() }),
  errors: ["invalid_csv"],
  handler: async (ctx, { csv }): Promise<ImportReconciliation> => {
    const { candidates } = prepare(csv);
    const saved = await savedEmails(ctx.tables.contacts, candidates);
    return { saved: saved.size, missing: candidates.length - saved.size };
  }
});
