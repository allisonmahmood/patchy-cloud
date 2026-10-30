import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "visit-log",
  tier: 2,
  tables: {
    notes: table("One site visit per id: what happened, and by, the name of who logged it.", {
      title: t.text(),
      by: t.text()
    })
  },
  files: {},
  uses: {}
});
