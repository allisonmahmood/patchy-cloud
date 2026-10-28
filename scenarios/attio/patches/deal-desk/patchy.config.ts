import { defineConfig } from "patchy/config";

export default defineConfig({
  name: "deal-desk",
  tier: 1,
  tables: {},
  files: {},
  uses: { crm: { kind: "attio", handle: "crm" } }
});
