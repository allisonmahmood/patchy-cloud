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

-- Invented local ledger rows.
INSERT INTO "public"."invoices" ("invoice_number", "company_name", "issued_on", "due_on", "amount_cents") VALUES
  ('INV-1001', 'Acme Robotics', '2026-06-01', '2026-07-01', 1250000),
  ('INV-1002', 'Acme Robotics', '2026-07-01', '2026-08-01', 480000),
  ('INV-1003', 'Blue Harbor Foods', '2026-06-15', '2026-07-15', 920050),
  ('INV-1004', 'Cobalt Freight', '2026-07-10', '2026-08-10', 310000),
  ('INV-1005', 'Driftwood Studio', '2026-08-01', '2026-09-01', 75000),
  ('INV-1006', 'Fjord Analytics', '2026-08-20', '2026-09-20', 2100000);

INSERT INTO "public"."payments" ("id", "invoice_number", "paid_on", "amount_cents") VALUES
  (1, 'INV-1001', '2026-06-28', 1250000),
  (2, 'INV-1002', '2026-08-03', 200000),
  (3, 'INV-1003', '2026-07-10', 920050),
  (4, 'INV-1004', '2026-08-15', 100000),
  (5, 'INV-1004', '2026-09-01', 50000);
