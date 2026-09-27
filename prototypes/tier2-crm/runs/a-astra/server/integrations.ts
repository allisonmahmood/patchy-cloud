import { action, query, t, HandlerError } from "../patchy/_generated/server.js";

const contractFile = t.object({
  name: t.text(),
  handle: t.fileHandle()
});

export const companyContracts = query({
  args: t.object({ companyId: t.ref("companies") }),
  result: t.object({
    pdf: t.nullable(contractFile),
    thumbnail: t.nullable(contractFile)
  }),
  errors: ["company_not_found"],
  handler: async (ctx, { companyId }) => {
    const company = await ctx.tables.companies.get(companyId);
    if (!company) throw new HandlerError("company_not_found");
    const slug = company.name.trim().toLowerCase().replace(/\s+/g, "-");
    const [pdf, thumbnail] = await Promise.all([
      ctx.shared.contracts.stat(`${slug}.pdf`),
      ctx.shared.contracts.stat(`${slug}.png`)
    ]);
    return {
      pdf: pdf ? { name: pdf.name, handle: pdf.handle } : null,
      thumbnail: thumbnail ? { name: thumbnail.name, handle: thumbnail.handle } : null
    };
  }
});

export const financeReport = action({
  args: t.object({ cursor: t.text().optional() }),
  result: t.object({
    rows: t.array(
      t.object({
        companyId: t.ref("companies"),
        companyName: t.text(),
        invoicedCents: t.text(),
        paidCents: t.text(),
        outstandingCents: t.text()
      })
    ),
    cursor: t.nullable(t.text())
  }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.tables.companies.list({
      limit: 25,
      order: "asc",
      ...(cursor ? { cursor } : {})
    });
    if (page.rows.length === 0) return { rows: [], cursor: page.cursor };

    // Aggregate payments to one row per invoice before summing invoice amounts.
    // Numeric arithmetic and text results preserve cents beyond JS safe integers.
    const totals = await ctx.connections.finance.query(
      `WITH selected_invoices AS (
        SELECT "invoice_number", lower(btrim("company_name")) AS "company_key", "amount_cents"
        FROM "public"."invoices"
        WHERE lower(btrim("company_name")) = ANY($1::text[])
      ), invoice_payments AS (
        SELECT p."invoice_number", sum(p."amount_cents"::numeric) AS "paid_cents"
        FROM "public"."payments" p
        INNER JOIN selected_invoices i ON i."invoice_number" = p."invoice_number"
        GROUP BY p."invoice_number"
      )
      SELECT i."company_key",
        sum(i."amount_cents"::numeric)::text AS "invoiced_cents",
        sum(coalesce(p."paid_cents", 0::numeric))::text AS "paid_cents",
        (sum(i."amount_cents"::numeric) - sum(coalesce(p."paid_cents", 0::numeric)))::text AS "outstanding_cents"
      FROM selected_invoices i
      LEFT JOIN invoice_payments p ON p."invoice_number" = i."invoice_number"
      GROUP BY i."company_key"`,
      [page.rows.map((company) => company.nameKey)],
      {
        company_key: t.text(),
        invoiced_cents: t.text(),
        paid_cents: t.text(),
        outstanding_cents: t.text()
      }
    );
    const byCompany = new Map(totals.rows.map((row) => [row.company_key, row]));
    return {
      rows: page.rows.map((company) => {
        const total = byCompany.get(company.nameKey);
        return {
          companyId: company.id,
          companyName: company.name,
          invoicedCents: total?.invoiced_cents ?? "0",
          paidCents: total?.paid_cents ?? "0",
          outstandingCents: total?.outstanding_cents ?? "0"
        };
      }),
      cursor: page.cursor
    };
  }
});
