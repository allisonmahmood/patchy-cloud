import { defineConfig, table, t } from "patchy/config";

// The starter's notes, under the patch's own name, and a logos table it shares with its company,
// which Pitch Library reads.
export default defineConfig({
  name: "brand-assets",
  tier: 2,
  tables: {
    notes: table("One note per id, with a title.", { title: t.text() }),
    logos: table(
      "One logo file per client and format: client is the client's name, format a file type such as svg.",
      { client: t.text(), format: t.text() },
      { shared: true }
    )
  },
  files: {},
  uses: {}
});
