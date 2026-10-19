import { defineConfig } from "patchy/config";

export default defineConfig({
  name: "store-pulse",
  tier: 1,
  tables: {},
  files: {},
  uses: { store: { kind: "shopify", handle: "store" } }
});
