import { action, t } from "../patchy/_generated/server.js";
import { companyKey } from "../shared/rules.js";

/**
 * Per company in the finance ledger: invoiced, paid and outstanding, in integer USD cents, with
 * the CRM company it matches by name when there is one. An action because company Postgres is
 * action-only; the page calls it again to refresh.
 */
export const report = action({
  args: t.object({}),
  result: t.array(
    t.object({
      company: t.text(),
      companyId: t.nullable(t.ref("companies")),
      invoiced: t.number(),
      paid: t.number(),
      outstanding: t.number()
    })
  ),
  handler: async (ctx) => {
    // Payments are summed per invoice first so an invoice with several payments is counted once.
    const { rows } = await ctx.connections.finance.query(
      `SELECT i."company_name" AS "company",
              sum(i."amount_cents")::float8 AS "invoiced",
              coalesce(sum(p."paid"), 0)::float8 AS "paid"
         FROM "public"."invoices" i
         LEFT JOIN (SELECT "invoice_number", sum("amount_cents") AS "paid" FROM "public"."payments" GROUP BY "invoice_number") p
           ON p."invoice_number" = i."invoice_number"
        GROUP BY i."company_name"
        ORDER BY i."company_name"`,
      [],
      { company: t.text(), invoiced: t.number(), paid: t.number() }
    );
    const { rows: companies } = await ctx.tables.companies.list({ limit: 1000 });
    const ids = new Map(companies.map((company) => [company.nameKey, company.id]));
    return rows.map((row) => ({
      ...row,
      companyId: ids.get(companyKey(row.company)) ?? null,
      outstanding: row.invoiced - row.paid
    }));
  }
});
