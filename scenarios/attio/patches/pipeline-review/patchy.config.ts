import { defineConfig } from "patchy/config";

export default defineConfig({
  name: "pipeline-review",
  tier: 2,
  tables: {},
  files: {},
  uses: { crm: { kind: "attio", handle: "crm" } }
});
