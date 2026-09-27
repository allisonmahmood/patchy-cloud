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

-- Synthetic amounts in USD cents. ACME-001 deliberately has two partial payments.
INSERT INTO "public"."invoices"
  ("invoice_number", "company_name", "issued_on", "due_on", "amount_cents")
VALUES
  ('SYN-ACME-001', 'Acme Robotics', '2026-07-01', '2026-07-31', 1250000),
  ('SYN-ACME-002', 'Acme Robotics', '2026-08-01', '2026-08-31', 250000),
  ('SYN-BLUE-001', 'Blue Harbor Foods', '2026-07-15', '2026-08-14', 840000),
  ('SYN-BLUE-002', 'Blue Harbor Foods', '2026-08-15', '2026-09-14', 160000);

INSERT INTO "public"."payments"
  ("id", "invoice_number", "paid_on", "amount_cents")
VALUES
  (1001, 'SYN-ACME-001', '2026-07-12', 300000),
  (1002, 'SYN-ACME-001', '2026-07-25', 450000),
  (1003, 'SYN-BLUE-001', '2026-08-02', 840000),
  (1004, 'SYN-BLUE-002', '2026-08-30', 40000);

-- Acme: invoiced 1500000, paid 750000, outstanding 750000; ACME-002 is unpaid.
-- Blue Harbor: invoiced 1000000, paid 880000, outstanding 120000.
