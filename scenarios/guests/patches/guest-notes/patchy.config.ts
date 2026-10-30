import { defineConfig, table, t } from "patchy/config";

export default defineConfig({
  name: "guest-notes",
  tier: 1,
  tables: {
    notes: table("Notes written by everyone with access to this patch.", { title: t.text() })
  },
  files: {},
  uses: {}
});
