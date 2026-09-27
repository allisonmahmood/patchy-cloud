-- Agent-authored fixture. Write INSERT statements using the quoted names below.
-- Views are synthetic tables in local development; populate their output columns.
-- Domains use their resolved source base types. No production rows are fetched.
-- "\"public\".\"invoices\"" (table)
--   "\"invoice_number\"": "\"pg_catalog\".\"text\"" required
--   "\"company_name\"": "\"pg_catalog\".\"text\"" required
--   "\"issued_on\"": "\"pg_catalog\".\"date\"" required
--   "\"due_on\"": "\"pg_catalog\".\"date\"" required
--   "\"amount_cents\"": "\"pg_catalog\".\"int4\"" required
-- "\"public\".\"payments\"" (table)
--   "\"id\"": "\"pg_catalog\".\"int4\"" required
--   "\"invoice_number\"": "\"pg_catalog\".\"text\"" required
--   "\"paid_on\"": "\"pg_catalog\".\"date\"" required
--   "\"amount_cents\"": "\"pg_catalog\".\"int4\"" required

-- Invented USD-cent ledger. Acme's first invoice has two payments.
-- Expected totals: Acme 375000 invoiced / 175000 paid / 200000 outstanding;
-- Blue Harbor 180000 / 180000 / 0; Cedar Works 9900 / 0 / 9900.
-- Any CRM company not named here should appear with three zero totals.
INSERT INTO "public"."invoices" ("invoice_number", "company_name", "issued_on", "due_on", "amount_cents") VALUES
  ('LOCAL-ACME-001', 'Acme Robotics', '2026-09-01', '2026-10-01', 250000),
  ('LOCAL-ACME-002', 'Acme Robotics', '2026-09-10', '2026-10-10', 125000),
  ('LOCAL-BLUE-001', 'Blue Harbor Foods', '2026-09-02', '2026-10-02', 180000),
  ('LOCAL-CEDAR-001', 'Cedar Works', '2026-09-03', '2026-10-03', 9900);

INSERT INTO "public"."payments" ("id", "invoice_number", "paid_on", "amount_cents") VALUES
  (1, 'LOCAL-ACME-001', '2026-09-05', 100000),
  (2, 'LOCAL-ACME-001', '2026-09-12', 75000),
  (3, 'LOCAL-BLUE-001', '2026-09-15', 180000);
