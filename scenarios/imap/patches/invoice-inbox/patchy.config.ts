import { defineConfig } from "patchy/config";

export default defineConfig({
  name: "invoice-inbox",
  tier: 2,
  tables: {},
  files: {},
  uses: { mail: { kind: "imap", handle: "invoices" } }
});
