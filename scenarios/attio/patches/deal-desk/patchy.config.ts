import { defineConfig } from "patchy/config";

export default defineConfig({
  name: "deal-desk",
  tier: 2,
  tables: {},
  files: {},
  uses: { crm: { kind: "attio", handle: "crm" } }
});
