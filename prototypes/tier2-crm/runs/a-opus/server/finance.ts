import { action, t } from "../patchy/_generated/server.js";
import { keyOf } from "../lib/rules.js";

/**
 * Per-company invoiced, paid and outstanding totals (US cents) from the finance ledger, with the
 * matching CRM company when names agree. An action: company Postgres cannot drive a subscription.
 */
export const report = action({
  args: t.object({}),
  result: t.array(
    t.object({
      company: t.text(),
      companyId: t.nullable(t.text()),
      invoiced: t.number(),
      paid: t.number(),
      outstanding: t.number()
    })
  ),
  handler: async (ctx) => {
    const [{ rows }, companies] = await Promise.all([
      ctx.connections.finance.query(
        `SELECT i."company_name" AS "company",
                sum(i."amount_cents")::float8 AS "invoiced",
                coalesce(sum(p."paid"), 0)::float8 AS "paid"
           FROM "public"."invoices" i
           LEFT JOIN (SELECT "invoice_number", sum("amount_cents") AS "paid"
                        FROM "public"."payments" GROUP BY "invoice_number") p
             ON p."invoice_number" = i."invoice_number"
          GROUP BY i."company_name"
          ORDER BY i."company_name"`,
        [],
        { company: t.text(), invoiced: t.number(), paid: t.number() }
      ),
      ctx.tables.companies.list({ limit: 1000 })
    ]);
    const ids = new Map(companies.rows.map((company) => [company.nameKey, company.id]));
    return rows.map((row) => ({
      ...row,
      companyId: ids.get(keyOf(row.company)) ?? null,
      outstanding: row.invoiced - row.paid
    }));
  }
});
