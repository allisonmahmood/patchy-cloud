import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "launch-cheers",
  tier: 1,
  tables: {
    counter: table("A single row holding the number of cheers.", {
      count: t.number().default(0)
    })
  },
  files: {},
  uses: {}
});
