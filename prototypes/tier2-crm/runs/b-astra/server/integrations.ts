import { action, query, t, HandlerError } from "../patchy/_generated/server.js";
import type { FileHandle } from "../patchy/_generated/server.js";

export interface ContractFile {
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  readonly handle: FileHandle;
}

export interface CompanyContract {
  readonly companyId: string;
  readonly companyName: string;
  readonly slug: string;
  readonly pdf: ContractFile | null;
  readonly thumbnail: ContractFile | null;
}

export interface FinanceReportRequest {
  readonly phase?: "finance" | "crm";
  readonly cursor?: string;
}

export interface FinanceReportPage {
  readonly rows: readonly FinanceRow[];
  readonly nextPage: { readonly phase: "finance" | "crm"; readonly cursor: string } | null;
}

const contractFile = t.object({
  name: t.text(),
  size: t.number(),
  contentType: t.text(),
  handle: t.fileHandle()
});

export const contractsForCompany = query({
  args: t.object({ companyId: t.ref("companies") }),
  result: t.object({
    companyId: t.text(),
    companyName: t.text(),
    slug: t.text(),
    pdf: t.nullable(contractFile),
    thumbnail: t.nullable(contractFile)
  }),
  errors: ["company_not_found"],
  handler: async (ctx, { companyId }): Promise<CompanyContract> => {
    const company = await ctx.tables.companies.get(companyId);
    if (!company) throw new HandlerError("company_not_found");
    const slug = company.name.trim().toLowerCase().replace(/\s+/g, "-");
    const [pdf, thumbnail] = await Promise.all([
      ctx.shared.contracts.stat(`${slug}.pdf`),
      ctx.shared.contracts.stat(`${slug}.png`)
    ]);
    const entry = (file: typeof pdf) =>
      file === null
        ? null
        : {
            name: file.name,
            size: file.size,
            contentType: file.contentType,
            handle: file.handle
          };
    return {
      companyId: company.id,
      companyName: company.name,
      slug,
      pdf: entry(pdf),
      thumbnail: entry(thumbnail)
    };
  }
});

const pageSize = 100;
const financeColumns = {
  companyKey: t.text(),
  companyName: t.text(),
  invoicedCents: t.text(),
  paidCents: t.text(),
  outstandingCents: t.text()
};
const nextFinancePage = t.object({
  phase: t.enum(["finance", "crm"]),
  cursor: t.text()
});
export interface FinanceRow {
  readonly companyKey: string;
  readonly companyName: string;
  readonly invoicedCents: string;
  readonly paidCents: string;
  readonly outstandingCents: string;
  readonly source: "finance" | "crm";
}

export const financeReport = action({
  args: t.object({
    phase: t.enum(["finance", "crm"]).optional(),
    cursor: t.text().optional()
  }),
  result: t.object({
    rows: t.array(t.object({ ...financeColumns, source: t.enum(["finance", "crm"]) })),
    nextPage: t.nullable(nextFinancePage)
  }),
  handler: async (ctx, { phase, cursor }): Promise<FinanceReportPage> => {
    const rows: FinanceRow[] = [];
    if (phase !== "crm") {
      // Aggregate each ledger independently: two payments must not count an invoice twice.
      const ledger = await ctx.connections.finance.query(
        `WITH invoice_totals AS (
          SELECT lower(btrim("company_name")) AS company_key,
                 min("company_name") AS company_name,
                 sum("amount_cents"::bigint) AS invoiced_cents
          FROM "public"."invoices"
          GROUP BY lower(btrim("company_name"))
        ), payment_totals AS (
          SELECT lower(btrim(i."company_name")) AS company_key,
                 sum(p."amount_cents"::bigint) AS paid_cents
          FROM "public"."payments" p
          JOIN "public"."invoices" i ON i."invoice_number" = p."invoice_number"
          GROUP BY lower(btrim(i."company_name"))
        )
        SELECT i.company_key AS "companyKey", i.company_name AS "companyName",
               i.invoiced_cents::text AS "invoicedCents",
               coalesce(p.paid_cents, 0)::text AS "paidCents",
               (i.invoiced_cents - coalesce(p.paid_cents, 0))::text AS "outstandingCents"
        FROM invoice_totals i
        LEFT JOIN payment_totals p ON p.company_key = i.company_key
        WHERE $1::text IS NULL OR i.company_key COLLATE "C" > $1::text COLLATE "C"
        ORDER BY i.company_key COLLATE "C"
        LIMIT $2`,
        [cursor ?? null, pageSize + 1],
        financeColumns
      );
      for (const row of ledger.rows.slice(0, pageSize)) rows.push({ ...row, source: "finance" });
      if (ledger.rows.length > pageSize) {
        return {
          rows,
          nextPage: { phase: "finance" as const, cursor: rows[rows.length - 1]!.companyKey }
        };
      }
    }

    // Once ledger pages finish, include CRM companies with no invoice at all.
    const companies = await ctx.tables.companies.list({
      index: "byName",
      order: "asc",
      limit: pageSize,
      ...(phase === "crm" && cursor ? { cursor } : {})
    });
    const invoicedKeys = new Set<string>();
    if (companies.rows.length > 0) {
      const matching = await ctx.connections.finance.query(
        `SELECT DISTINCT lower(btrim("company_name")) AS "companyKey"
         FROM "public"."invoices"
         WHERE lower(btrim("company_name")) = ANY($1::text[])`,
        [companies.rows.map((company) => company.nameKey)],
        { companyKey: t.text() }
      );
      for (const company of matching.rows) invoicedKeys.add(company.companyKey);
    }
    for (const company of companies.rows) {
      if (!invoicedKeys.has(company.nameKey))
        rows.push({
          companyKey: company.nameKey,
          companyName: company.name,
          invoicedCents: "0",
          paidCents: "0",
          outstandingCents: "0",
          source: "crm"
        });
    }
    return {
      rows,
      nextPage:
        companies.cursor === null ? null : { phase: "crm" as const, cursor: companies.cursor }
    };
  }
});
