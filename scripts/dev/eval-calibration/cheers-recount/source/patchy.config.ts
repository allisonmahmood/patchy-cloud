import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "launch-cheers",
  tier: 1,
  tables: {
    cheers: table("One row per cheer: each press of the button adds one. The total count of rows is the number of cheers.", {
      note: t.text().default("")
    })
  },
  files: {},
  uses: {}
});
