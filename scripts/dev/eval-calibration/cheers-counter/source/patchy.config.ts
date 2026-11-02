import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "launch-cheers",
  tier: 2,
  tables: { counter: table("The launch cheer total; key identifies the single shared counter and count is the number of cheers.", { key: t.text(), count: t.integer() }, { indexes: { byKey: { columns: ["key"], unique: true } } }) },
  files: {},
  uses: {}
});
