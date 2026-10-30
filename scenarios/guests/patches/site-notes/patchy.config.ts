import { defineConfig, table, t } from "patchy/config";

// Tier 1: everyone who opens the page, a guest too, reads and writes its notes directly.
export default defineConfig({
  name: "site-notes",
  tier: 1,
  tables: { notes: table("One note about the site per id, with a title.", { title: t.text() }) },
  files: {},
  uses: {}
});
