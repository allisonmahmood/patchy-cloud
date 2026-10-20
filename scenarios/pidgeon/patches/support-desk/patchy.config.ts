import { defineConfig } from "patchy/config";

export default defineConfig({
  name: "support-desk",
  tier: 1,
  tables: {},
  files: {},
  uses: { support: { kind: "pidgeon", handle: "support" } }
});
