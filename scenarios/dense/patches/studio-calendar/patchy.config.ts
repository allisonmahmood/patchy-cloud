import { defineConfig, table, t } from "patchy/config";

// The starter's notes, under the patch's own name.
export default defineConfig({
  name: "studio-calendar",
  tier: 2,
  tables: { notes: table("One note per id, with a title.", { title: t.text() }) },
  files: {},
  uses: {}
});
