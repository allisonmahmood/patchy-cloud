import { defineConfig, table, t } from "patchy/config";

// The starter's notes, under the patch's own name, declaring attio/crm.
export default defineConfig({
  name: "pitch-library",
  tier: 2,
  tables: { notes: table("One note per id, with a title.", { title: t.text() }) },
  files: {},
  uses: { crm: { kind: "attio", handle: "crm" } }
});
